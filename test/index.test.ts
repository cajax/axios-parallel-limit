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
            await new Promise(r => setTimeout(r, 50));
            return [200, 'ok'];
        });

        const p1 = instance.get('/delay');
        const p2 = instance.get('/delay');
        const p3 = instance.get('/delay');

        await Promise.all([p1, p2, p3]);

        expect(onActiveCountChange).toHaveBeenCalled();
        expect(onPendingCountChange).toHaveBeenCalled();

        // Check if we saw pending count > 0
        const pendingCounts = onPendingCountChange.mock.calls.map(c => c[0]);
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
            onActiveCountChange: (count) => activeCounts.push(count)
        });

        // Each request takes 50ms
        mock.onGet('/test').reply(async () => {
            await new Promise(r => setTimeout(r, 50));
            return [200, 'ok'];
        });

        // Fire 5 requests
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(instance.get('/test'));
        }

        // Wait a bit for the first batch to start
        await new Promise(r => setTimeout(r, 10));

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
        const saturatedCounts = activeCounts.filter(c => c === 2).length;
        expect(saturatedCounts).toBeGreaterThan(1);
    });
});
