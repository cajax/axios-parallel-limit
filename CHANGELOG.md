# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
