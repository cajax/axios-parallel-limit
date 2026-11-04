/**
 * A generic, dependency-free concurrency limiter with a bounded queue and a
 * queue-wait deadline. This is the runtime-agnostic core that powers
 * `axiosParallelLimit` — it knows nothing about Axios (or HTTP at all). The host
 * supplies the request "context" type, the cancellation source, and the error
 * factories, so the same primitive can wrap anything.
 *
 * Semantics:
 *  - up to `maxConcurrency` tasks hold a slot at once;
 *  - extra tasks wait in a FIFO queue, optionally bounded by `maxQueueSize`
 *    (overflow rejects immediately) and/or a per-task `queueTimeout` (queue-wait
 *    only — never execution time);
 *  - a queued task can be removed early by its `Cancellation`;
 *  - `active`/`pending` counts and the dispatch/timeout/overflow callbacks fire
 *    exactly once per state transition, with leak-free timer/listener cleanup.
 */

const now = (): number => Date.now();

/** Payload handed to the dispatch / timeout / overflow callbacks. */
export interface BoundedLimiterEventInfo<T> {
    /** The task context (whatever the host passed to `acquire`). */
    context: T;
    /** Time (ms) the task spent waiting in the queue (0 for immediate / overflow). */
    waitMs: number;
    /** Number of tasks still waiting in the queue when the event fired. */
    queueSize: number;
}

/**
 * A cancellation source for a queued task, abstracted away from any concrete
 * implementation (`AbortSignal`, an Axios cancel token, etc.). The limiter calls
 * `subscribe` when it queues a task and the returned unsubscribe the instant the
 * task leaves the queue, so nothing fires for an already-settled task.
 */
export interface Cancellation {
    readonly aborted: boolean;
    /** Register `onAbort`; return a function that removes it. */
    subscribe(onAbort: () => void): () => void;
}

/** Per-`acquire` overrides. */
export interface AcquireOptions {
    /** Overrides the limiter-level `queueTimeout` for this task only. */
    queueTimeout?: number;
    /** Cancellation source; if it aborts while queued, the task is removed. */
    cancellation?: Cancellation;
    /**
     * Relative priority for queue ordering (higher numbers are dispatched first).
     * Tasks with the same priority are dispatched in FIFO order. Default: 0.
     */
    priority?: number;
}

/** Releases the held slot. Idempotent; pulls the next queued task. */
export type ReleaseFn = () => void;

export interface BoundedLimiterOptions<T> {
    /** Maximum number of tasks holding a slot simultaneously. */
    maxConcurrency: number;
    /** Hard cap on queue depth; further tasks overflow. Default: unbounded. */
    maxQueueSize?: number;
    /** Default max queue-wait (ms) before a queued task times out. Default: off. */
    queueTimeout?: number;

    onActiveCountChange?: (activeCount: number) => void;
    onPendingCountChange?: (pendingCount: number) => void;
    onDispatch?: (info: BoundedLimiterEventInfo<T>) => void;
    onQueueTimeout?: (info: BoundedLimiterEventInfo<T>) => void;
    onQueueOverflow?: (info: BoundedLimiterEventInfo<T>) => void;

    /** Builds the rejection for a queue-wait timeout. */
    createTimeoutError: (context: T) => unknown;
    /** Builds the rejection for a queue overflow. */
    createOverflowError: (context: T) => unknown;
    /** Builds the rejection for a cancellation while queued. */
    createAbortError: (context: T) => unknown;
}

interface QueueItem<T> {
    context: T;
    priority: number;
    enqueuedAt: number;
    timer?: ReturnType<typeof setTimeout>;
    detachAbort?: () => void;
    /**
     * `true` once the task has left the queue via ANY path (dispatch, timeout,
     * cancel). Guarantees exactly-once settlement: the race winner flips it and
     * the loser becomes a no-op.
     */
    settled: boolean;
    resolve: (release: ReleaseFn) => void;
    reject: (err: unknown) => void;
}

export class BoundedLimiter<T> {
    private readonly queue: QueueItem<T>[] = [];
    private active = 0;

    constructor(private readonly options: BoundedLimiterOptions<T>) {
        if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency < 1) {
            throw new RangeError(
                `maxConcurrency must be a positive number >= 1, received: ${options.maxConcurrency}`,
            );
        }
        if (options.maxQueueSize !== undefined && (!Number.isFinite(options.maxQueueSize) || options.maxQueueSize < 0)) {
            throw new RangeError(
                `maxQueueSize must be a non-negative number >= 0, received: ${options.maxQueueSize}`,
            );
        }
        if (options.queueTimeout !== undefined && (!Number.isFinite(options.queueTimeout) || options.queueTimeout < 0)) {
            throw new RangeError(
                `queueTimeout must be a non-negative number >= 0, received: ${options.queueTimeout}`,
            );
        }
    }

    /** Tasks currently holding a slot. */
    get activeCount(): number {
        return this.active;
    }

    /** Tasks currently waiting in the queue. */
    get pendingCount(): number {
        return this.queue.length;
    }

    /**
     * Acquire a slot. Resolves with a `release()` once a slot is held; rejects
     * (without ever consuming a slot) on overflow, queue-wait timeout, or
     * cancellation while queued.
     */
    acquire(context: T, opts: AcquireOptions = {}): Promise<ReleaseFn> {
        // 1) Slot free → admit immediately (never subject to queueTimeout).
        if (this.active < this.options.maxConcurrency) {
            this.active++;
            this.notifyActive();
            this.emit(this.options.onDispatch, context, 0);
            return Promise.resolve(this.makeRelease());
        }

        const { cancellation } = opts;

        // 2) Already cancelled before we could queue it → don't enqueue.
        if (cancellation && cancellation.aborted) {
            return Promise.reject(this.options.createAbortError(context));
        }

        // 3) Queue full → reject BEFORE enqueuing (pending unchanged, no count callback).
        const { maxQueueSize } = this.options;
        if (maxQueueSize !== undefined && this.queue.length >= maxQueueSize) {
            this.emit(this.options.onQueueOverflow, context, 0);
            return Promise.reject(this.options.createOverflowError(context));
        }

        // 4) Defer: park in the queue until a slot frees (or it times out / is cancelled).
        return new Promise<ReleaseFn>((resolve, reject) => {
            const priority = typeof opts.priority === 'number' && Number.isFinite(opts.priority) ? opts.priority : 0;
            const item: QueueItem<T> = { context, priority, enqueuedAt: now(), settled: false, resolve, reject };

            const timeout = typeof opts.queueTimeout === 'number' ? opts.queueTimeout : this.options.queueTimeout;
            if (timeout !== undefined) {
                const timer = setTimeout(() => this.onTimeout(item), timeout);
                if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
                    timer.unref();
                }
                item.timer = timer;
            }
            if (cancellation) {
                item.detachAbort = cancellation.subscribe(() => this.onAbort(item));
            }

            this.insertQueueItem(item);
            this.notifyPending();
        });
    }

    /**
     * Inserts an item into the queue while preserving stable priority ordering.
     * Higher priority items precede lower ones. Equal priority items stay in FIFO order.
     */
    private insertQueueItem = (item: QueueItem<T>): void => {
        if (this.queue.length === 0 || item.priority <= this.queue[this.queue.length - 1].priority) {
            this.queue.push(item);
            return;
        }

        if (item.priority > this.queue[0].priority) {
            this.queue.unshift(item);
            return;
        }

        let low = 0;
        let high = this.queue.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.queue[mid].priority >= item.priority) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        this.queue.splice(low, 0, item);
    };

    private notifyActive = (): void => {
        this.options.onActiveCountChange?.(this.active);
    };

    private notifyPending = (): void => {
        this.options.onPendingCountChange?.(this.queue.length);
    };

    private emit = (
        cb: ((info: BoundedLimiterEventInfo<T>) => void) | undefined,
        context: T,
        waitMs: number,
    ): void => {
        cb?.({ context, waitMs, queueSize: this.queue.length });
    };

    /** Tear down a queued item's timer and cancellation listener. Idempotent. */
    private clearItem = (item: QueueItem<T>): void => {
        if (item.timer !== undefined) {
            clearTimeout(item.timer);
            item.timer = undefined;
        }
        if (item.detachAbort) {
            item.detachAbort();
            item.detachAbort = undefined;
        }
    };

    private removeFromQueue = (item: QueueItem<T>): boolean => {
        const index = this.queue.indexOf(item);
        if (index === -1) return false;
        this.queue.splice(index, 1);
        return true;
    };

    private makeRelease = (): ReleaseFn => {
        let released = false;
        return () => {
            if (released) return; // never decrement twice for one slot
            released = true;
            this.active--;
            this.notifyActive(); // active--
            this.pullNext();
        };
    };

    /** Promote the next queued task into a freed slot, if any. */
    private pullNext = (): void => {
        if (this.active >= this.options.maxConcurrency) return;
        const item = this.queue.shift();
        if (!item) return;

        // Won the slot: disable its timeout/cancel so neither can act later.
        item.settled = true;
        this.clearItem(item);

        this.notifyPending(); // pending--
        this.active++;
        this.notifyActive(); // active++
        this.emit(this.options.onDispatch, item.context, now() - item.enqueuedAt);

        item.resolve(this.makeRelease());
    };

    private onTimeout = (item: QueueItem<T>): void => {
        if (item.settled) return; // dispatch already won the race
        item.settled = true;
        this.clearItem(item);
        if (!this.removeFromQueue(item)) return;

        this.notifyPending(); // pending-- (active untouched — it never became in-flight)
        this.emit(this.options.onQueueTimeout, item.context, now() - item.enqueuedAt);
        item.reject(this.options.createTimeoutError(item.context));
    };

    private onAbort = (item: QueueItem<T>): void => {
        if (item.settled) return;
        item.settled = true;
        this.clearItem(item);
        if (!this.removeFromQueue(item)) return;

        this.notifyPending(); // pending-- (active untouched)
        item.reject(this.options.createAbortError(item.context));
    };
}
