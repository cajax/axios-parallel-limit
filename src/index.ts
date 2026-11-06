import axios, {
    AxiosInstance,
    AxiosResponse,
    InternalAxiosRequestConfig,
    AxiosAdapter,
    CanceledError,
} from 'axios';
import {
    BoundedLimiter,
    BoundedLimiterEventInfo,
    Cancellation,
    PriorityDeque,
    QueueNode,
} from './bounded-limiter.js';

export { PriorityDeque };
export type { QueueNode };

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
        super(
            message ??
                'Request timed out while waiting in the queue for an available slot (queueTimeout)',
        );
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
        /**
         * Relative priority in the waiting queue (higher values are dispatched first).
         * Requests with equal priority preserve FIFO order. Default: 0.
         */
        priority?: number;
    }
    interface InternalAxiosRequestConfig {
        /**
         * Per-request override (in milliseconds) for the instance-level
         * `queueTimeout`. Covers queue-wait time only. When omitted, the
         * instance-level option (if any) applies.
         */
        queueTimeout?: number;
        /**
         * Relative priority in the waiting queue (higher values are dispatched first).
         * Requests with equal priority preserve FIFO order. Default: 0.
         */
        priority?: number;
    }
}

/**
 * Payload passed to the observability callbacks ({@link AxiosParallelLimitOptions.onDispatch},
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

/**
 * Configuration options for automated adaptive rate-limiting and Retry-After backoff
 * when encountering HTTP 429 (Too Many Requests).
 */
export interface AdaptiveBackoffOptions {
    /**
     * Minimum concurrency floor when throttling down under 429 responses.
     * Default: 1.
     */
    minConcurrency?: number;
    /**
     * Fallback cooldown duration (in milliseconds) if the server omits the `Retry-After` header.
     * Default: 1000ms.
     */
    fallbackCooldownMs?: number;
    /**
     * Maximum allowed backoff duration (in milliseconds), capping excessively long `Retry-After` values.
     * Default: 60000ms (60 seconds).
     */
    maxCooldownMs?: number;
    /**
     * Number of consecutive successful (non-429) requests needed to step concurrency back up by 1.
     * Default: 5.
     */
    successStep?: number;
    /**
     * Multiplicative decrease factor (0 < factor < 1) applied to current concurrency on HTTP 429.
     * E.g. 0.5 halves the concurrency limit.
     * Default: 0.5.
     */
    decreaseFactor?: number;
    /**
     * Callback invoked whenever a 429 response triggers backoff throttling.
     */
    onThrottle?: (info: {
        status: number;
        retryAfterMs: number;
        previousConcurrency: number;
        newConcurrency: number;
        pausedUntil: number;
    }) => void;
    /**
     * Callback invoked whenever consecutive successes ramp concurrency back up.
     */
    onRampUp?: (info: { concurrency: number; targetConcurrency: number }) => void;
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
     * Default: disabled — a queued request waits indefinitely for a slot.
     */
    queueTimeout?: number;
    /**
     * A hard upper bound on queue depth. When the queue already holds this many
     * waiting requests, new requests are rejected immediately with a
     * {@link QueueFullError} (load shedding / fail-fast back-pressure) instead of
     * being enqueued.
     *
     * Default: unbounded — no limit on queue depth.
     */
    maxQueueSize?: number;
    /**
     * Automatically throttle concurrency down on HTTP 429 (Too Many Requests),
     * pause queue execution respecting `Retry-After` headers, and gradually ramp
     * back up upon consecutive successful requests. Pass `true` for defaults or
     * an {@link AdaptiveBackoffOptions} configuration object.
     *
     * Default: disabled (`false`).
     */
    adaptiveBackoff?: boolean | AdaptiveBackoffOptions;
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

/** The standard Axios cancellation error (so `axios.isCancel` recognizes it). */
function cancelError(config: InternalAxiosRequestConfig): CanceledError<unknown> {
    const Ctor = CanceledError as unknown as new (
        message?: string,
        config?: InternalAxiosRequestConfig,
    ) => CanceledError<unknown>;
    return new Ctor(undefined, config);
}

/**
 * Adapt an Axios request's cancellation sources (`config.signal` and/or the
 * legacy `config.cancelToken`) into the generic {@link Cancellation} the limiter
 * understands. Returns `undefined` when the request is not cancellable.
 */
function cancellationFor(config: InternalAxiosRequestConfig): Cancellation | undefined {
    const signal = config.signal;
    const token = config.cancelToken as
        | {
              reason?: unknown;
              subscribe?: (l: () => void) => void;
              unsubscribe?: (l: () => void) => void;
              promise?: Promise<unknown>;
          }
        | undefined;

    if (!signal && !token) {
        return undefined;
    }

    return {
        get aborted(): boolean {
            return Boolean((signal && signal.aborted) || (token && token.reason));
        },
        subscribe(onAbort: () => void): () => void {
            const detachers: Array<() => void> = [];

            if (signal && typeof signal.addEventListener === 'function') {
                const handler = (): void => onAbort();
                signal.addEventListener('abort', handler);
                detachers.push(() => {
                    if (typeof signal.removeEventListener === 'function') {
                        signal.removeEventListener('abort', handler);
                    }
                });
            }

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
        },
    };
}

/**
 * Limits the number of parallel requests for an Axios instance, with an
 * optional bounded queue (`maxQueueSize`) and queue-wait deadline (`queueTimeout`).
 *
 * All options beyond `maxRequests` are optional: with only `maxRequests` set, the
 * limiter caps concurrency and queues the rest in an unbounded FIFO queue.
 *
 * @param axiosInstance The Axios instance to apply the limit to.
 * @param options Configuration options.
 */
/**
 * Controller handle returned by {@link axiosParallelLimit} to inspect and control
 * the concurrency limiter at runtime.
 */
export interface AxiosParallelLimitController {
    /** Number of requests currently executing in-flight. */
    readonly activeCount: number;
    /** Number of requests currently waiting in the queue. */
    readonly pendingCount: number;
    /** Current maximum concurrency limit. */
    readonly maxRequests: number;
    /** Target maximum concurrency limit configured at initialization or via manual override. */
    readonly targetConcurrency: number;
    /** Whether the queue dispatch is currently paused in a backoff cooldown. */
    readonly isPaused: boolean;
    /**
     * Dynamically update the concurrency limit at runtime.
     * If increased, waiting requests are immediately dispatched into the newly available slots.
     */
    setMaxConcurrency(limit: number): void;
    /**
     * Clear all requests currently waiting in the queue, rejecting them with
     * `reason` (or a standard cancellation error if omitted).
     * Requests already executing in-flight are not affected.
     * Returns the number of requests that were cleared.
     */
    clearQueue(reason?: unknown): number;
    /**
     * Temporarily pause queue dispatch for `durationMs` milliseconds.
     */
    pause(durationMs: number): void;
    /**
     * Resume queue dispatch immediately if paused.
     */
    resume(): void;
    /**
     * Reset adaptive backoff state, restoring target concurrency and clearing any active pause.
     */
    resetAdaptiveBackoff(): void;
}

function isHttp429(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as { response?: { status?: number }; status?: number };
    return err.response?.status === 429 || err.status === 429;
}

function getHeader(headers: unknown, name: string): unknown {
    if (!headers || typeof headers !== 'object') return undefined;
    const h = headers as Record<string, unknown> & { get?: (k: string) => unknown };
    if (typeof h.get === 'function') {
        return h.get(name) ?? h.get(name.toLowerCase());
    }
    return h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
}

export function parseRetryAfter(header: unknown, fallbackMs: number, maxMs: number): number {
    if (typeof header === 'number' && Number.isFinite(header)) {
        return Math.min(Math.max(0, header * 1000), maxMs);
    }
    if (typeof header === 'string') {
        const trimmed = header.trim();
        if (/^\d+$/.test(trimmed)) {
            const secs = parseInt(trimmed, 10);
            return Math.min(Math.max(0, secs * 1000), maxMs);
        }
        const parsedDate = Date.parse(trimmed);
        if (!Number.isNaN(parsedDate)) {
            const diff = parsedDate - Date.now();
            return Math.min(Math.max(0, diff), maxMs);
        }
    }
    return Math.min(Math.max(0, fallbackMs), maxMs);
}

export function axiosParallelLimit(
    axiosInstance: AxiosInstance,
    options: AxiosParallelLimitOptions,
): AxiosParallelLimitController {
    if (!Number.isFinite(options.maxRequests) || options.maxRequests < 1) {
        throw new RangeError(
            `maxRequests must be a positive number >= 1, received: ${options.maxRequests}`,
        );
    }

    // Unique per invocation (never `Symbol.for` — must NOT be shared across calls,
    // so two limiters on one instance each recognise only their own wrapper). Tags
    // the adapter wrapper this call installs so the interceptor can detect it.
    const WRAPPED: unique symbol = Symbol('axiosParallelLimitWrapped');
    type TaggedAdapter = AxiosAdapter & { [WRAPPED]?: true };

    // Adapt the host's `QueueEventInfo` callbacks to the limiter's generic event shape.
    const toQueueInfo = (
        cb: ((info: QueueEventInfo) => void) | undefined,
    ): ((info: BoundedLimiterEventInfo<InternalAxiosRequestConfig>) => void) | undefined =>
        cb
            ? (info) => cb({ config: info.context, waitMs: info.waitMs, queueSize: info.queueSize })
            : undefined;

    const limiter = new BoundedLimiter<InternalAxiosRequestConfig>({
        maxConcurrency: options.maxRequests,
        maxQueueSize: options.maxQueueSize,
        queueTimeout: options.queueTimeout,
        onActiveCountChange: options.onActiveCountChange,
        onPendingCountChange: options.onPendingCountChange,
        onDispatch: toQueueInfo(options.onDispatch),
        onQueueTimeout: toQueueInfo(options.onQueueTimeout),
        onQueueOverflow: toQueueInfo(options.onQueueOverflow),
        createTimeoutError: (config) => new QueueTimeoutError(config),
        createOverflowError: (config) => new QueueFullError(config),
        createAbortError: (config) => cancelError(config),
    });

    let targetConcurrency = options.maxRequests;
    let consecutiveSuccesses = 0;
    let lastThrottleTime = 0;

    const backoffConfig: AdaptiveBackoffOptions | null = options.adaptiveBackoff
        ? typeof options.adaptiveBackoff === 'object'
            ? options.adaptiveBackoff
            : {}
        : null;

    if (backoffConfig) {
        const minConcurrency = backoffConfig.minConcurrency ?? 1;
        const fallbackCooldownMs = backoffConfig.fallbackCooldownMs ?? 1000;
        const maxCooldownMs = backoffConfig.maxCooldownMs ?? 60000;
        const successStep = backoffConfig.successStep ?? 5;
        const decreaseFactor = backoffConfig.decreaseFactor ?? 0.5;

        const handle429 = (error: unknown): void => {
            const nowTime = Date.now();
            const rawHeader =
                error && typeof error === 'object' && (error as any).response
                    ? getHeader((error as any).response.headers, 'retry-after')
                    : undefined;
            const cooldownMs = parseRetryAfter(rawHeader, fallbackCooldownMs, maxCooldownMs);

            consecutiveSuccesses = 0;
            limiter.pause(cooldownMs);

            const prevConcurrency = limiter.maxConcurrency;
            let newConcurrency = prevConcurrency;
            if (nowTime - lastThrottleTime > 200) {
                newConcurrency = Math.max(
                    minConcurrency,
                    Math.floor(prevConcurrency * decreaseFactor),
                );
                if (newConcurrency !== prevConcurrency) {
                    limiter.setMaxConcurrency(newConcurrency);
                }
                lastThrottleTime = nowTime;
            }

            backoffConfig.onThrottle?.({
                status: 429,
                retryAfterMs: cooldownMs,
                previousConcurrency: prevConcurrency,
                newConcurrency,
                pausedUntil: Date.now() + cooldownMs,
            });
        };

        const handleSuccess = (): void => {
            if (limiter.maxConcurrency < targetConcurrency) {
                consecutiveSuccesses++;
                if (consecutiveSuccesses >= successStep) {
                    consecutiveSuccesses = 0;
                    const newConcurrency = Math.min(targetConcurrency, limiter.maxConcurrency + 1);
                    limiter.setMaxConcurrency(newConcurrency);
                    backoffConfig.onRampUp?.({
                        concurrency: newConcurrency,
                        targetConcurrency,
                    });
                }
            }
        };

        axiosInstance.interceptors.response.use(
            (response) => {
                handleSuccess();
                return response;
            },
            (error) => {
                if (isHttp429(error)) {
                    handle429(error);
                } else if (
                    error &&
                    typeof error === 'object' &&
                    (error as any).response &&
                    typeof (error as any).response.status === 'number' &&
                    (error as any).response.status < 500
                ) {
                    // Non-5xx client errors (400, 401, 404, etc.) indicate downstream server is healthy
                    handleSuccess();
                }
                return Promise.reject(error);
            },
        );
    }

    axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
        const originalAdapter = config.adapter ?? axiosInstance.defaults.adapter;

        if (!originalAdapter) {
            return config;
        }

        // Idempotency guard: a request re-issued by an auth/retry interceptor (e.g.
        // `instance(error.config)`) re-runs the request interceptors on a config whose
        // `.adapter` is ALREADY our wrapper (mergeConfig copies `adapter` by reference,
        // preserving this Symbol). Re-wrapping it would nest acquire() inside acquire()
        // — an outer slot held while awaiting an inner one — which deadlocks the pool
        // once ~maxRequests re-issues pile up. Reuse the existing wrapper instead.
        if (
            typeof originalAdapter === 'function' &&
            (originalAdapter as TaggedAdapter)[WRAPPED] === true
        ) {
            return config;
        }

        const wrapped: TaggedAdapter = async (adapterConfig) => {
            // Block here until a slot is granted. If acquire() rejects (overflow,
            // queue timeout, cancel) the original adapter is never invoked.
            const release = await limiter.acquire(adapterConfig, {
                queueTimeout: adapterConfig.queueTimeout,
                cancellation: cancellationFor(adapterConfig),
                priority: adapterConfig.priority,
            });
            try {
                return await runOriginalAdapter(originalAdapter, adapterConfig);
            } finally {
                release();
            }
        };
        wrapped[WRAPPED] = true;
        config.adapter = wrapped;

        return config;
    });

    return {
        get activeCount() {
            return limiter.activeCount;
        },
        get pendingCount() {
            return limiter.pendingCount;
        },
        get maxRequests() {
            return limiter.maxConcurrency;
        },
        get targetConcurrency() {
            return targetConcurrency;
        },
        get isPaused() {
            return limiter.isPaused;
        },
        setMaxConcurrency(limit: number) {
            targetConcurrency = limit;
            limiter.setMaxConcurrency(limit);
        },
        clearQueue(reason?: unknown) {
            return limiter.clearQueue(reason);
        },
        pause(durationMs: number) {
            limiter.pause(durationMs);
        },
        resume() {
            limiter.resume();
        },
        resetAdaptiveBackoff() {
            limiter.resume();
            consecutiveSuccesses = 0;
            limiter.setMaxConcurrency(targetConcurrency);
        },
    };
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
                } catch {
                    // Adapter not supported or not found
                    continue;
                }
            }

            if (adapter) {
                try {
                    return await adapter(adapterConfig);
                } catch (err: any) {
                    if (
                        err &&
                        (err.code === 'ERR_ADAPTER_NOT_SUPPORTED' || err.code === 'ERR_NOT_SUPPORT')
                    ) {
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
