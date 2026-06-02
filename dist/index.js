// src/index.ts
import axios, {
  CanceledError
} from "axios";

// src/bounded-limiter.ts
var now = () => Date.now();
var BoundedLimiter = class {
  constructor(options) {
    this.options = options;
    this.queue = [];
    this.active = 0;
    this.notifyActive = () => {
      this.options.onActiveCountChange?.(this.active);
    };
    this.notifyPending = () => {
      this.options.onPendingCountChange?.(this.queue.length);
    };
    this.emit = (cb, context, waitMs) => {
      cb?.({ context, waitMs, queueSize: this.queue.length });
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
      const index = this.queue.indexOf(item);
      if (index === -1) return false;
      this.queue.splice(index, 1);
      return true;
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
      if (this.active >= this.options.maxConcurrency) return;
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
  }
  /** Tasks currently holding a slot. */
  get activeCount() {
    return this.active;
  }
  /** Tasks currently waiting in the queue. */
  get pendingCount() {
    return this.queue.length;
  }
  /**
   * Acquire a slot. Resolves with a `release()` once a slot is held; rejects
   * (without ever consuming a slot) on overflow, queue-wait timeout, or
   * cancellation while queued.
   */
  acquire(context, opts = {}) {
    if (this.active < this.options.maxConcurrency) {
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
    if (maxQueueSize !== void 0 && this.queue.length >= maxQueueSize) {
      this.emit(this.options.onQueueOverflow, context, 0);
      return Promise.reject(this.options.createOverflowError(context));
    }
    return new Promise((resolve, reject) => {
      const item = { context, enqueuedAt: now(), settled: false, resolve, reject };
      const timeout = typeof opts.queueTimeout === "number" ? opts.queueTimeout : this.options.queueTimeout;
      if (timeout !== void 0) {
        item.timer = setTimeout(() => this.onTimeout(item), timeout);
      }
      if (cancellation) {
        item.detachAbort = cancellation.subscribe(() => this.onAbort(item));
      }
      this.queue.push(item);
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
  return new CanceledError(void 0, config);
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
function axiosParallelLimit(axiosInstance, options) {
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
  axiosInstance.interceptors.request.use((config) => {
    const originalAdapter = config.adapter;
    if (!originalAdapter) {
      return config;
    }
    if (typeof originalAdapter === "function" && originalAdapter[WRAPPED] === true) {
      return config;
    }
    const wrapped = async (adapterConfig) => {
      const release = await limiter.acquire(adapterConfig, {
        queueTimeout: adapterConfig.queueTimeout,
        cancellation: cancellationFor(adapterConfig)
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
  QueueFullError,
  QueueTimeoutError,
  axiosParallelLimit,
  isQueueFullError,
  isQueueTimeoutError
};
//# sourceMappingURL=index.js.map