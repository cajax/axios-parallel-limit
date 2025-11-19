import pLimit from 'p-limit';
/**
 * Limits the number of parallel requests for an Axios instance.
 * @param axiosInstance The Axios instance to apply the limit to.
 * @param options Configuration options.
 */
export function axiosParallelLimit(axiosInstance, options) {
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
                    if (typeof originalAdapter === 'function') {
                        return await originalAdapter(adapterConfig);
                    }
                    else {
                        throw new Error('Adapter is not a function');
                    }
                }
                finally {
                    // Request finished
                }
            }).finally(() => {
                notify();
            });
        };
        return config;
    });
}
//# sourceMappingURL=index.js.map