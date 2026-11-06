import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { axiosParallelLimit } from '../src/index.js';

describe('axiosParallelLimit', () => {
    let mock: MockAdapter;
    let instance: ReturnType<typeof axios.create>;

    beforeEach(() => {
        instance = axios.create();
        mock = new MockAdapter(instance);
    });

    afterEach(() => {
        mock.restore();
    });

    test('should limit parallel requests', async () => {
        const maxRequests = 2;
        axiosParallelLimit(instance, { maxRequests });

        let activeRequests = 0;
        let maxActiveSeen = 0;

        mock.onGet('/test').reply(async () => {
            activeRequests++;
            maxActiveSeen = Math.max(maxActiveSeen, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 100));
            activeRequests--;
            return [200, 'ok'];
        });

        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(instance.get('/test'));
        }

        await Promise.all(promises);

        expect(maxActiveSeen).toBeLessThanOrEqual(maxRequests);
        expect(maxActiveSeen).toBe(maxRequests); // Should reach the limit
    });

    test('should call callbacks', async () => {
        const onActiveCountChange = jest.fn<(count: number) => void>();
        const onPendingCountChange = jest.fn<(count: number) => void>();
        const maxRequests = 1;

        axiosParallelLimit(instance, {
            maxRequests,
            onActiveCountChange,
            onPendingCountChange,
        });

        mock.onGet('/test').reply(200, 'ok');

        // Start 3 requests. 1 runs, 2 pending.
        // Note: p-limit might not update pending immediately if we await.
        // But here we fire them all at once.

        // We need to delay the response to ensure queueing happens.
        mock.onGet('/delay').reply(async () => {
            await new Promise((r) => setTimeout(r, 50));
            return [200, 'ok'];
        });

        const p1 = instance.get('/delay');
        const p2 = instance.get('/delay');
        const p3 = instance.get('/delay');

        await Promise.all([p1, p2, p3]);

        expect(onActiveCountChange).toHaveBeenCalled();
        expect(onPendingCountChange).toHaveBeenCalled();

        // Check if we saw pending count > 0
        const pendingCounts = onPendingCountChange.mock.calls.map((c) => c[0]);
        expect(Math.max(...pendingCounts)).toBeGreaterThan(0);
    });

    test('should handle errors correctly', async () => {
        axiosParallelLimit(instance, { maxRequests: 1 });
        mock.onGet('/error').reply(500);

        await expect(instance.get('/error')).rejects.toThrow();
    });

    test('should track active requests throughout the queue processing', async () => {
        const maxRequests = 2;
        const activeCounts: number[] = [];

        axiosParallelLimit(instance, {
            maxRequests,
            onActiveCountChange: (count) => activeCounts.push(count),
        });

        // Each request takes 50ms
        mock.onGet('/test').reply(async () => {
            await new Promise((r) => setTimeout(r, 50));
            return [200, 'ok'];
        });

        // Fire 5 requests
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(instance.get('/test'));
        }

        // Wait a bit for the first batch to start
        await new Promise((r) => setTimeout(r, 10));

        // Should be saturated at 2
        expect(activeCounts[activeCounts.length - 1]).toBe(2);

        // Wait for all to finish
        await Promise.all(promises);

        // Should be back to 0
        expect(activeCounts[activeCounts.length - 1]).toBe(0);

        // Verify we hit the limit but didn't exceed it
        const maxSeen = Math.max(...activeCounts);
        expect(maxSeen).toBe(2);

        // Verify we saw saturation multiple times (indicating sustained load)
        const saturatedCounts = activeCounts.filter((c) => c === 2).length;
        expect(saturatedCounts).toBeGreaterThan(1);
    });

    test('should throw RangeError if maxRequests is invalid', () => {
        expect(() => axiosParallelLimit(instance, { maxRequests: 0 })).toThrow(RangeError);
        expect(() => axiosParallelLimit(instance, { maxRequests: -5 })).toThrow(RangeError);
        expect(() => axiosParallelLimit(instance, { maxRequests: NaN })).toThrow(RangeError);
    });

    test('should properly limit requests when config.adapter is undefined and falls back to defaults.adapter', async () => {
        const customInstance = axios.create();
        let adapterInvocations = 0;
        let concurrentInvocations = 0;
        let maxConcurrent = 0;

        // Set adapter on defaults, without an adapter directly on config
        customInstance.defaults.adapter = async (cfg) => {
            adapterInvocations++;
            concurrentInvocations++;
            maxConcurrent = Math.max(maxConcurrent, concurrentInvocations);
            await new Promise((r) => setTimeout(r, 40));
            concurrentInvocations--;
            return {
                data: 'ok',
                status: 200,
                statusText: 'OK',
                headers: {},
                config: cfg,
            };
        };

        axiosParallelLimit(customInstance, { maxRequests: 2 });

        const requests = [
            customInstance.get('/item1'),
            customInstance.get('/item2'),
            customInstance.get('/item3'),
            customInstance.get('/item4'),
        ];

        await Promise.all(requests);

        expect(adapterInvocations).toBe(4);
        expect(maxConcurrent).toBe(2);
    });

    test('should dispatch queued Axios requests respecting config.priority', async () => {
        const dispatchOrder: string[] = [];

        mock.onGet(/\/job\/(.+)/).reply(async (config) => {
            const id = config.url?.split('/').pop() || '';
            dispatchOrder.push(id);
            await new Promise((r) => setTimeout(r, 40));
            return [200, id];
        });

        axiosParallelLimit(instance, { maxRequests: 1 });

        // Fire initial request that immediately holds the 1 slot
        const pInitial = instance.get('/job/initial');
        await new Promise((r) => setTimeout(r, 5));

        // Queue requests with different priorities
        const pLow = instance.get('/job/low', { priority: 0 });
        const pMedium = instance.get('/job/medium', { priority: 5 });
        const pHigh = instance.get('/job/high', { priority: 10 });

        await Promise.all([pInitial, pLow, pMedium, pHigh]);

        // initial -> high (10) -> medium (5) -> low (0)
        expect(dispatchOrder).toEqual(['initial', 'high', 'medium', 'low']);
    });

    test('returns controller to inspect and update concurrency and clear queue', async () => {
        let active = 0;
        mock.onGet('/slow').reply(async () => {
            active++;
            await new Promise((r) => setTimeout(r, 60));
            active--;
            return [200, 'ok'];
        });

        const controller = axiosParallelLimit(instance, { maxRequests: 1 });
        expect(controller.maxRequests).toBe(1);
        expect(controller.activeCount).toBe(0);
        expect(controller.pendingCount).toBe(0);

        const p1 = instance.get('/slow');
        const p2 = instance.get('/slow');
        const p3 = instance.get('/slow');

        await new Promise((r) => setTimeout(r, 10));

        expect(controller.activeCount).toBe(1);
        expect(controller.pendingCount).toBe(2);

        // Clear remaining queue
        const cleared = controller.clearQueue();
        expect(cleared).toBe(2);
        expect(controller.pendingCount).toBe(0);

        const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

        expect(r1.status).toBe('fulfilled');
        expect(r2.status).toBe('rejected');
        expect(r3.status).toBe('rejected');

        expect(controller.activeCount).toBe(0);
        expect(active).toBe(0);
    });
});
