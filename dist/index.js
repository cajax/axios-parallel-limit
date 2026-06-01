// src/index.ts
import axios, {
  CanceledError
} from "axios";
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
var now = () => Date.now();
function axiosParallelLimit(axiosInstance, options) {
  const { maxRequests, maxQueueSize } = options;
  const queue = [];
  let active = 0;
  const notifyActive = () => options.onActiveCountChange?.(active);
  const notifyPending = () => options.onPendingCountChange?.(queue.length);
  const emit = (cb, config, waitMs, queueSize) => {
    cb?.({ config, waitMs, queueSize });
  };
  const effectiveTimeout = (config) => {
    const perRequest = config.queueTimeout;
    return typeof perRequest === "number" ? perRequest : options.queueTimeout;
  };
  const cancelError = (config) => (
    // Axios's runtime CanceledError ctor is (message, config, request); its
    // published type inherits AxiosError's (message, code, config, ...), so we
    // cast the positional `config` to satisfy the type while staying correct at
    // runtime (sets code ERR_CANCELED, the __CANCEL__ marker, and attaches config).
    new CanceledError(void 0, config)
  );
  const alreadyAbortedError = (config) => {
    const signal = config.signal;
    if (signal && signal.aborted) {
      return cancelError(config);
    }
    const token = config.cancelToken;
    if (token && token.reason) {
      return token.reason;
    }
    return void 0;
  };
  const attachAbort = (config, onAbort2) => {
    const detachers = [];
    const signal = config.signal;
    if (signal && typeof signal.addEventListener === "function") {
      const handler = () => onAbort2();
      signal.addEventListener("abort", handler);
      detachers.push(() => {
        if (typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handler);
        }
      });
    }
    const token = config.cancelToken;
    if (token && typeof token.subscribe === "function") {
      const handler = () => onAbort2();
      token.subscribe(handler);
      detachers.push(() => token.unsubscribe?.(handler));
    } else if (token && token.promise && typeof token.promise.then === "function") {
      let live = true;
      token.promise.then(
        () => {
          if (live) onAbort2();
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
  };
  const clearItem = (item) => {
    if (item.timer !== void 0) {
      clearTimeout(item.timer);
      item.timer = void 0;
    }
    if (item.detachAbort) {
      item.detachAbort();
      item.detachAbort = void 0;
    }
  };
  const removeFromQueue = (item) => {
    const index = queue.indexOf(item);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  };
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      notifyActive();
      pullNext();
    };
  };
  const pullNext = () => {
    if (active >= maxRequests) return;
    const item = queue.shift();
    if (!item) return;
    item.settled = true;
    clearItem(item);
    notifyPending();
    active++;
    notifyActive();
    emit(options.onDispatch, item.config, now() - item.enqueuedAt, queue.length);
    item.resolve(makeRelease());
  };
  const onTimeout = (item) => {
    if (item.settled) return;
    item.settled = true;
    clearItem(item);
    if (!removeFromQueue(item)) return;
    notifyPending();
    emit(options.onQueueTimeout, item.config, now() - item.enqueuedAt, queue.length);
    item.reject(new QueueTimeoutError(item.config));
  };
  const onAbort = (item) => {
    if (item.settled) return;
    item.settled = true;
    clearItem(item);
    if (!removeFromQueue(item)) return;
    notifyPending();
    item.reject(cancelError(item.config));
  };
  const acquire = (config) => {
    if (active < maxRequests) {
      active++;
      notifyActive();
      emit(options.onDispatch, config, 0, queue.length);
      return Promise.resolve(makeRelease());
    }
    const aborted = alreadyAbortedError(config);
    if (aborted !== void 0) {
      return Promise.reject(aborted);
    }
    if (maxQueueSize !== void 0 && queue.length >= maxQueueSize) {
      emit(options.onQueueOverflow, config, 0, queue.length);
      return Promise.reject(new QueueFullError(config));
    }
    return new Promise((resolve, reject) => {
      const item = {
        config,
        enqueuedAt: now(),
        settled: false,
        resolve,
        reject
      };
      const timeout = effectiveTimeout(config);
      if (timeout !== void 0) {
        item.timer = setTimeout(() => onTimeout(item), timeout);
      }
      item.detachAbort = attachAbort(config, () => onAbort(item));
      queue.push(item);
      notifyPending();
    });
  };
  axiosInstance.interceptors.request.use((config) => {
    const originalAdapter = config.adapter;
    if (!originalAdapter) {
      return config;
    }
    config.adapter = async (adapterConfig) => {
      const release = await acquire(adapterConfig);
      try {
        return await runOriginalAdapter(originalAdapter, adapterConfig);
      } finally {
        release();
      }
    };
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