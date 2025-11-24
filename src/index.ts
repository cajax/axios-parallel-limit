import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig, AxiosAdapter } from 'axios';
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
                    } else if (Array.isArray(originalAdapter)) {
                        // Iterate over adapters as Axios does
                        for (const adapterNameOrFunc of originalAdapter) {
                            let adapter: AxiosAdapter | undefined;

                            if (typeof adapterNameOrFunc === 'function') {
                                adapter = adapterNameOrFunc;
                            } else if (typeof adapterNameOrFunc === 'string') {
                                try {
                                    // @ts-ignore - getAdapter is not in all type definitions yet but exists in runtime
                                    adapter = axios.getAdapter(adapterNameOrFunc);
                                } catch (err) {
                                    // Adapter not supported or not found
                                    continue;
                                }
                            }

                            if (adapter) {
                                try {
                                    return await adapter(adapterConfig);
                                } catch (err: any) {
                                    if (err && (err.code === 'ERR_ADAPTER_NOT_SUPPORTED' || err.code === 'ERR_NOT_SUPPORT')) {
                                        continue;
                                    }
                                    throw err;
                                }
                            }
                        }
                        throw new Error('No adapter in the array handled the request');
                    } else if (typeof originalAdapter === 'string') {
                        try {
                            // @ts-ignore
                            const adapter = axios.getAdapter(originalAdapter);
                            return await adapter(adapterConfig);
                        } catch (err) {
                            throw new Error(`String adapter '${originalAdapter}' failed: ${err}`);
                        }
                    } else {
                        // It might be an object that is NOT an array?
                        // Some custom adapters might be objects with a `call` method?
                        // Unlikely for standard axios.
                        throw new Error(`Adapter is not a function or array, it is: ${typeof originalAdapter}`);
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
