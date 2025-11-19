import { AxiosInstance } from 'axios';
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
export declare function axiosParallelLimit(axiosInstance: AxiosInstance, options: AxiosParallelLimitOptions): void;
