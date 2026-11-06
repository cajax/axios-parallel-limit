// src/index.ts
import axios, {
  CanceledError
} from "axios";
import {
  BoundedLimiter,
  PriorityDeque,
  parseRetryAfter as bulkheadParseRetryAfter
} from "@cajax/bulkhead-limit";
var QUEUE_TIMEOUT_CODE = "ERR_QUEUE_TIMEOUT";
var QUEUE_FULL_CODE = "ERR_QUEUE_FULL";
var QueueTimeoutError = class _QueueTimeoutError extends Error {
  constructor(config, message) {
    super(
      message ?? "Request timed out while waiting in the queue for an available slot (queueTimeout)"
    );
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
  const delay = bulkheadParseRetryAfter(header);
  const resolved = delay !== void 0 ? delay : fallbackMs;
  return Math.min(Math.max(0, resolved), maxMs);
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
        newConcurrency = Math.max(
          minConcurrency,
          Math.floor(prevConcurrency * decreaseFactor)
        );
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
        } catch {
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