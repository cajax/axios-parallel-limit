import axios, { AxiosInstance } from 'axios';
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { axiosParallelLimit } from '../src/index.js';

// ---------------------------------------------------------------------------
// These tests pin down that `axiosParallelLimit` wraps an instance's adapter
// IDEMPOTENTLY. A request re-issued by an auth/retry interceptor (`instance(
// error.config)`) re-runs the request interceptors on a config whose `.adapter`
// is ALREADY this library's wrapper. Re-wrapping it would nest acquire() inside
// acquire() — an outer slot held while awaiting an inner one — which, once
// ~maxRequests re-issues pile up, permanently deadlocks the pool.
//
// The fix tags the wrapper with a per-call Symbol and short-circuits the
// interceptor when it sees its own tag. No public API change.
// ---------------------------------------------------------------------------

/** Attach a handler immediately so an expected rejection is never "unhandled". */
const outcome = (
    p: Promise<unknown>,
): Promise<{ status: 'fulfilled' | 'rejected'; value?: unknown; reason?: any }> =>
    p.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
    );

/** Drain the microtask queue until `cond` holds (purely promise-based, no timers). */
async function flushUntil(cond: () => boolean, label = 'condition'): Promise<void> {
    for (let i = 0; i < 1000; i++) {
        if (cond()) return;
        await Promise.resolve();
    }
    throw new Error(`flushUntil: ${label} was never met`);
}

/** The request interceptor `axiosParallelLimit` installs (fresh instance ⇒ index 0). */
function requestInterceptor(instance: AxiosInstance): (config: any) => any {
    return (instance.interceptors.request as any).handlers[0].fulfilled;
}

interface Controller {
    config: any;
    /** Resolve the parked transport call as an Axios response with `status`. */
    settle: (status?: number, data?: any) => void;
    fail: (err: any) => void;
}

interface Harness {
    instance: AxiosInstance;
    transport: ReturnType<typeof jest.fn>;
    controllers: Controller[];
    state: { active: number; pending: number; maxActive: number };
    dispatched: any[];
}

/**
 * An instance whose default adapter is a fully controllable transport that parks
 * every call until the test settles it. Lets us hold slots open and drive the
 * queue deterministically, and count exactly how many calls reach the wire.
 */
function createHarness(opts: Parameters<typeof axiosParallelLimit>[1]): Harness {
    const instance = axios.create();
    const controllers: Controller[] = [];

    const transport = jest.fn((config: any) =>
        new Promise((resolve, reject) => {
            controllers.push({
                config,
                settle: (status = 200, data: any = { ok: true }) =>
                    resolve({ data, status, statusText: '', headers: {}, config }),
                fail: reject,
            });
        }),
    );
    instance.defaults.adapter = transport as any;

    const state = { active: 0, pending: 0, maxActive: 0 };
    const dispatched: any[] = [];

    axiosParallelLimit(instance, {
        ...opts,
        onActiveCountChange: (n) => {
            state.active = n;
            state.maxActive = Math.max(state.maxActive, n);
        },
        onPendingCountChange: (n) => {
            state.pending = n;
        },
        onDispatch: (i) => dispatched.push(i),
    });

    return { instance, transport, controllers, state, dispatched };
}

afterEach(() => {
    jest.useRealTimers();
});

describe('idempotent wrapping — interceptor level', () => {
    // Edge case 1: running the request interceptor twice on the SAME config must
    // leave config.adapter wrapped EXACTLY ONCE (the second pass is a no-op).
    test('re-running the interceptor on the same config does not re-wrap the adapter', () => {
        const instance = axios.create();
        axiosParallelLimit(instance, { maxRequests: 1 });
        const intercept = requestInterceptor(instance);

        const transport = jest.fn();
        const c1 = intercept({ adapter: transport });
        expect(typeof c1.adapter).toBe('function');
        expect(c1.adapter).not.toBe(transport); // first pass wraps

        const wrapper = c1.adapter;
        const c2 = intercept(c1); // re-issue re-runs interceptors on the same config
        expect(c2.adapter).toBe(wrapper); // ← must be the SAME wrapper, not a nested one

        const c3 = intercept(c2); // still idempotent on a third pass
        expect(c3.adapter).toBe(wrapper);
    });

    // Edge case 3: a non-function adapter (string name / array) is NOT our tagged
    // wrapper, so a first-time one must still be wrapped normally; only a re-run
    // (now our tagged function) is skipped.
    test('a first-time string adapter is wrapped, then re-running is a no-op', () => {
        const instance = axios.create();
        axiosParallelLimit(instance, { maxRequests: 1 });
        const intercept = requestInterceptor(instance);

        const c1 = intercept({ adapter: 'xhr' });
        expect(typeof c1.adapter).toBe('function'); // string replaced by our wrapper
        const wrapper = c1.adapter;

        const c2 = intercept(c1);
        expect(c2.adapter).toBe(wrapper); // no double-wrap on the re-run
    });

    test('a first-time array adapter is wrapped, then re-running is a no-op', () => {
        const instance = axios.create();
        axiosParallelLimit(instance, { maxRequests: 1 });
        const intercept = requestInterceptor(instance);

        const c1 = intercept({ adapter: ['xhr', 'http'] });
        expect(typeof c1.adapter).toBe('function');
        const wrapper = c1.adapter;

        const c2 = intercept(c1);
        expect(c2.adapter).toBe(wrapper);
    });

    // Edge case 5: a caller's own (untagged) per-request adapter must still be
    // wrapped — the guard only skips OUR already-tagged wrapper.
    test('a caller-supplied untagged adapter is still wrapped', () => {
        const instance = axios.create();
        axiosParallelLimit(instance, { maxRequests: 1 });
        const intercept = requestInterceptor(instance);

        const callerAdapter = jest.fn();
        const c1 = intercept({ adapter: callerAdapter });
        expect(typeof c1.adapter).toBe('function');
        expect(c1.adapter).not.toBe(callerAdapter); // wrapped, not skipped
    });

    // Two DIFFERENT limiters use two DIFFERENT Symbols, so each only recognises
    // its own wrapper — neither skips the other (intentional, by-design nesting).
    test('each limiter recognises only its own wrapper (does not skip the other)', () => {
        const instance = axios.create();
        axiosParallelLimit(instance, { maxRequests: 5 }); // L1, registered first
        axiosParallelLimit(instance, { maxRequests: 5 }); // L2, registered second

        const handlers = (instance.interceptors.request as any).handlers;
        const interceptL1 = handlers[0].fulfilled;
        const interceptL2 = handlers[1].fulfilled;

        const transport = jest.fn();
        // First dispatch: each limiter wraps once → nested exactly twice.
        let cfg = interceptL2({ adapter: transport });
        const afterL2 = cfg.adapter;
        expect(afterL2).not.toBe(transport);

        cfg = interceptL1(cfg);
        const afterL1 = cfg.adapter;
        expect(afterL1).not.toBe(afterL2); // L1 did NOT skip L2's wrapper

        // Re-running each on its OWN wrapper is a no-op for that limiter.
        expect(interceptL1(cfg).adapter).toBe(afterL1);
    });
});

describe('idempotent wrapping — end to end', () => {
    // Edge case 2 + 4: a request re-issued through the real `instance(config)`
    // path (which goes through mergeConfig, copying `adapter` by reference) reuses
    // the single existing wrapper → exactly ONE acquire per dispatch, no nesting.
    test('re-issuing instance(config) reuses the single wrapper (one dispatch each)', async () => {
        const h = createHarness({ maxRequests: 2 });

        const p1 = outcome(h.instance.get('/x'));
        await flushUntil(() => h.controllers.length === 1, 'first attempt dispatched');
        h.controllers[0].settle(200);
        const r1 = await p1;
        expect(r1.status).toBe('fulfilled');

        // The config the adapter actually saw — its `.adapter` is now our wrapper.
        const reissued = h.controllers[0].config;
        const p2 = outcome(h.instance(reissued));
        await flushUntil(() => h.controllers.length === 2, 're-issue dispatched');
        h.controllers[1].settle(200);
        const r2 = await p2;
        expect(r2.status).toBe('fulfilled');

        // Exactly two real dispatches: one per attempt, never a nested third.
        expect(h.dispatched.length).toBe(2);
        expect(h.transport).toHaveBeenCalledTimes(2);
        expect(h.state.maxActive).toBeLessThanOrEqual(2);
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
    });

    // THE regression: an auth-style 401-retry that re-issues `instance(error.config)`.
    // Without the idempotency guard the re-issued requests are double-wrapped; each
    // holds an outer slot while awaiting an inner one, exhausting the pool so nothing
    // ever completes (the transport is never called for the retries → deadlock).
    test('a 401-retry that re-issues the same config never deadlocks the pool', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        try {
            const h = createHarness({ maxRequests: 2 });

            // Auth interceptor: on the first failure of a URL, re-issue it once.
            const retried = new Set<string>();
            h.instance.interceptors.response.use(undefined, (error) => {
                const cfg = error.config;
                if (cfg && !retried.has(cfg.url)) {
                    retried.add(cfg.url);
                    return h.instance(cfg); // re-issue with the SAME config object
                }
                return Promise.reject(error);
            });

            // Reject a parked call exactly as a real adapter does on a 401 (a custom
            // adapter must reject itself — axios only applies validateStatus in its
            // built-in adapters). error.config carries our already-wrapped adapter.
            const fail401 = (c: Controller): void =>
                c.fail(
                    new axios.AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', c.config, undefined, {
                        data: {},
                        status: 401,
                        statusText: 'Unauthorized',
                        headers: {},
                        config: c.config,
                    } as any),
                );

            // Saturate the pool: two requests, both 401 on the first attempt.
            const p1 = outcome(h.instance.get('/r1'));
            const p2 = outcome(h.instance.get('/r2'));
            await flushUntil(() => h.controllers.length === 2, 'both first attempts dispatched');
            expect(h.state.maxActive).toBe(2);

            fail401(h.controllers[0]);
            fail401(h.controllers[1]);

            // WITH the fix the two retries reuse the existing wrapper and each reaches
            // the transport (a 3rd and 4th call). WITHOUT it they nest and never do —
            // this wait throws (deadlock) instead of hanging the whole suite.
            await flushUntil(() => h.controllers.length === 4, 'both retries reached the transport');
            h.controllers[2].settle(200);
            h.controllers[3].settle(200);

            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1.status).toBe('fulfilled');
            expect(r2.status).toBe('fulfilled');

            // Cap held, every slot accounted for, pool fully drained.
            expect(h.transport).toHaveBeenCalledTimes(4);
            expect(h.state.maxActive).toBeLessThanOrEqual(2);
            await flushUntil(() => h.state.active === 0, 'pool drained');
            expect(h.state.pending).toBe(0);

            await Promise.resolve();
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    // Edge case 5 (end to end): a per-request caller adapter is still concurrency-limited.
    test('a per-request untagged adapter is concurrency-limited like any other', async () => {
        const instance = axios.create();
        const controllers: Controller[] = [];
        const callerAdapter = jest.fn((config: any) =>
            new Promise((resolve) => {
                controllers.push({
                    config,
                    settle: (status = 200, data: any = { ok: true }) =>
                        resolve({ data, status, statusText: '', headers: {}, config }),
                    fail: () => undefined,
                });
            }),
        );

        let maxActive = 0;
        axiosParallelLimit(instance, {
            maxRequests: 1,
            onActiveCountChange: (n) => {
                maxActive = Math.max(maxActive, n);
            },
        });

        // Both requests carry the SAME untagged caller adapter; the cap must hold.
        const p1 = outcome(instance.get('/a', { adapter: callerAdapter as any }));
        const p2 = outcome(instance.get('/b', { adapter: callerAdapter as any }));

        await flushUntil(() => controllers.length === 1, 'only one admitted (cap = 1)');
        expect(maxActive).toBe(1); // the 2nd is queued, not running

        controllers[0].settle(200);
        await flushUntil(() => controllers.length === 2, 'second dispatched after first frees');
        controllers[1].settle(200);

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.status).toBe('fulfilled');
        expect(r2.status).toBe('fulfilled');
        expect(callerAdapter).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1); // never exceeded the cap
    });

    // Edge case 3 (end to end): an array-of-functions adapter is resolved by the
    // wrapper AND is concurrency-limited.
    test('an array-of-functions adapter is wrapped and concurrency-limited', async () => {
        const instance = axios.create();
        const controllers: Controller[] = [];
        const transport = jest.fn((config: any) =>
            new Promise((resolve) => {
                controllers.push({
                    config,
                    settle: (status = 200, data: any = { ok: true }) =>
                        resolve({ data, status, statusText: '', headers: {}, config }),
                    fail: () => undefined,
                });
            }),
        );
        instance.defaults.adapter = [transport] as any; // array with a single function

        let maxActive = 0;
        axiosParallelLimit(instance, {
            maxRequests: 1,
            onActiveCountChange: (n) => {
                maxActive = Math.max(maxActive, n);
            },
        });

        const p1 = outcome(instance.get('/a'));
        const p2 = outcome(instance.get('/b'));
        await flushUntil(() => controllers.length === 1, 'one admitted');
        expect(maxActive).toBe(1);
        controllers[0].settle(200);
        await flushUntil(() => controllers.length === 2, 'second dispatched');
        controllers[1].settle(200);

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.status).toBe('fulfilled');
        expect(r2.status).toBe('fulfilled');
        expect(transport).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1);
    });

    // Edge case 7: stacking two limiters nests by design — each pool dispatches
    // exactly once for a single (non-reissued) request. (Stacking is unsupported;
    // this only asserts each limiter wraps once, not that stacking is safe.)
    test('stacking two limiters nests once per limiter on the first dispatch', async () => {
        const instance = axios.create();
        const controllers: Controller[] = [];
        const transport = jest.fn((config: any) =>
            new Promise((resolve) => {
                controllers.push({
                    config,
                    settle: (status = 200, data: any = { ok: true }) =>
                        resolve({ data, status, statusText: '', headers: {}, config }),
                    fail: () => undefined,
                });
            }),
        );
        instance.defaults.adapter = transport as any;

        const d1: any[] = [];
        const d2: any[] = [];
        axiosParallelLimit(instance, { maxRequests: 5, onDispatch: (i) => d1.push(i) });
        axiosParallelLimit(instance, { maxRequests: 5, onDispatch: (i) => d2.push(i) });

        const p = outcome(instance.get('/x'));
        await flushUntil(() => controllers.length === 1, 'dispatched');
        controllers[0].settle(200);
        await p;

        // Each pool acquired exactly once — no same-pool nesting on the first pass.
        expect(d1.length).toBe(1);
        expect(d2.length).toBe(1);
        expect(transport).toHaveBeenCalledTimes(1);
    });
});
