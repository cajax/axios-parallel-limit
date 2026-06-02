import axios, {
    AxiosInstance,
    AxiosResponse,
    InternalAxiosRequestConfig,
    AxiosAdapter,
    CanceledError,
} from 'axios';
import { BoundedLimiter, BoundedLimiterEventInfo, Cancellation } from './bounded-limiter.js';

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

/** The standard Axios cancellation error (so `axios.isCancel` recognizes it). */
function cancelError(config: InternalAxiosRequestConfig): CanceledError<unknown> {
    // Axios's runtime CanceledError ctor is (message, config, request); its
    // published type inherits AxiosError's (message, code, config, ...), so we
    // cast the positional `config` to satisfy the type while staying correct at
    // runtime (sets code ERR_CANCELED, the __CANCEL__ marker, and attaches config).
    return new CanceledError(undefined, config as unknown as string);
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

    axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
        const originalAdapter = config.adapter;

        if (!originalAdapter) {
            return config;
        }

        // Idempotency guard: a request re-issued by an auth/retry interceptor (e.g.
        // `instance(error.config)`) re-runs the request interceptors on a config whose
        // `.adapter` is ALREADY our wrapper (mergeConfig copies `adapter` by reference,
        // preserving this Symbol). Re-wrapping it would nest acquire() inside acquire()
        // — an outer slot held while awaiting an inner one — which deadlocks the pool
        // once ~maxRequests re-issues pile up. Reuse the existing wrapper instead.
        if (typeof originalAdapter === 'function' && (originalAdapter as TaggedAdapter)[WRAPPED] === true) {
            return config;
        }

        const wrapped: TaggedAdapter = async (adapterConfig) => {
            // Block here until a slot is granted. If acquire() rejects (overflow,
            // queue timeout, cancel) the original adapter is never invoked.
            const release = await limiter.acquire(adapterConfig, {
                queueTimeout: adapterConfig.queueTimeout,
                cancellation: cancellationFor(adapterConfig),
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
