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
    }
}
/**
 * Payload passed to the new observability callbacks ({@link AxiosParallelLimitOptions.onDispatch},
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
declare function axiosParallelLimit(axiosInstance: AxiosInstance, options: AxiosParallelLimitOptions): void;

export { type AxiosParallelLimitOptions, type QueueEventInfo, QueueFullError, QueueTimeoutError, axiosParallelLimit, isQueueFullError, isQueueTimeoutError };
