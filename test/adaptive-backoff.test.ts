import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { axiosParallelLimit, parseRetryAfter } from '../src/index.js';

describe('Adaptive HTTP 429 Backoff & Rate Limiting', () => {
    let instance: AxiosInstance;
    let mock: MockAdapter;

    beforeEach(() => {
        instance = axios.create();
        mock = new MockAdapter(instance);
    });

    afterEach(() => {
        mock.restore();
    });

    describe('parseRetryAfter', () => {
        test('parses integer seconds header', () => {
            expect(parseRetryAfter('3', 1000, 60000)).toBe(3000);
            expect(parseRetryAfter('  5  ', 1000, 60000)).toBe(5000);
            expect(parseRetryAfter(2, 1000, 60000)).toBe(2000);
        });

        test('parses HTTP date header into delta ms', () => {
            const futureDate = new Date(Date.now() + 10000).toUTCString();
            const parsed = parseRetryAfter(futureDate, 1000, 60000);
            expect(parsed).toBeGreaterThan(8000);
            expect(parsed).toBeLessThanOrEqual(10000);
        });

        test('uses fallback when header is missing or unparseable', () => {
            expect(parseRetryAfter(undefined, 1500, 60000)).toBe(1500);
            expect(parseRetryAfter('invalid-format', 2000, 60000)).toBe(2000);
            expect(parseRetryAfter('', 3000, 60000)).toBe(3000);
        });

        test('caps to maxCooldownMs', () => {
            expect(parseRetryAfter('300', 1000, 5000)).toBe(5000);
        });
    });

    describe('AIMD Throttling & Queue Pause', () => {
        test('throttles concurrency down on 429 and triggers onThrottle callback', async () => {
            const throttledEvents: any[] = [];

            mock.onGet('/api/limited').reply(429, 'Too many requests', {
                'retry-after': '1',
            });
            mock.onGet('/api/ok').reply(200, 'success');

            const controller = axiosParallelLimit(instance, {
                maxRequests: 4,
                adaptiveBackoff: {
                    minConcurrency: 1,
                    decreaseFactor: 0.5,
                    onThrottle: (info) => throttledEvents.push(info),
                },
            });

            expect(controller.maxRequests).toBe(4);
            expect(controller.targetConcurrency).toBe(4);
            expect(controller.isPaused).toBe(false);

            await expect(instance.get('/api/limited')).rejects.toThrow();

            expect(controller.maxRequests).toBe(2); // 4 * 0.5
            expect(controller.isPaused).toBe(true);
            expect(throttledEvents.length).toBe(1);
            expect(throttledEvents[0].status).toBe(429);
            expect(throttledEvents[0].retryAfterMs).toBe(1000);
            expect(throttledEvents[0].previousConcurrency).toBe(4);
            expect(throttledEvents[0].newConcurrency).toBe(2);

            // Manual resume to test immediate recovery
            controller.resume();
            expect(controller.isPaused).toBe(false);
        });

        test('respects minConcurrency floor', async () => {
            mock.onGet('/fail').reply(429);

            const controller = axiosParallelLimit(instance, {
                maxRequests: 2,
                adaptiveBackoff: {
                    minConcurrency: 2, // cannot drop below 2
                    decreaseFactor: 0.5,
                },
            });

            await expect(instance.get('/fail')).rejects.toThrow();
            expect(controller.maxRequests).toBe(2);
        });

        test('pauses queue dispatch during cooldown and resumes on expiry', async () => {
            const executionOrder: string[] = [];

            mock.onGet('/first').reply(429, {}, { 'retry-after': '1' }); // 1 sec
            mock.onGet('/second').reply(async () => {
                executionOrder.push('second');
                return [200, 'ok'];
            });

            const controller = axiosParallelLimit(instance, {
                maxRequests: 2,
                adaptiveBackoff: {
                    fallbackCooldownMs: 50,
                    minConcurrency: 1,
                },
            });

            // First triggers 429 with 1s pause
            await expect(instance.get('/first')).rejects.toThrow();
            expect(controller.isPaused).toBe(true);

            // Trigger a manual shorter pause to test timer unpause
            controller.pause(50);
            expect(controller.isPaused).toBe(true);

            // Queue a second request while paused
            const pSecond = instance.get('/second');

            // Allow Axios request interceptor microtasks to run
            await new Promise((r) => setTimeout(r, 10));

            // While paused, it should remain queued
            expect(controller.pendingCount).toBe(1);
            expect(controller.activeCount).toBe(0);

            // Wait for 50ms cooldown to expire
            await new Promise((r) => setTimeout(r, 80));

            expect(controller.isPaused).toBe(false);
            const res = await pSecond;
            expect(res.data).toBe('ok');
            expect(executionOrder).toEqual(['second']);
        });

        test('ramps concurrency back up after successStep consecutive successful responses', async () => {
            const rampUpEvents: any[] = [];

            mock.onGet('/api/data').reply(200, 'ok');
            mock.onGet('/api/throttle').reply(429, {}, { 'retry-after': '1' });

            const controller = axiosParallelLimit(instance, {
                maxRequests: 3,
                adaptiveBackoff: {
                    minConcurrency: 1,
                    decreaseFactor: 0.33, // 3 * 0.33 = 1
                    successStep: 2, // every 2 successes step up +1
                    onRampUp: (info) => rampUpEvents.push(info),
                },
            });

            // Throttle down to 1
            await expect(instance.get('/api/throttle')).rejects.toThrow();
            expect(controller.maxRequests).toBe(1);
            controller.resume(); // clear pause for immediate execution

            // Success #1 -> still 1
            await instance.get('/api/data');
            expect(controller.maxRequests).toBe(1);
            expect(rampUpEvents.length).toBe(0);

            // Success #2 -> ramps to 2
            await instance.get('/api/data');
            expect(controller.maxRequests).toBe(2);
            expect(rampUpEvents.length).toBe(1);
            expect(rampUpEvents[0].concurrency).toBe(2);
            expect(rampUpEvents[0].targetConcurrency).toBe(3);

            // Success #3 -> still 2
            await instance.get('/api/data');
            expect(controller.maxRequests).toBe(2);

            // Success #4 -> ramps to target cap 3
            await instance.get('/api/data');
            expect(controller.maxRequests).toBe(3);
            expect(rampUpEvents.length).toBe(2);
            expect(rampUpEvents[1].concurrency).toBe(3);

            // Success #5 -> stays capped at 3
            await instance.get('/api/data');
            expect(controller.maxRequests).toBe(3);
        });

        test('resetAdaptiveBackoff restores target concurrency and clears active pause', async () => {
            mock.onGet('/throttle').reply(429);

            const controller = axiosParallelLimit(instance, {
                maxRequests: 5,
                adaptiveBackoff: {
                    minConcurrency: 1,
                    fallbackCooldownMs: 10000,
                },
            });

            await expect(instance.get('/throttle')).rejects.toThrow();
            expect(controller.maxRequests).toBe(2); // 5 * 0.5 = 2
            expect(controller.isPaused).toBe(true);

            controller.resetAdaptiveBackoff();

            expect(controller.maxRequests).toBe(5);
            expect(controller.isPaused).toBe(false);
        });
    });
});
