import axios, {
    AxiosInstance,
    AxiosResponse,
    InternalAxiosRequestConfig,
    AxiosAdapter,
    CanceledError,
} from 'axios';

const QUEUE_TIMEOUT_CODE = 'ERR_QUEUE_TIMEOUT';
const QUEUE_FULL_CODE = 'ERR_QUEUE_FULL';

/**
 * Thrown when a request waits longer than `queueTimeout` for a free slot and is
 * removed from the queue without ever being dispatched.
 *
 * This is deliberately NOT an Axios error (`axios.isAxiosError` returns `false`).
 * Branch on the exported {@link isQueueTimeoutError} guard or the stable
 * `code === 'ERR_QUEUE_TIMEOUT'` discriminant instead.
 */
export class QueueTimeoutError extends Error {
    /** Stable, machine-checkable discriminant. */
    readonly code = QUEUE_TIMEOUT_CODE;
    /** The originating Axios request config, for debuggability. */
    readonly config: InternalAxiosRequestConfig;

    constructor(config: InternalAxiosRequestConfig, message?: string) {
        super(message ?? 'Request timed out while waiting in the queue for an available slot (queueTimeout)');
        this.name = 'QueueTimeoutError';
        this.config = config;
        // Keep `instanceof` working across down-levelled / bundled output.
        Object.setPrototypeOf(this, QueueTimeoutError.prototype);
    }
}

/**
 * Thrown when a request is rejected immediately because the queue already holds
 * `maxQueueSize` waiting requests (fail-fast back-pressure / load shedding).
 *
 * This is deliberately NOT an Axios error (`axios.isAxiosError` returns `false`).
 * Branch on the exported {@link isQueueFullError} guard or the stable
 * `code === 'ERR_QUEUE_FULL'` discriminant instead.
 */
export class QueueFullError extends Error {
    /** Stable, machine-checkable discriminant. */
    readonly code = QUEUE_FULL_CODE;
    /** The originating Axios request config, for debuggability. */
    readonly config: InternalAxiosRequestConfig;

    constructor(config: InternalAxiosRequestConfig, message?: string) {
        super(message ?? 'Request rejected because the queue is full (maxQueueSize reached)');
        this.name = 'QueueFullError';
        this.config = config;
        Object.setPrototypeOf(this, QueueFullError.prototype);
    }
}

/** Type guard distinguishing a {@link QueueTimeoutError} from network/HTTP/other errors. */
export function isQueueTimeoutError(err: unknown): err is QueueTimeoutError {
    return (
        err instanceof QueueTimeoutError ||
        (typeof err === 'object' &&
            err !== null &&
            (err as { code?: unknown }).code === QUEUE_TIMEOUT_CODE &&
            (err as { name?: unknown }).name === 'QueueTimeoutError')
    );
}

/** Type guard distinguishing a {@link QueueFullError} from network/HTTP/other errors. */
export function isQueueFullError(err: unknown): err is QueueFullError {
    return (
        err instanceof QueueFullError ||
        (typeof err === 'object' &&
            err !== null &&
            (err as { code?: unknown }).code === QUEUE_FULL_CODE &&
            (err as { name?: unknown }).name === 'QueueFullError')
    );
}

/**
 * Augment Axios's request config so callers can override `queueTimeout` per
 * request with full type-safety: `instance.get(url, { queueTimeout: 250 })`.
 */
declare module 'axios' {
    interface AxiosRequestConfig {
        /**
         * Per-request override (in milliseconds) for the instance-level
         * `queueTimeout`. Covers queue-wait time only. When omitted, the
         * instance-level option (if any) applies.
         */
        queueTimeout?: number;
    }
}

/**
 * Payload passed to the new observability callbacks ({@link AxiosParallelLimitOptions.onDispatch},
 * {@link AxiosParallelLimitOptions.onQueueTimeout}, {@link AxiosParallelLimitOptions.onQueueOverflow}).
 */
export interface QueueEventInfo {
    /** The originating Axios request config. */
    config: InternalAxiosRequestConfig;
    /**
     * Time (ms) the request spent waiting in the queue before this event.
     * `0` for a request that got a slot immediately or one rejected on overflow.
     */
    waitMs: number;
    /** Number of requests still waiting in the queue at the moment the event fired. */
    queueSize: number;
}

export interface AxiosParallelLimitOptions {
    /**
     * The maximum number of parallel (in-flight) requests.
     */
    maxRequests: number;
    /**
     * Callback function called when the number of active (in-flight) requests changes.
     */
    onActiveCountChange?: (activeCount: number) => void;
    /**
     * Callback function called when the number of pending (queued) requests changes.
     */
    onPendingCountChange?: (pendingCount: number) => void;
    /**
     * The maximum time (ms) a request may spend WAITING IN THE QUEUE for a free
     * slot. If it is not dispatched within this window it is removed from the
     * queue (never executed) and its promise is rejected with a
     * {@link QueueTimeoutError}. The timer measures queue-wait only — never the
     * HTTP/execution time — and a request that gets a slot immediately is never
     * subject to it. Can be overridden per-request via `config.queueTimeout`.
     *
     * Default: disabled (unbounded wait — preserves the original behavior).
     */
    queueTimeout?: number;
    /**
     * A hard upper bound on queue depth. When the queue already holds this many
     * waiting requests, new requests are rejected immediately with a
     * {@link QueueFullError} (load shedding / fail-fast back-pressure) instead of
     * being enqueued.
     *
     * Default: unbounded (preserves the original behavior).
     */
    maxQueueSize?: number;
    /**
     * Called when a request begins executing (acquires a slot), exposing how long
     * it waited in the queue. `waitMs` is `0` for a request admitted immediately
     * and the measured queue-wait for one dispatched from the queue.
     */
    onDispatch?: (info: QueueEventInfo) => void;
    /**
     * Called when a request is rejected because it exceeded `queueTimeout` while
     * waiting in the queue.
     */
    onQueueTimeout?: (info: QueueEventInfo) => void;
    /**
     * Called when a request is rejected because the queue was full (`maxQueueSize`).
     */
    onQueueOverflow?: (info: QueueEventInfo) => void;
}

/** A request parked in the queue, waiting for a slot. */
interface QueueItem {
    config: InternalAxiosRequestConfig;
    enqueuedAt: number;
    /** Queue-timeout timer handle (if `queueTimeout` is in effect). */
    timer?: ReturnType<typeof setTimeout>;
    /** Removes any abort/cancel-token listeners attached for this item. */
    detachAbort?: () => void;
    /**
     * `true` once this item has left the queue via ANY exit path (dispatch,
     * timeout, cancel). Guarantees a queued request settles exactly once: the
     * winner of a race flips this and the loser becomes a no-op.
     */
    settled: boolean;
    /** Resolve the acquire() promise, handing back the slot-release function. */
    resolve: (release: () => void) => void;
    /** Reject the acquire() promise (timeout / cancel). */
    reject: (err: unknown) => void;
}

const now = (): number => Date.now();

/**
 * Limits the number of parallel requests for an Axios instance, with an
 * optional bounded queue (`maxQueueSize`) and queue-wait deadline (`queueTimeout`).
 *
 * All options beyond `maxRequests` are opt-in and backward compatible: with only
 * `maxRequests` set, behavior is an unbounded FIFO queue exactly as before.
 *
 * @param axiosInstance The Axios instance to apply the limit to.
 * @param options Configuration options.
 */
export function axiosParallelLimit(
    axiosInstance: AxiosInstance,
    options: AxiosParallelLimitOptions,
): void {
    const { maxRequests, maxQueueSize } = options;
    const queue: QueueItem[] = [];
    let active = 0;

    const notifyActive = (): void => options.onActiveCountChange?.(active);
    const notifyPending = (): void => options.onPendingCountChange?.(queue.length);

    const emit = (
        cb: ((info: QueueEventInfo) => void) | undefined,
        config: InternalAxiosRequestConfig,
        waitMs: number,
        queueSize: number,
    ): void => {
        cb?.({ config, waitMs, queueSize });
    };

    /** The per-request queue-wait budget, honoring a per-call override. */
    const effectiveTimeout = (config: InternalAxiosRequestConfig): number | undefined => {
        const perRequest = config.queueTimeout;
        return typeof perRequest === 'number' ? perRequest : options.queueTimeout;
    };

    /** The standard Axios cancellation error (so `axios.isCancel` recognizes it). */
    const cancelError = (config: InternalAxiosRequestConfig): CanceledError<unknown> =>
        // Axios's runtime CanceledError ctor is (message, config, request); its
        // published type inherits AxiosError's (message, code, config, ...), so we
        // cast the positional `config` to satisfy the type while staying correct at
        // runtime (sets code ERR_CANCELED, the __CANCEL__ marker, and attaches config).
        new CanceledError(undefined, config as unknown as string);

    /** If the request is already aborted/cancelled, the error to reject it with. */
    const alreadyAbortedError = (
        config: InternalAxiosRequestConfig,
    ): unknown | undefined => {
        const signal = config.signal;
        if (signal && signal.aborted) {
            return cancelError(config);
        }
        const token = config.cancelToken as { reason?: unknown } | undefined;
        if (token && token.reason) {
            // Axios sets `reason` (a CanceledError) once the token is cancelled.
            return token.reason;
        }
        return undefined;
    };

    /**
     * Subscribe to abort/cancel signals for a queued item. Returns a detach
     * function that removes every listener (called the moment the item leaves
     * the queue, so nothing fires for an already-settled request).
     */
    const attachAbort = (
        config: InternalAxiosRequestConfig,
        onAbort: () => void,
    ): (() => void) => {
        const detachers: Array<() => void> = [];

        const signal = config.signal;
        if (signal && typeof signal.addEventListener === 'function') {
            const handler = (): void => onAbort();
            signal.addEventListener('abort', handler);
            detachers.push(() => {
                if (typeof signal.removeEventListener === 'function') {
                    signal.removeEventListener('abort', handler);
                }
            });
        }

        const token = config.cancelToken as
            | {
                  subscribe?: (l: () => void) => void;
                  unsubscribe?: (l: () => void) => void;
                  promise?: Promise<unknown>;
              }
            | undefined;
        if (token && typeof token.subscribe === 'function') {
            const handler = (): void => onAbort();
            token.subscribe(handler);
            detachers.push(() => token.unsubscribe?.(handler));
        } else if (token && token.promise && typeof token.promise.then === 'function') {
            // Fallback for cancel tokens lacking subscribe/unsubscribe.
            let live = true;
            token.promise.then(
                () => {
                    if (live) onAbort();
                },
                () => {
                    /* never let a token promise rejection surface as unhandled */
                },
            );
            detachers.push(() => {
                live = false;
            });
        }

        return () => {
            for (const detach of detachers) detach();
        };
    };

    /** Tear down an item's timer and listeners. Idempotent. */
    const clearItem = (item: QueueItem): void => {
        if (item.timer !== undefined) {
            clearTimeout(item.timer);
            item.timer = undefined;
        }
        if (item.detachAbort) {
            item.detachAbort();
            item.detachAbort = undefined;
        }
    };

    const removeFromQueue = (item: QueueItem): boolean => {
        const index = queue.indexOf(item);
        if (index === -1) return false;
        queue.splice(index, 1);
        return true;
    };

    /** Build the release callback handed to an admitted request. */
    const makeRelease = (): (() => void) => {
        let released = false;
        return () => {
            if (released) return; // never decrement twice for one slot
            released = true;
            active--;
            notifyActive(); // active--
            pullNext();
        };
    };

    /** Promote the next queued request into a freed slot, if any. */
    const pullNext = (): void => {
        if (active >= maxRequests) return;
        const item = queue.shift();
        if (!item) return;

        // Won the slot: disable its timeout/abort so neither can act later.
        item.settled = true;
        clearItem(item);

        notifyPending(); // pending--
        active++;
        notifyActive(); // active++
        emit(options.onDispatch, item.config, now() - item.enqueuedAt, queue.length);

        item.resolve(makeRelease());
    };

    const onTimeout = (item: QueueItem): void => {
        if (item.settled) return; // dispatch already won the race
        item.settled = true;
        clearItem(item);
        if (!removeFromQueue(item)) return;

        notifyPending(); // pending-- (active is untouched — it never became in-flight)
        emit(options.onQueueTimeout, item.config, now() - item.enqueuedAt, queue.length);
        item.reject(new QueueTimeoutError(item.config));
    };

    const onAbort = (item: QueueItem): void => {
        if (item.settled) return;
        item.settled = true;
        clearItem(item);
        if (!removeFromQueue(item)) return;

        notifyPending(); // pending-- (active untouched)
        item.reject(cancelError(item.config));
    };

    /**
     * Acquire a concurrency slot. Resolves with a release() callback once a slot
     * is held; rejects (without ever consuming a slot) on overflow, queue-wait
     * timeout, or cancellation while queued.
     */
    const acquire = (config: InternalAxiosRequestConfig): Promise<() => void> => {
        // 1) Slot free → admit immediately (never subject to queueTimeout).
        if (active < maxRequests) {
            active++;
            notifyActive(); // active++
            emit(options.onDispatch, config, 0, queue.length);
            return Promise.resolve(makeRelease());
        }

        // 2) Already aborted before we could queue it → don't enqueue.
        const aborted = alreadyAbortedError(config);
        if (aborted !== undefined) {
            return Promise.reject(aborted);
        }

        // 3) Queue full → reject BEFORE enqueuing (pending unchanged, no count callback).
        if (maxQueueSize !== undefined && queue.length >= maxQueueSize) {
            emit(options.onQueueOverflow, config, 0, queue.length);
            return Promise.reject(new QueueFullError(config));
        }

        // 4) Defer: park in the queue until a slot frees (or it times out / is cancelled).
        return new Promise<() => void>((resolve, reject) => {
            const item: QueueItem = {
                config,
                enqueuedAt: now(),
                settled: false,
                resolve,
                reject,
            };

            const timeout = effectiveTimeout(config);
            if (timeout !== undefined) {
                item.timer = setTimeout(() => onTimeout(item), timeout);
            }
            item.detachAbort = attachAbort(config, () => onAbort(item));

            queue.push(item);
            notifyPending(); // pending++
        });
    };

    axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
        const originalAdapter = config.adapter;

        if (!originalAdapter) {
            return config;
        }

        config.adapter = async (adapterConfig) => {
            // Block here until a slot is granted. If acquire() rejects (overflow,
            // queue timeout, cancel) the original adapter is never invoked.
            const release = await acquire(adapterConfig);
            try {
                return await runOriginalAdapter(originalAdapter, adapterConfig);
            } finally {
                release();
            }
        };

        return config;
    });
}

/**
 * Invoke the request's original Axios adapter, resolving it whether it is a
 * function, an array of adapters/names, or a named adapter string (mirroring
 * how Axios itself resolves adapters).
 */
async function runOriginalAdapter(
    originalAdapter: NonNullable<InternalAxiosRequestConfig['adapter']>,
    adapterConfig: InternalAxiosRequestConfig,
): Promise<AxiosResponse> {
    if (typeof originalAdapter === 'function') {
        return await originalAdapter(adapterConfig);
    } else if (Array.isArray(originalAdapter)) {
        // Iterate over adapters as Axios does
        for (const adapterNameOrFunc of originalAdapter) {
            let adapter: AxiosAdapter | undefined;

            if (typeof adapterNameOrFunc === 'function') {
                adapter = adapterNameOrFunc;
            } else if (typeof adapterNameOrFunc === 'string') {
                try {
                    // @ts-ignore - getAdapter is not in all type definitions yet but exists in runtime
                    adapter = axios.getAdapter(adapterNameOrFunc);
                } catch (err) {
                    // Adapter not supported or not found
                    continue;
                }
            }

            if (adapter) {
                try {
                    return await adapter(adapterConfig);
                } catch (err: any) {
                    if (err && (err.code === 'ERR_ADAPTER_NOT_SUPPORTED' || err.code === 'ERR_NOT_SUPPORT')) {
                        continue;
                    }
                    throw err;
                }
            }
        }
        throw new Error('No adapter in the array handled the request');
    } else if (typeof originalAdapter === 'string') {
        try {
            // @ts-ignore
            const adapter = axios.getAdapter(originalAdapter);
            return await adapter(adapterConfig);
        } catch (err) {
            throw new Error(`String adapter '${originalAdapter}' failed: ${err}`);
        }
    } else {
        throw new Error(`Adapter is not a function or array, it is: ${typeof originalAdapter}`);
    }
}
