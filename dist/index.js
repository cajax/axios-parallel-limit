var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateWrapper = (obj, member, setter, getter) => ({
  set _(value) {
    __privateSet(obj, member, value, setter);
  },
  get _() {
    return __privateGet(obj, member, getter);
  }
});

// src/index.ts
import axios from "axios";

// node_modules/yocto-queue/index.js
var Node = class {
  constructor(value) {
    __publicField(this, "value");
    __publicField(this, "next");
    this.value = value;
  }
};
var _head, _tail, _size;
var Queue = class {
  constructor() {
    __privateAdd(this, _head);
    __privateAdd(this, _tail);
    __privateAdd(this, _size);
    this.clear();
  }
  enqueue(value) {
    const node = new Node(value);
    if (__privateGet(this, _head)) {
      __privateGet(this, _tail).next = node;
      __privateSet(this, _tail, node);
    } else {
      __privateSet(this, _head, node);
      __privateSet(this, _tail, node);
    }
    __privateWrapper(this, _size)._++;
  }
  dequeue() {
    const current = __privateGet(this, _head);
    if (!current) {
      return;
    }
    __privateSet(this, _head, __privateGet(this, _head).next);
    __privateWrapper(this, _size)._--;
    if (!__privateGet(this, _head)) {
      __privateSet(this, _tail, void 0);
    }
    return current.value;
  }
  peek() {
    if (!__privateGet(this, _head)) {
      return;
    }
    return __privateGet(this, _head).value;
  }
  clear() {
    __privateSet(this, _head, void 0);
    __privateSet(this, _tail, void 0);
    __privateSet(this, _size, 0);
  }
  get size() {
    return __privateGet(this, _size);
  }
  *[Symbol.iterator]() {
    let current = __privateGet(this, _head);
    while (current) {
      yield current.value;
      current = current.next;
    }
  }
  *drain() {
    while (__privateGet(this, _head)) {
      yield this.dequeue();
    }
  }
};
_head = new WeakMap();
_tail = new WeakMap();
_size = new WeakMap();

// node_modules/p-limit/index.js
function pLimit(concurrency) {
  validateConcurrency(concurrency);
  const queue = new Queue();
  let activeCount = 0;
  const resumeNext = () => {
    if (activeCount < concurrency && queue.size > 0) {
      activeCount++;
      queue.dequeue()();
    }
  };
  const next = () => {
    activeCount--;
    resumeNext();
  };
  const run = async (function_, resolve, arguments_) => {
    const result = (async () => function_(...arguments_))();
    resolve(result);
    try {
      await result;
    } catch {
    }
    next();
  };
  const enqueue = (function_, resolve, arguments_) => {
    new Promise((internalResolve) => {
      queue.enqueue(internalResolve);
    }).then(run.bind(void 0, function_, resolve, arguments_));
    if (activeCount < concurrency) {
      resumeNext();
    }
  };
  const generator = (function_, ...arguments_) => new Promise((resolve) => {
    enqueue(function_, resolve, arguments_);
  });
  Object.defineProperties(generator, {
    activeCount: {
      get: () => activeCount
    },
    pendingCount: {
      get: () => queue.size
    },
    clearQueue: {
      value() {
        queue.clear();
      }
    },
    concurrency: {
      get: () => concurrency,
      set(newConcurrency) {
        validateConcurrency(newConcurrency);
        concurrency = newConcurrency;
        queueMicrotask(() => {
          while (activeCount < concurrency && queue.size > 0) {
            resumeNext();
          }
        });
      }
    },
    map: {
      async value(iterable, function_) {
        const promises = Array.from(iterable, (value, index) => this(function_, value, index));
        return Promise.all(promises);
      }
    }
  });
  return generator;
}
function validateConcurrency(concurrency) {
  if (!((Number.isInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency > 0)) {
    throw new TypeError("Expected `concurrency` to be a number from 1 and up");
  }
}

// src/index.ts
function axiosParallelLimit(axiosInstance, options) {
  const limit = pLimit(options.maxRequests);
  const notify = () => {
    if (options.onActiveCountChange) {
      options.onActiveCountChange(limit.activeCount);
    }
    if (options.onPendingCountChange) {
      options.onPendingCountChange(limit.pendingCount);
    }
  };
  axiosInstance.interceptors.request.use((config) => {
    const originalAdapter = config.adapter;
    if (!originalAdapter) {
      return config;
    }
    config.adapter = async (adapterConfig) => {
      notify();
      return limit(async () => {
        notify();
        try {
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
        } finally {
        }
      }).finally(() => {
        notify();
      });
    };
    return config;
  });
}
export {
  axiosParallelLimit
};
//# sourceMappingURL=index.js.map