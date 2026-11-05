// src/index.ts
import axios, {
  CanceledError
} from "axios";

// src/bounded-limiter.ts
var now = () => Date.now();
var PriorityBucket = class {
  constructor(priority) {
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.priority = priority;
  }
  push(item) {
    const node = { item, prev: this.tail, next: null, bucket: this };
    item.node = node;
    this.size++;
    if (this.tail) {
      this.tail.next = node;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    return node;
  }
  shift() {
    if (!this.head) {
      return void 0;
    }
    const node = this.head;
    this.head = node.next;
    if (this.head) {
      this.head.prev = null;
    } else {
      this.tail = null;
    }
    this.size--;
    node.prev = null;
    node.next = null;
    node.bucket = void 0;
    node.item.node = void 0;
    return node.item;
  }
  remove(node) {
    if (node.prev) {
      node.prev.next = node.next;
    } else if (node === this.head) {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else if (node === this.tail) {
      this.tail = node.prev;
    }
    this.size--;
    node.prev = null;
    node.next = null;
    node.bucket = void 0;
    node.item.node = void 0;
  }
};
var PriorityDeque = class {
  constructor() {
    this.buckets = [];
    this.bucketMap = /* @__PURE__ */ new Map();
    this._size = 0;
  }
  get size() {
    return this._size;
  }
  get isEmpty() {
    return this._size === 0;
  }
  /**
   * Inserts an item into the deque respecting its priority.
   * Higher priority items precede lower priority items.
   * Items of identical priority preserve strict FIFO ordering.
   */
  insert(item) {
    let bucket = this.bucketMap.get(item.priority);
    if (!bucket) {
      bucket = new PriorityBucket(item.priority);
      this.bucketMap.set(item.priority, bucket);
      this.insertBucket(bucket);
    }
    const node = bucket.push(item);
    this._size++;
    return node;
  }
  insertBucket(bucket) {
    if (this.buckets.length === 0 || bucket.priority <= this.buckets[this.buckets.length - 1].priority) {
      this.buckets.push(bucket);
      return;
    }
    if (bucket.priority > this.buckets[0].priority) {
      this.buckets.unshift(bucket);
      return;
    }
    let low = 0;
    let high = this.buckets.length;
    while (low < high) {
      const mid = low + high >>> 1;
      if (this.buckets[mid].priority > bucket.priority) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.buckets.splice(low, 0, bucket);
  }
  /**
   * Remove and return the highest priority item from the front of the queue in O(1) time.
   */
  shift() {
    while (this.buckets.length > 0) {
      const highestBucket = this.buckets[0];
      const item = highestBucket.shift();
      if (item) {
        this._size--;
        if (highestBucket.size === 0) {
          this.buckets.shift();
          this.bucketMap.delete(highestBucket.priority);
        }
        return item;
      } else {
        this.buckets.shift();
        this.bucketMap.delete(highestBucket.priority);
      }
    }
    return void 0;
  }
  /**
   * Remove a specific node from anywhere in the queue in O(1) time (used for timeout and cancellation).
   * Returns true if the node was unlinked, false if already removed.
   */
  remove(node) {
    if (!node || !node.bucket) return false;
    const bucket = node.bucket;
    bucket.remove(node);
    this._size--;
    if (bucket.size === 0) {
      this.bucketMap.delete(bucket.priority);
      const idx = this.buckets.indexOf(bucket);
      if (idx !== -1) {
        this.buckets.splice(idx, 1);
      }
    }
    return true;
  }
  /**
   * Clear all items from the queue and return them as an array.
   */
  clear() {
    const items = [];
    for (const bucket of this.buckets) {
      let curr = bucket.head;
      while (curr) {
        curr.item.node = void 0;
        items.push(curr.item);
        curr = curr.next;
      }
    }
    this.buckets = [];
    this.bucketMap.clear();
    this._size = 0;
    return items;
  }
};
var BoundedLimiter = class {
  constructor(options) {
    this.options = options;
    this.queue = new PriorityDeque();
    this.active = 0;
    this.pausedUntil = 0;
    this.notifyActive = () => {
      this.options.onActiveCountChange?.(this.active);
    };
    this.notifyPending = () => {
      this.options.onPendingCountChange?.(this.queue.size);
    };
    this.emit = (cb, context, waitMs) => {
      cb?.({ context, waitMs, queueSize: this.queue.size });
    };
    /** Tear down a queued item's timer and cancellation listener. Idempotent. */
    this.clearItem = (item) => {
      if (item.timer !== void 0) {
        clearTimeout(item.timer);
        item.timer = void 0;
      }
      if (item.detachAbort) {
        item.detachAbort();
        item.detachAbort = void 0;
      }
    };
    this.removeFromQueue = (item) => {
      return this.queue.remove(item.node);
    };
    this.makeRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active--;
        this.notifyActive();
        this.pullNext();
      };
    };
    /** Promote the next queued task into a freed slot, if any. */
    this.pullNext = () => {
      if (this.isPaused || this.active >= this._maxConcurrency) return;
      const item = this.queue.shift();
      if (!item) return;
      item.settled = true;
      this.clearItem(item);
      this.notifyPending();
      this.active++;
      this.notifyActive();
      this.emit(this.options.onDispatch, item.context, now() - item.enqueuedAt);
      item.resolve(this.makeRelease());
    };
    this.onTimeout = (item) => {
      if (item.settled) return;
      item.settled = true;
      this.clearItem(item);
      if (!this.removeFromQueue(item)) return;
      this.notifyPending();
      this.emit(this.options.onQueueTimeout, item.context, now() - item.enqueuedAt);
      item.reject(this.options.createTimeoutError(item.context));
    };
    this.onAbort = (item) => {
      if (item.settled) return;
      item.settled = true;
      this.clearItem(item);
      if (!this.removeFromQueue(item)) return;
      this.notifyPending();
      item.reject(this.options.createAbortError(item.context));
    };
    if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new RangeError(
        `maxConcurrency must be a positive number >= 1, received: ${options.maxConcurrency}`
      );
    }
    if (options.maxQueueSize !== void 0 && (!Number.isFinite(options.maxQueueSize) || options.maxQueueSize < 0)) {
      throw new RangeError(
        `maxQueueSize must be a non-negative number >= 0, received: ${options.maxQueueSize}`
      );
    }
    if (options.queueTimeout !== void 0 && (!Number.isFinite(options.queueTimeout) || options.queueTimeout < 0)) {
      throw new RangeError(
        `queueTimeout must be a non-negative number >= 0, received: ${options.queueTimeout}`
      );
    }
    this._maxConcurrency = options.maxConcurrency;
  }
  /** Tasks currently holding a slot. */
  get activeCount() {
    return this.active;
  }
  /** Tasks currently waiting in the queue. */
  get pendingCount() {
    return this.queue.size;
  }
  /** Current maximum concurrency limit. */
  get maxConcurrency() {
    return this._maxConcurrency;
  }
  /** Whether queue dispatch is temporarily paused in a backoff cooldown. */
  get isPaused() {
    return this.pausedUntil > now();
  }
  /** Timestamp (epoch ms) until which queue dispatch is paused. */
  get pausedUntilTimestamp() {
    return this.pausedUntil;
  }
  /**
   * Pause dispatching tasks from the queue for `durationMs` milliseconds.
   * In-flight tasks continue running, but queued tasks wait until the cooldown expires.
   */
  pause(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const until = now() + durationMs;
    this.pausedUntil = until;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
    }
    this.pauseTimer = setTimeout(() => {
      this.pausedUntil = 0;
      this.pauseTimer = void 0;
      while (!this.isPaused && this.active < this._maxConcurrency && this.queue.size > 0) {
        this.pullNext();
      }
    }, durationMs);
    if (typeof this.pauseTimer === "object" && this.pauseTimer !== null && "unref" in this.pauseTimer && typeof this.pauseTimer.unref === "function") {
      this.pauseTimer.unref();
    }
  }
  /**
   * Resume queue dispatch immediately if paused.
   */
  resume() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = void 0;
    }
    this.pausedUntil = 0;
    while (!this.isPaused && this.active < this._maxConcurrency && this.queue.size > 0) {
      this.pullNext();
    }
  }
  /**
   * Dynamically update the concurrency limit at runtime.
   * If increased, queued tasks are immediately dispatched into available slots.
   */
  setMaxConcurrency(limit) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new RangeError(
        `maxConcurrency must be a positive number >= 1, received: ${limit}`
      );
    }
    this._maxConcurrency = limit;
    while (!this.isPaused && this.active < this._maxConcurrency && this.queue.size > 0) {
      this.pullNext();
    }
  }
  /**
   * Clear all tasks currently waiting in the queue, rejecting them with
   * `reason` (or the default cancellation error). Does not affect tasks
   * already actively in-flight. Returns the count of cancelled tasks.
   */
  clearQueue(reason) {
    const items = this.queue.clear();
    if (items.length === 0) return 0;
    for (const item of items) {
      if (item.settled) continue;
      item.settled = true;
      this.clearItem(item);
      item.reject(reason ?? this.options.createAbortError(item.context));
    }
    this.notifyPending();
    return items.length;
  }
  /**
   * Acquire a slot. Resolves with a `release()` once a slot is held; rejects
   * (without ever consuming a slot) on overflow, queue-wait timeout, or
   * cancellation while queued.
   */
  acquire(context, opts = {}) {
    if (!this.isPaused && this.active < this._maxConcurrency) {
      this.active++;
      this.notifyActive();
      this.emit(this.options.onDispatch, context, 0);
      return Promise.resolve(this.makeRelease());
    }
    const { cancellation } = opts;
    if (cancellation && cancellation.aborted) {
      return Promise.reject(this.options.createAbortError(context));
    }
    const { maxQueueSize } = this.options;
    if (maxQueueSize !== void 0 && this.queue.size >= maxQueueSize) {
      this.emit(this.options.onQueueOverflow, context, 0);
      return Promise.reject(this.options.createOverflowError(context));
    }
    return new Promise((resolve, reject) => {
      const priority = typeof opts.priority === "number" && Number.isFinite(opts.priority) ? opts.priority : 0;
      const item = { context, priority, enqueuedAt: now(), settled: false, resolve, reject };
      const timeout = typeof opts.queueTimeout === "number" ? opts.queueTimeout : this.options.queueTimeout;
      if (timeout !== void 0) {
        const timer = setTimeout(() => this.onTimeout(item), timeout);
        if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
          timer.unref();
        }
        item.timer = timer;
      }
      if (cancellation) {
        item.detachAbort = cancellation.subscribe(() => this.onAbort(item));
      }
      this.queue.insert(item);
      this.notifyPending();
    });
  }
};

// src/index.ts
var QUEUE_TIMEOUT_CODE = "ERR_QUEUE_TIMEOUT";
var QUEUE_FULL_CODE = "ERR_QUEUE_FULL";
var QueueTimeoutError = class _QueueTimeoutError extends Error {
  constructor(config, message) {
    super(message ?? "Request timed out while waiting in the queue for an available slot (queueTimeout)");
    /** Stable, machine-checkable discriminant. */
    this.code = QUEUE_TIMEOUT_CODE;
    this.name = "QueueTimeoutError";
    this.config = config;
    Object.setPrototypeOf(this, _QueueTimeoutError.prototype);
  }
};
var QueueFullError = class _QueueFullError extends Error {
  constructor(config, message) {
    super(message ?? "Request rejected because the queue is full (maxQueueSize reached)");
    /** Stable, machine-checkable discriminant. */
    this.code = QUEUE_FULL_CODE;
    this.name = "QueueFullError";
    this.config = config;
    Object.setPrototypeOf(this, _QueueFullError.prototype);
  }
};
function isQueueTimeoutError(err) {
  return err instanceof QueueTimeoutError || typeof err === "object" && err !== null && err.code === QUEUE_TIMEOUT_CODE && err.name === "QueueTimeoutError";
}
function isQueueFullError(err) {
  return err instanceof QueueFullError || typeof err === "object" && err !== null && err.code === QUEUE_FULL_CODE && err.name === "QueueFullError";
}
function cancelError(config) {
  const Ctor = CanceledError;
  return new Ctor(void 0, config);
}
function cancellationFor(config) {
  const signal = config.signal;
  const token = config.cancelToken;
  if (!signal && !token) {
    return void 0;
  }
  return {
    get aborted() {
      return Boolean(signal && signal.aborted || token && token.reason);
    },
    subscribe(onAbort) {
      const detachers = [];
      if (signal && typeof signal.addEventListener === "function") {
        const handler = () => onAbort();
        signal.addEventListener("abort", handler);
        detachers.push(() => {
          if (typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", handler);
          }
        });
      }
      if (token && typeof token.subscribe === "function") {
        const handler = () => onAbort();
        token.subscribe(handler);
        detachers.push(() => token.unsubscribe?.(handler));
      } else if (token && token.promise && typeof token.promise.then === "function") {
        let live = true;
        token.promise.then(
          () => {
            if (live) onAbort();
          },
          () => {
          }
        );
        detachers.push(() => {
          live = false;
        });
      }
      return () => {
        for (const detach of detachers) detach();
      };
    }
  };
}
function isHttp429(error) {
  if (!error || typeof error !== "object") return false;
  const err = error;
  return err.response?.status === 429 || err.status === 429;
}
function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return void 0;
  const h = headers;
  if (typeof h.get === "function") {
    return h.get(name) ?? h.get(name.toLowerCase());
  }
  return h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
}
function parseRetryAfter(header, fallbackMs, maxMs) {
  if (typeof header === "number" && Number.isFinite(header)) {
    return Math.min(Math.max(0, header * 1e3), maxMs);
  }
  if (typeof header === "string") {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed, 10);
      return Math.min(Math.max(0, secs * 1e3), maxMs);
    }
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      const diff = parsedDate - Date.now();
      return Math.min(Math.max(0, diff), maxMs);
    }
  }
  return Math.min(Math.max(0, fallbackMs), maxMs);
}
function axiosParallelLimit(axiosInstance, options) {
  if (!Number.isFinite(options.maxRequests) || options.maxRequests < 1) {
    throw new RangeError(
      `maxRequests must be a positive number >= 1, received: ${options.maxRequests}`
    );
  }
  const WRAPPED = Symbol("axiosParallelLimitWrapped");
  const toQueueInfo = (cb) => cb ? (info) => cb({ config: info.context, waitMs: info.waitMs, queueSize: info.queueSize }) : void 0;
  const limiter = new BoundedLimiter({
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
    createAbortError: (config) => cancelError(config)
  });
  let targetConcurrency = options.maxRequests;
  let consecutiveSuccesses = 0;
  let lastThrottleTime = 0;
  const backoffConfig = options.adaptiveBackoff ? typeof options.adaptiveBackoff === "object" ? options.adaptiveBackoff : {} : null;
  if (backoffConfig) {
    const minConcurrency = backoffConfig.minConcurrency ?? 1;
    const fallbackCooldownMs = backoffConfig.fallbackCooldownMs ?? 1e3;
    const maxCooldownMs = backoffConfig.maxCooldownMs ?? 6e4;
    const successStep = backoffConfig.successStep ?? 5;
    const decreaseFactor = backoffConfig.decreaseFactor ?? 0.5;
    const handle429 = (error) => {
      const nowTime = Date.now();
      const rawHeader = error && typeof error === "object" && error.response ? getHeader(error.response.headers, "retry-after") : void 0;
      const cooldownMs = parseRetryAfter(rawHeader, fallbackCooldownMs, maxCooldownMs);
      consecutiveSuccesses = 0;
      limiter.pause(cooldownMs);
      const prevConcurrency = limiter.maxConcurrency;
      let newConcurrency = prevConcurrency;
      if (nowTime - lastThrottleTime > 200) {
        newConcurrency = Math.max(minConcurrency, Math.floor(prevConcurrency * decreaseFactor));
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
        pausedUntil: Date.now() + cooldownMs
      });
    };
    const handleSuccess = () => {
      if (limiter.maxConcurrency < targetConcurrency) {
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= successStep) {
          consecutiveSuccesses = 0;
          const newConcurrency = Math.min(targetConcurrency, limiter.maxConcurrency + 1);
          limiter.setMaxConcurrency(newConcurrency);
          backoffConfig.onRampUp?.({
            concurrency: newConcurrency,
            targetConcurrency
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
        } else if (error && typeof error === "object" && error.response && typeof error.response.status === "number" && error.response.status < 500) {
          handleSuccess();
        }
        return Promise.reject(error);
      }
    );
  }
  axiosInstance.interceptors.request.use((config) => {
    const originalAdapter = config.adapter ?? axiosInstance.defaults.adapter;
    if (!originalAdapter) {
      return config;
    }
    if (typeof originalAdapter === "function" && originalAdapter[WRAPPED] === true) {
      return config;
    }
    const wrapped = async (adapterConfig) => {
      const release = await limiter.acquire(adapterConfig, {
        queueTimeout: adapterConfig.queueTimeout,
        cancellation: cancellationFor(adapterConfig),
        priority: adapterConfig.priority
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
    setMaxConcurrency(limit) {
      targetConcurrency = limit;
      limiter.setMaxConcurrency(limit);
    },
    clearQueue(reason) {
      return limiter.clearQueue(reason);
    },
    pause(durationMs) {
      limiter.pause(durationMs);
    },
    resume() {
      limiter.resume();
    },
    resetAdaptiveBackoff() {
      limiter.resume();
      consecutiveSuccesses = 0;
      limiter.setMaxConcurrency(targetConcurrency);
    }
  };
}
async function runOriginalAdapter(originalAdapter, adapterConfig) {
  if (typeof originalAdapter === "function") {
    return await originalAdapter(adapterConfig);
  } else if (Array.isArray(originalAdapter)) {
    for (const adapterNameOrFunc of originalAdapter) {
      let adapter;
      if (typeof adapterNameOrFunc === "function") {
        adapter = adapterNameOrFunc;
      } else if (typeof adapterNameOrFunc === "string") {
        try {
          adapter = axios.getAdapter(adapterNameOrFunc);
        } catch (err) {
          continue;
        }
      }
      if (adapter) {
        try {
          return await adapter(adapterConfig);
        } catch (err) {
          if (err && (err.code === "ERR_ADAPTER_NOT_SUPPORTED" || err.code === "ERR_NOT_SUPPORT")) {
            continue;
          }
          throw err;
        }
      }
    }
    throw new Error("No adapter in the array handled the request");
  } else if (typeof originalAdapter === "string") {
    try {
      const adapter = axios.getAdapter(originalAdapter);
      return await adapter(adapterConfig);
    } catch (err) {
      throw new Error(`String adapter '${originalAdapter}' failed: ${err}`);
    }
  } else {
    throw new Error(`Adapter is not a function or array, it is: ${typeof originalAdapter}`);
  }
}
export {
  PriorityDeque,
  QueueFullError,
  QueueTimeoutError,
  axiosParallelLimit,
  isQueueFullError,
  isQueueTimeoutError,
  parseRetryAfter
};
//# sourceMappingURL=index.js.map