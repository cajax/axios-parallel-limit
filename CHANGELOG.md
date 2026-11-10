# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-11-09

### Added

- **`AxiosParallelLimitController`**: `axiosParallelLimit` now returns a controller handle with runtime observability and management capabilities:
  - `activeCount`: current number of in-flight requests.
  - `pendingCount`: current number of requests waiting in the queue.
  - `maxRequests`: current concurrency cap.
  - `targetConcurrency`: target concurrency cap configured at initialization or updated via `setMaxConcurrency`.
  - `isPaused`: boolean indicating whether the queue is currently suspended during a cooldown.
  - `setMaxConcurrency(limit: number)`: dynamically resize concurrency at runtime without losing queued tasks.
  - `clearQueue(reason?)`: purge and reject all pending queued requests cleanly (e.g. on user logout or page transition).
  - `pause(durationMs)`: temporarily suspend queue dispatch for `durationMs`.
  - `resume()`: immediately resume queue dispatch if paused.
  - `resetAdaptiveBackoff()`: restores concurrency to `targetConcurrency` and clears cooldown.
- **Controller Documentation & Production Recipes**: Added comprehensive documentation and user-facing code recipes covering manual/custom AIMD rate limiting, SPA route transition queue flushing, network elasticity scaling, and telemetry monitoring.
- **Per-Request Priority Queueing**: Pass `priority?: number` on individual request configs (`axios.get(url, { priority: 10 })`). High-priority requests leapfrog lower-priority background tasks in the queue; requests of identical priority preserve strict FIFO ordering.
- **Strict Input Validation**: Fail-fast validation of initialization options (`maxRequests >= 1`, `maxQueueSize >= 0`, `queueTimeout >= 0`) throwing typed `RangeError` / `TypeError`.
- **Adaptive HTTP 429 Backoff & Rate Limiting**: Pass `adaptiveBackoff: true | AdaptiveBackoffOptions` to automatically throttle concurrency (AIMD) on HTTP 429 responses, parse RFC-standard `Retry-After` headers (integer seconds or HTTP-dates), temporarily suspend queue dispatch without dropping requests, and ramp concurrency back up upon consecutive successful requests.
- **High-Performance $O(1)$ Scheduling (`PriorityDeque`)**: Replaced `Array.prototype.shift()` and `splice()` with a multi-level double-ended queue. Dispatches tasks in $O(1)$ time, unlinks aborted/timed-out tasks in $O(1)$ constant time, and eliminates array re-indexing overhead under heavy queue depth.
- **Automated Code Style & Linting**: Configured ESLint (flat config with `@typescript-eslint`) and Prettier with dedicated scripts (`npm run lint`, `npm run lint:fix`, `npm run format`, `npm run format:check`) ensuring strict code quality and uniform formatting.
- **Decoupled Limiter Core (`@cajax/bulkhead-limit`)**: Integrated the decoupled `@cajax/bulkhead-limit` library for core bulkhead concurrency management, priority queue scheduling ($O(1)$ `PriorityDeque`), and RFC 9110 `Retry-After` parsing.
- **Contributor & Issue Templates**: Added GitHub issue templates (`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`) and a pull request template (`.github/pull_request_template.md`) enforcing Definition of Done checklists (tests, linting, formatting, docs).
- **Automated CI Matrix**: Added GitHub Actions workflow (`.github/workflows/ci.yml`) matrix-testing across Node.js 18, 20, and 22 on all PRs and pushes to `main` (`npm run lint`, `npm run format:check`, `npm test`, `npm run build`).
- **Release Verification**: Updated `release.sh` to require code formatting (`npm run format:check`) and linting (`npm run lint`) before testing, building, and publishing.
- **Interactive Simulator**: Included visual web dashboard (`examples/server.js`) for testing streaming load, burst traffic, and dynamic resizing.

## [1.1.1] - 2026-06-02

### Fixed

- **Re-entrancy deadlock from double-wrapping the adapter.** A request re-issued by
  an auth or retry interceptor that reuses the same config object (e.g. refreshing a
  token on `401` and retrying with `instance(error.config)`, or an `axios-retry`-style
  flow) re-runs the request interceptors on a config whose `.adapter` was already this
  library's wrapper (`mergeConfig` copies `adapter` by reference). The interceptor then
  wrapped the wrapper a second time, nesting slot acquisitions — each retry held an
  outer slot while awaiting an inner one. Once ~`maxRequests` re-issued requests piled
  up, every slot was held by an outer acquisition waiting on an inner one that could
  never be granted, permanently deadlocking the pool. Wrapping is now **idempotent**:
  the wrapper is tagged with a per-instance `Symbol` and the interceptor reuses the
  existing wrapper instead of nesting, so a re-issued request performs exactly one
  acquisition and remains fully concurrency-limited. No public API change.

[1.1.1]: https://github.com/cajax/axios-parallel-limit/releases/tag/v1.1.1

## [1.1.0] - 2026-06-01

Bounded queue + offer/wait-deadline support. Everything in this release is
**opt-in and backward compatible**: with only `maxRequests` set, behavior is
identical to `1.0.x`.

### Added

- **`queueTimeout`** (ms, optional): the maximum time a request may spend
  *waiting in the queue* for a free slot. On expiry the request is removed from
  the queue (never executed) and its promise rejects with a `QueueTimeoutError`.
  Measures queue-wait only — never execution/HTTP time — and composes with (does
  not replace) Axios's own request `timeout`. Disabled by default.
- **`maxQueueSize`** (integer, optional): a hard upper bound on queue depth. When
  the queue is full, new requests are rejected immediately with a `QueueFullError`
  (load shedding / fail-fast back-pressure) instead of being enqueued. Unbounded
  by default.
- **Per-request `queueTimeout` override**: pass `{ queueTimeout }` on an individual
  request config to override the instance-level value (typed via module
  augmentation of `AxiosRequestConfig`).
- **Cancellation while queued**: an `AbortSignal` (`config.signal`) or Axios cancel
  token (`config.cancelToken`) that aborts while the request is still queued now
  removes it from the queue, clears its timer, and rejects with the standard Axios
  cancellation error (`axios.isCancel(err) === true`). Work is never dispatched for
  an already-cancelled caller.
- **Typed, exported errors and guards**: `QueueTimeoutError`
  (`code: 'ERR_QUEUE_TIMEOUT'`) and `QueueFullError` (`code: 'ERR_QUEUE_FULL'`),
  plus `isQueueTimeoutError()` / `isQueueFullError()`. Each error carries a stable
  `code`, a clear `name`/`message`, and the originating request `config`. These are
  intentionally **not** Axios errors (`axios.isAxiosError` returns `false`).
- **New observability callbacks** (all optional): `onDispatch(info)` exposing
  per-request queue-wait latency (`waitMs`), `onQueueTimeout(info)`, and
  `onQueueOverflow(info)`, plus an exported `QueueEventInfo` type
  (`{ config, waitMs, queueSize }`).

### Changed

- The concurrency primitive was reimplemented as a purpose-built bounded queue
  (replacing `p-limit`) so that queued requests can carry per-item wait-deadlines,
  be removed on cancellation, and be rejected on overflow with leak-free
  accounting on every exit path. The `p-limit` dependency was removed.
- Count callbacks now fire on the specific counter that changed (e.g. a
  queue-timeout fires `onPendingCountChange` only; `active` is untouched). The
  active/pending **values** reported during a normal workload are unchanged from
  `1.0.x`.

[1.1.0]: https://github.com/cajax/axios-parallel-limit/releases/tag/v1.1.0
