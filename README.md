# axios-parallel-limit

A lightweight Axios wrapper that caps the number of in-flight requests and queues the rest. It lets you control the concurrency of your HTTP requests so your application doesn't overwhelm a downstream service or the client itself.

On top of the concurrency cap it adds an **optional bounded queue** (`maxQueueSize`) and an **optional queue-wait deadline** (`queueTimeout`) so that, under overload, requests **fail fast** with a typed error instead of piling up behind an unbounded queue and hanging until some far-away timeout kills them. This is the classic bounded-work-queue / bulkhead pattern used by thread-pool executors and resilience libraries.

Everything beyond `maxRequests` is **optional** — the bounded queue (`maxQueueSize`), the queue-wait deadline (`queueTimeout`), and the observability callbacks. With only `maxRequests` set, the wrapper caps concurrency and queues the rest in an unbounded FIFO queue.

## Installation

```bash
npm install @cajax/axios-parallel-limit
```

## Usage

Cap concurrency with a single option — everything else is optional:

```typescript
import axios from 'axios';
import { axiosParallelLimit } from '@cajax/axios-parallel-limit';

const http = axios.create({ baseURL: 'https://api.example.com' });

axiosParallelLimit(http, { maxRequests: 5 }); // at most 5 requests in flight; the rest queue

// Use the instance exactly as you normally would.
// Only 5 requests run at a time; the other 15 wait their turn in a FIFO queue.
for (let i = 0; i < 20; i++) {
  http.get(`/items/${i}`).then((response) => {
    console.log(`Item ${i} loaded`);
  });
}
```

Add a bounded queue, a queue-wait deadline, and observability callbacks as you need them:

```typescript
axiosParallelLimit(http, {
  maxRequests: 5,     // run at most 5 requests concurrently
  maxQueueSize: 50,   // queue up to 50 more, then reject (load shedding)
  queueTimeout: 5000, // a queued request waits at most 5s for a free slot
  onActiveCountChange: (active) => console.log(`Active requests: ${active}`),
  onPendingCountChange: (pending) => console.log(`Pending requests: ${pending}`),
  onDispatch: ({ config, waitMs }) =>
    console.log(`Dispatched ${config.url} after ${waitMs}ms in the queue`),
  onQueueTimeout: ({ config, waitMs }) =>
    console.warn(`Timed out ${config.url} after waiting ${waitMs}ms for a slot`),
  onQueueOverflow: ({ config }) =>
    console.warn(`Rejected ${config.url}: the queue is full`),
});
```

## Configuration

The `axiosParallelLimit` function takes two arguments:
1. `axiosInstance`: The Axios instance to wrap.
2. `options`: An object with the following properties:

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `maxRequests` | `number` | Yes | — | Maximum number of requests that can run simultaneously. |
| `onActiveCountChange` | `(count: number) => void` | No | — | Called when the number of **active** (in-flight) requests changes. |
| `onPendingCountChange` | `(count: number) => void` | No | — | Called when the number of **pending** (queued) requests changes. |
| `queueTimeout` | `number` (ms) | No | disabled | Max time a request may spend **waiting in the queue** for a free slot. Overridable per request via `config.queueTimeout` (see [Per-request override](#per-request-queuetimeout-override)). See [Bounded queue](#bounded-queue--back-pressure). |
| `maxQueueSize` | `number` | No | unbounded | Hard upper bound on queue depth. Requests beyond it are rejected immediately (load shedding). |
| `onDispatch` | `(info: QueueEventInfo) => void` | No | — | Called when a request starts executing, reporting its **queue-wait latency** (`waitMs`). |
| `onQueueTimeout` | `(info: QueueEventInfo) => void` | No | — | Called when a request is rejected due to `queueTimeout`. |
| `onQueueOverflow` | `(info: QueueEventInfo) => void` | No | — | Called when a request is rejected due to `maxQueueSize`. |

`QueueEventInfo` is `{ config, waitMs, queueSize }` — the originating request `config`, the milliseconds spent waiting in the queue (`0` for an immediate dispatch or an overflow), and the number of requests still queued when the event fired.

## Bounded queue & back-pressure

### Why

Capping concurrency alone still uses an **unbounded** queue: every request above the cap waits, with no limit on how long or how deep. With `N` slots and per-request service time `S`, a request queued at position `P` waits roughly `(P / N) * S` before it even *starts*. If the downstream slows down (`S` rises) or arrivals outpace the drain rate, the queue — and the wait — grow without bound. A caller can then wait far longer than its own deadline, and longer than any outer HTTP-server / proxy / load-balancer timeout sitting above it. When that outer timeout fires, the request is killed with no useful error: it was queued, never dispatched. There's also no back-pressure signal — nothing fails fast, so load keeps piling onto a queue that can't drain.

`queueTimeout` and `maxQueueSize` are the two levers that fix this.

### `queueTimeout` — bound how long a request waits

`queueTimeout` (milliseconds) is the maximum time a request may spend **waiting in the queue** for a free slot. If it isn't dispatched within that window it is removed from the queue (**never executed**) and its promise rejects with a [`QueueTimeoutError`](#errors--type-guards).

- The timer starts the instant the request is deferred (no slot available) and is cleared the instant it is dispatched.
- It measures **queue-wait only** — never the execution/HTTP time.
- A request that gets a slot immediately is **never** subject to it.

**It composes with — does not replace — Axios's own request `timeout`.** Axios's `timeout` bounds the HTTP exchange once the request is in flight; `queueTimeout` bounds the wait *before* it goes in flight. A request's worst-case total budget is therefore:

```
worst-case total ≈ queueTimeout (queue-wait) + timeout (execution)
```

Size them so that sum stays comfortably under any outer deadline (server socket timeout, proxy, load balancer) — that way the request fails *here*, fast, with a typed error, instead of being killed opaquely from far away.

### `maxQueueSize` — bound how deep the queue gets

`maxQueueSize` is a hard limit on the number of waiting requests. When the queue is full, new requests are rejected **immediately** with a [`QueueFullError`](#errors--type-guards) instead of being enqueued (load shedding / fail-fast back-pressure). Requests already in the queue are unaffected.

### Per-request `queueTimeout` override

A single call can override the instance-level `queueTimeout` via a `queueTimeout` field on its request config (typed via module augmentation):

```typescript
// This call may wait at most 250ms in the queue, regardless of the instance default.
http.get('/report', { queueTimeout: 250 });
```

When omitted, the instance-level `queueTimeout` (if any) applies.

### Cancellation while queued

If a request carries an `AbortSignal` (`config.signal`) or an Axios cancel token (`config.cancelToken`) and it is aborted **while still waiting in the queue**, it is removed from the queue immediately, its queue-timeout timer is cleared, and its promise rejects with the standard Axios cancellation error (so `axios.isCancel(err)` is `true`). Work is never dispatched for an already-cancelled caller.

```typescript
const controller = new AbortController();
const p = http.get('/slow', { signal: controller.signal });
controller.abort(); // if still queued, it leaves the queue and never executes
```

### Example: a client calling a slower downstream

```typescript
import axios from 'axios';
import { axiosParallelLimit, isQueueTimeoutError, isQueueFullError } from '@cajax/axios-parallel-limit';

const downstream = axios.create({
  baseURL: 'https://downstream.internal',
  timeout: 10_000,          // execution timeout: bound the HTTP exchange itself
});

axiosParallelLimit(downstream, {
  maxRequests: 10,          // match the downstream's safe concurrency
  maxQueueSize: 100,        // ~10x the cap: absorb bursts, then shed load
  queueTimeout: 5_000,      // wait at most 5s for a slot, then fail fast
  onQueueTimeout: ({ waitMs, config }) =>
    console.warn(`shed (queue-wait ${waitMs}ms): ${config.url}`),
  onQueueOverflow: ({ config }) =>
    console.warn(`shed (queue full): ${config.url}`),
});

try {
  const res = await downstream.get('/things');
  // ...
} catch (err) {
  if (isQueueTimeoutError(err)) {
    // waited too long for a slot — back-pressure, retry later / degrade
  } else if (isQueueFullError(err)) {
    // queue is full — shed this request
  } else {
    // a normal network/HTTP error (axios.isAxiosError(err)) or a cancellation
  }
}
```

**Recommended starting values:** set `maxRequests` to the concurrency the downstream can comfortably sustain; set `maxQueueSize` to a small multiple of `maxRequests` (e.g. 5–10×) to absorb bursts while bounding worst-case latency and memory; set `queueTimeout` so that `queueTimeout + timeout` stays safely below your outer request deadline. Tune from there using `onDispatch`'s `waitMs` (queue-wait latency) and the active/pending counts.

## Errors & type guards

Two typed errors are exported so you can distinguish queue rejections from network/HTTP errors:

| Class | `code` | Guard | Thrown when |
|-------|--------|-------|-------------|
| `QueueTimeoutError` | `'ERR_QUEUE_TIMEOUT'` | `isQueueTimeoutError(err)` | A request exceeds `queueTimeout` while queued. |
| `QueueFullError` | `'ERR_QUEUE_FULL'` | `isQueueFullError(err)` | A request is rejected because the queue is full (`maxQueueSize`). |

Each carries a stable, machine-checkable `code`, a descriptive `name`/`message`, and the originating request `config`.

**Design choice (and trade-off):** callers commonly branch on `axios.isAxiosError(err)`. A queue rejection is **not** an Axios error, and these classes are intentionally kept distinct — `axios.isAxiosError(err)` returns `false` for both. Branch on the exported type guards (or the stable `code`) instead. This is the correct, unambiguous choice, but note the trade-off: existing code that only inspects `axios.isAxiosError` / Axios timeout codes (`ECONNABORTED`) will **not** treat a queue rejection as a timeout. (We deliberately do *not* masquerade these as Axios `ECONNABORTED` errors; if you need that, map them yourself in a response interceptor.) A cancellation while queued *does* reject with the standard Axios cancellation error, so `axios.isCancel(err)` works as usual.

## Counts and observability

The two count signals — **active** (in-flight) and **pending** (queued) — stay correct across every exit path. Each transition fires the matching callback exactly once:

| Transition | active | pending | Fires |
|------------|:------:|:-------:|-------|
| Admitted immediately (slot free) | `++` | — | `onActiveCountChange`, `onDispatch` (`waitMs: 0`) |
| Deferred (no slot) | — | `++` | `onPendingCountChange` |
| Dispatched from the queue | `++` | `--` | `onPendingCountChange`, `onActiveCountChange`, `onDispatch` (`waitMs` = time queued) |
| Request settles (resolve/reject) | `--` | — | `onActiveCountChange` |
| **`queueTimeout` fires while queued** | — | `--` | `onPendingCountChange`, `onQueueTimeout` |
| **Cancelled while queued** | — | `--` | `onPendingCountChange` |
| **`maxQueueSize` overflow** | — | — | `onQueueOverflow` *(no count callback — the request was never enqueued)* |

Key invariants: `active` never exceeds `maxRequests` on any path; `pending` always equals the number of requests physically in the queue and returns to `0` once it drains, however items left it; and an overflow-rejected request fires **no** count callback (it is rejected before being enqueued).

> Note: each callback fires on the specific count that changed — e.g. a queue-timeout fires `onPendingCountChange` only, leaving `active` untouched.

## How it works

The library wraps the Axios adapter to intercept the actual request execution. Each request must acquire one of `maxRequests` concurrency slots before its underlying adapter runs. If a slot is free the request runs immediately; otherwise it waits in an in-memory FIFO queue (subject to `maxQueueSize` and `queueTimeout` when configured) and is dispatched, in order, as slots free up. Timed-out, overflowed, and cancelled requests are removed from the queue and never reach the transport; their queue-timeout timers are always cleared, so nothing leaks after the queue drains.

### Idempotent wrapping (auth / retry interceptors)

Wrapping is **idempotent**. A request re-issued by an auth or retry interceptor that reuses the same config object — e.g. refreshing a token on `401` and retrying with `instance(error.config)`, or an `axios-retry`-style flow — reuses the single existing adapter wrapper instead of being wrapped again. It therefore acquires exactly one slot per attempt and stays fully concurrency-limited, no matter how many times it is retried.

> Apply `axiosParallelLimit` **at most once per axios instance**. Stacking it on the same instance creates independent, nested pools that can deadlock, so it is unsupported.

## License

MIT
