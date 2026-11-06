/**
 * Generic concurrency limiter and priority queue data structures,
 * extracted to and re-exported from @cajax/bulkhead-limit.
 */

export {
    BoundedLimiter,
    PriorityDeque,
    QueueFullError,
    QueueTimeoutError,
    QueueClearedError,
    isQueueFullError,
    isQueueTimeoutError,
    isQueueClearedError,
    parseRetryAfter,
} from '@cajax/bulkhead-limit';

export type {
    BoundedLimiterEventInfo,
    Cancellation,
    AcquireOptions,
    ReleaseFn,
    BoundedLimiterOptions,
    QueueNode,
    QueueItem,
} from '@cajax/bulkhead-limit';
