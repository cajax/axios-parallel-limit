import { InternalAxiosRequestConfig, AxiosInstance } from 'axios';

/**
 * Thrown when a request waits longer than `queueTimeout` for a free slot and is
 * removed from the queue without ever being dispatched.
 *
 * This is deliberately NOT an Axios error (`axios.isAxiosError` returns `false`).
 * Branch on the exported {@link isQueueTimeoutError} guard or the stable
 * `code === 'ERR_QUEUE_TIMEOUT'` discriminant instead.
 */
declare class QueueTimeoutError extends Error {
    /** Stable, machine-checkable discriminant. */
    readonly code = "ERR_QUEUE_TIMEOUT";
    /** The originating Axios request config, for debuggability. */
    readonly config: InternalAxiosRequestConfig;
    constructor(config: InternalAxiosRequestConfig, message?: string);
}
/**
 * Thrown when a request is rejected immediately because the queue already holds
 * `maxQueueSize` waiting requests (fail-fast back-pressure / load shedding).
 *
 * This is deliberately NOT an Axios error (`axios.isAxiosError` returns `false`).
 * Branch on the exported {@link isQueueFullError} guard or the stable
 * `code === 'ERR_QUEUE_FULL'` discriminant instead.
 */
declare class QueueFullError extends Error {
    /** Stable, machine-checkable discriminant. */
    readonly code = "ERR_QUEUE_FULL";
    /** The originating Axios request config, for debuggability. */
    readonly config: InternalAxiosRequestConfig;
    constructor(config: InternalAxiosRequestConfig, message?: string);
}
/** Type guard distinguishing a {@link QueueTimeoutError} from network/HTTP/other errors. */
declare function isQueueTimeoutError(err: unknown): err is QueueTimeoutError;
/** Type guard distinguishing a {@link QueueFullError} from network/HTTP/other errors. */
declare function isQueueFullError(err: unknown): err is QueueFullError;
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
interface QueueEventInfo {
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
interface AdaptiveBackoffOptions {
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
    onRampUp?: (info: {
        concurrency: number;
        targetConcurrency: number;
    }) => void;
}
interface AxiosParallelLimitOptions {
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
interface AxiosParallelLimitController {
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
declare function parseRetryAfter(header: unknown, fallbackMs: number, maxMs: number): number;
declare function axiosParallelLimit(axiosInstance: AxiosInstance, options: AxiosParallelLimitOptions): AxiosParallelLimitController;

export { type AdaptiveBackoffOptions, type AxiosParallelLimitController, type AxiosParallelLimitOptions, type QueueEventInfo, QueueFullError, QueueTimeoutError, axiosParallelLimit, isQueueFullError, isQueueTimeoutError, parseRetryAfter };
