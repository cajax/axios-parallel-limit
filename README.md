# axios-parallel-limit

A lightweight, production-grade Axios wrapper that caps in-flight requests, bounds queue backpressure, supports per-request priority, and provides dynamic runtime elasticity.

It lets you control the concurrency of your HTTP requests so your application never overwhelms downstream microservices, third-party APIs, or the client runtime.

---

## Key Features

- **Strict Concurrency Cap**: Limit simultaneous in-flight requests (`maxRequests >= 1`).
- **Adaptive HTTP 429 Backoff (AIMD)**: Automatically throttle concurrency on `429 Too Many Requests`, pause queue dispatch according to RFC-standard `Retry-After` headers, and ramp concurrency back up additively as requests succeed.
- **Dynamic Controller API**: Inspect `activeCount`, `pendingCount`, resize concurrency on the fly (`setMaxConcurrency`), pause/resume, or cancel queued requests (`clearQueue`).
- **Bounded Queue & Fail-Fast Backpressure**: Bound queue depth (`maxQueueSize`) to shed load immediately rather than running out of memory (OOM).
- **Queue-Wait Deadline**: Evict and fail requests that wait too long for a free slot (`queueTimeout`), distinct from HTTP execution timeouts.
- **Per-Request Priority Queueing**: Prioritize high-urgency requests (`priority: number`) to leapfrog lower-priority background jobs.
- **Zero-Leak Cancellation**: Seamlessly propagates `AbortSignal` and Axios `CancelToken` while waiting in queue.
- **Interactive Simulator**: Includes a built-in visual dashboard (`npm run dev`) to test concurrency, burst traffic, and live resizing.
- **Powered by `@cajax/bulkhead-limit`**: Built on top of the decoupled, zero-dependency [`@cajax/bulkhead-limit`](https://github.com/cajax/bulkhead-limit) concurrency engine.
- **TypeScript-Native**: Full type safety, module augmentation for `AxiosRequestConfig`, and typed error guards.

---

## Installation

```bash
npm install @cajax/axios-parallel-limit
```

---

## Quick Start

Wrap any Axios instance to cap concurrency. All configuration beyond `maxRequests` is optional:

```typescript
import axios from 'axios';
import { axiosParallelLimit } from '@cajax/axios-parallel-limit';

const http = axios.create({ baseURL: 'https://api.example.com' });

// Limit concurrency to 5 in-flight requests
const controller = axiosParallelLimit(http, { maxRequests: 5 });

// Dispatch requests as usual: at most 5 run concurrently; the rest queue
for (let i = 0; i < 20; i++) {
    http.get(`/items/${i}`).then((res) => {
        console.log(`Item ${i} loaded:`, res.data);
    });
}
```

---

## Runtime Controller (`AxiosParallelLimitController`)

`axiosParallelLimit` returns a controller handle allowing you to inspect live metrics and modify the queue at runtime:

```typescript
const controller = axiosParallelLimit(http, {
    maxRequests: 5,
    maxQueueSize: 100,
    queueTimeout: 5000,
});

// 1. Inspect live counts
console.log('Active in-flight:', controller.activeCount);
console.log('Waiting in queue:', controller.pendingCount);
console.log('Concurrency limit:', controller.maxRequests);

// 2. Dynamically resize concurrency (e.g. adaptive rate scaling)
controller.setMaxConcurrency(10); // Queued requests immediately dispatch into new slots

// 3. Clear/flush the waiting queue (e.g. on user logout, route unmount, or circuit breaker trip)
const cancelledCount = controller.clearQueue('User navigated away');
console.log(`Cancelled ${cancelledCount} waiting requests`);
```

### Controller API Reference

| Property / Method                        | Type                           | Description                                                                                                                         |
| :--------------------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `controller.activeCount`                 | `number` (read-only)           | Number of requests currently executing in-flight.                                                                                   |
| `controller.pendingCount`                | `number` (read-only)           | Number of requests currently parked in the queue waiting for a free slot.                                                           |
| `controller.maxRequests`                 | `number` (read-only)           | Current maximum concurrency limit.                                                                                                  |
| `controller.targetConcurrency`           | `number` (read-only)           | Target maximum concurrency limit configured at initialization or via manual override.                                               |
| `controller.isPaused`                    | `boolean` (read-only)          | Whether queue dispatch is currently paused in a cooldown window.                                                                    |
| `controller.setMaxConcurrency(newLimit)` | `(limit: number) => void`      | Updates concurrency at runtime. If increased, waiting tasks are immediately dispatched into newly freed slots.                      |
| `controller.clearQueue(reason?)`         | `(reason?: unknown) => number` | Rejects and cancels all requests currently waiting in the queue. In-flight requests are unaffected. Returns count of cleared tasks. |
| `controller.pause(durationMs)`           | `(durationMs: number) => void` | Temporarily suspends queue dispatch for `durationMs`. In-flight requests finish normally.                                           |
| `controller.resume()`                    | `() => void`                   | Immediately resumes queue dispatch if paused.                                                                                       |
| `controller.resetAdaptiveBackoff()`      | `() => void`                   | Restores concurrency to `targetConcurrency` and clears any active pause cooldown.                                                   |

---

## Priority Queueing

You can assign a `priority` to individual requests via `AxiosRequestConfig`. Higher values are dispatched ahead of lower values in the queue:

```typescript
// Background sync job (runs after urgent requests)
http.get('/analytics/sync', { priority: 0 });

// Medium priority data fetch
http.get('/dashboard/metrics', { priority: 5 });

// High priority user-initiated action (jumps to the front of the queue)
http.get('/user/checkout', { priority: 10 });
```

- **Tie-Breaking**: Requests with identical priority preserve strict FIFO ordering.
- **Default**: Requests without `priority` default to `0`.

### High-Throughput O(1) Scheduling (`PriorityDeque`)

The queue is powered by a multi-level double-ended queue (`PriorityDeque`):

- **$O(1)$ Enqueue & Dequeue**: Bypasses `Array.prototype.shift()`, preventing array memory copies and V8 GC pressure under high concurrency.
- **$O(1)$ Unlinking on Abort/Timeout**: When a queued request times out or is aborted via `AbortSignal`, it unlinks its node in $O(1)$ constant time without scanning the queue.
- **Sub-Millisecond Overhead**: Handles 40,000+ operations in under 20ms.

---

## Bounded Queue & Backpressure (The Bulkhead Pattern)

Unbounded concurrency queues are dangerous in production: if a downstream service slows down, incoming requests accumulate indefinitely in memory, leading to heap exhaustion and container crashes (OOM).

`axios-parallel-limit` provides two mechanisms to establish a reliable bulkhead:

### 1. `queueTimeout` (Bound Wait Time)

The maximum time (ms) a request may spend **waiting in the queue** before acquiring a slot. If not dispatched within this window, it is removed from the queue without executing and its promise rejects with `QueueTimeoutError`.

```typescript
axiosParallelLimit(http, {
    maxRequests: 5,
    queueTimeout: 3000, // wait at most 3 seconds in queue
});
```

_Note: `queueTimeout` composes with Axios's own `timeout`. `queueTimeout` bounds the queue wait; Axios `timeout` bounds the actual HTTP network exchange once in flight._

### 2. `maxQueueSize` (Bound Queue Depth)

A hard limit on the number of waiting requests. When the queue is full, new incoming requests fail fast with `QueueFullError` immediately (load shedding).

```typescript
axiosParallelLimit(http, {
    maxRequests: 5,
    maxQueueSize: 50, // queue at most 50 requests; 51st rejects immediately
});
```

### Per-Request `queueTimeout` Override

Individual calls can override the instance-level queue timeout:

```typescript
// Override timeout for this specific call to 250ms
http.get('/fast-endpoint', { queueTimeout: 250 });
```

---

## Cancellation & AbortSignal

If a request carries an `AbortSignal` (`config.signal`) or an Axios `CancelToken` and is aborted **while still waiting in the queue**, it is evicted immediately:

```typescript
const abortController = new AbortController();

const promise = http.get('/slow-task', { signal: abortController.signal });

// If still waiting in the queue, it leaves the queue and never executes
abortController.abort();
```

---

## Adaptive HTTP 429 Backoff & Rate Limiting

When calling rate-limited upstream services (e.g. OpenAI, Stripe, GitHub, internal microservices), continuing to send requests at peak concurrency after receiving an HTTP `429 Too Many Requests` causes cascading failures and extended bans.

Enabling `adaptiveBackoff` activates **Additive Increase / Multiplicative Decrease (AIMD)** with automatic `Retry-After` header parsing:

```typescript
const controller = axiosParallelLimit(http, {
    maxRequests: 10,
    adaptiveBackoff: {
        minConcurrency: 1, // Never drop below 1 concurrent request
        decreaseFactor: 0.5, // Halve concurrency upon receiving a 429
        fallbackCooldownMs: 1500, // Cooldown if Retry-After header is omitted
        maxCooldownMs: 30000, // Cap maximum cooldown at 30 seconds
        successStep: 5, // Ramp concurrency +1 after 5 consecutive successes
        onThrottle: ({ retryAfterMs, previousConcurrency, newConcurrency }) => {
            console.warn(
                `429 received: throttled ${previousConcurrency} -> ${newConcurrency}, pausing ${retryAfterMs}ms`,
            );
        },
        onRampUp: ({ concurrency, targetConcurrency }) => {
            console.log(`Recovered: concurrency increased to ${concurrency}/${targetConcurrency}`);
        },
    },
});
```

### How Adaptive Backoff Works:

1. **RFC `Retry-After` Parsing**: Automatically parses both integer seconds (`Retry-After: 10`) and HTTP-date strings (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`).
2. **Queue Suspension Without Drops**: While paused in cooldown, queued requests remain safely parked in the queue without being dropped or rejected.
3. **Multiplicative Decrease**: Current concurrency limit is halved (or reduced by `decreaseFactor`) down to `minConcurrency`.
4. **Additive Increase**: After `successStep` consecutive non-429 responses, concurrency steps back up (+1) until reaching the initial target concurrency.

---

## Configuration Options

`axiosParallelLimit(axiosInstance, options)` accepts the following options:

| Option                 | Type                                | Required |   Default   | Description                                                                                                                |
| :--------------------- | :---------------------------------- | :------: | :---------: | :------------------------------------------------------------------------------------------------------------------------- |
| `maxRequests`          | `number`                            | **Yes**  |      —      | Concurrency cap (`>= 1`). Maximum simultaneous in-flight requests.                                                         |
| `maxQueueSize`         | `number`                            |    No    | `unbounded` | Hard upper bound on queue depth (`>= 0`). Rejects with `QueueFullError` when exceeded.                                     |
| `queueTimeout`         | `number` (ms)                       |    No    | `disabled`  | Maximum wait duration in queue before rejecting with `QueueTimeoutError` (`>= 0`).                                         |
| `adaptiveBackoff`      | `boolean \| AdaptiveBackoffOptions` |    No    |   `false`   | Enable automatic 429 rate limiting, `Retry-After` backoff, and AIMD recovery. Pass `true` for defaults or a custom config. |
| `onActiveCountChange`  | `(count: number) => void`           |    No    |      —      | Triggered whenever in-flight active count changes.                                                                         |
| `onPendingCountChange` | `(count: number) => void`           |    No    |      —      | Triggered whenever queue pending count changes.                                                                            |
| `onDispatch`           | `(info: QueueEventInfo) => void`    |    No    |      —      | Called when a request acquires a slot and begins execution (`waitMs` indicates queue wait).                                |
| `onQueueTimeout`       | `(info: QueueEventInfo) => void`    |    No    |      —      | Called when a request times out while waiting in queue.                                                                    |
| `onQueueOverflow`      | `(info: QueueEventInfo) => void`    |    No    |      —      | Called when a request is rejected because the queue reached `maxQueueSize`.                                                |

`QueueEventInfo` shape: `{ config: InternalAxiosRequestConfig, waitMs: number, queueSize: number }`.

---

## Errors & Type Guards

The library exports dedicated error classes and type guards:

| Error Class         | `code`                | Type Guard                 | Trigger Condition                                                                     |
| :------------------ | :-------------------- | :------------------------- | :------------------------------------------------------------------------------------ |
| `QueueTimeoutError` | `'ERR_QUEUE_TIMEOUT'` | `isQueueTimeoutError(err)` | Request spent longer than `queueTimeout` waiting for an available slot.               |
| `QueueFullError`    | `'ERR_QUEUE_FULL'`    | `isQueueFullError(err)`    | Request rejected immediately because queue reached `maxQueueSize`.                    |
| `CanceledError`     | `'ERR_CANCELED'`      | `axios.isCancel(err)`      | Request was cancelled via `AbortSignal`, `CancelToken`, or `controller.clearQueue()`. |

### Handling Example:

```typescript
import {
    axiosParallelLimit,
    isQueueTimeoutError,
    isQueueFullError,
} from '@cajax/axios-parallel-limit';
import axios from 'axios';

try {
    await http.get('/resource');
} catch (err) {
    if (isQueueTimeoutError(err)) {
        console.warn(`Queue wait timed out for ${err.config.url}`);
    } else if (isQueueFullError(err)) {
        console.warn(`Queue full, request shed: ${err.config.url}`);
    } else if (axios.isCancel(err)) {
        console.log('Request was cancelled');
    } else if (axios.isAxiosError(err)) {
        console.error(`HTTP/Network error: ${err.response?.status}`);
    }
}
```

---

## Interactive Simulator & Visualizer

A visual traffic generator and concurrency simulator is included in `examples/server.js`.

To run the local simulator:

```bash
npm run dev
# or: node examples/server.js
```

Open your browser to `http://localhost:3000` to interact with:

- Live streaming request ingestion (1–50 req/sec).
- Real-time priority queue jumping visualizer.
- Dynamic concurrency resizing sliders.
- Instant queue purge button (`clearQueue`).
- Real-time event log and backpressure metrics.

---

## Engineering Standards & Definition of Done

To maintain rock-solid stability and prevent regressions:

- **100% Test Coverage**: Every feature, option, edge case, and error path must be covered by automated tests (`npm test`).
- **Documented Before Merge**: Any newly added configuration option, method, error code, or behavioral change **must be documented in this `README.md`** with working TypeScript code samples.
- **Strict Linting & Formatting**: Zero compiler warnings or code style issues (`npm run lint`, `npm run format:check`). Automated corrections are available via `npm run lint:fix` and `npm run format`.
- **Standardized PR & Issue Templates**: Pull requests must satisfy the checklist in `.github/pull_request_template.md` (tests, linting, formatting, docs) prior to merge.

---

## License

MIT © [cajax](https://github.com/cajax)
