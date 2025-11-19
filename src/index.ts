import { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import pLimit from 'p-limit';

export interface AxiosParallelLimitOptions {
    /**
     * The maximum number of parallel requests.
     */
    maxRequests: number;
    /**
     * Callback function called when the number of active requests changes.
     */
    onActiveCountChange?: (activeCount: number) => void;
    /**
     * Callback function called when the number of pending requests changes.
     */
    onPendingCountChange?: (pendingCount: number) => void;
}

/**
 * Limits the number of parallel requests for an Axios instance.
 * @param axiosInstance The Axios instance to apply the limit to.
 * @param options Configuration options.
 */
export function axiosParallelLimit(
    axiosInstance: AxiosInstance,
    options: AxiosParallelLimitOptions
): void {
    const limit = pLimit(options.maxRequests);

    const notify = () => {
        if (options.onActiveCountChange) {
            options.onActiveCountChange(limit.activeCount);
        }
        if (options.onPendingCountChange) {
            options.onPendingCountChange(limit.pendingCount);
        }
    };

    axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
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
                    } else {
                        throw new Error('Adapter is not a function');
                    }
                } finally {
                    // Request finished
                }
            }).finally(() => {
                notify();
            });
        };

        return config;
    });
}
