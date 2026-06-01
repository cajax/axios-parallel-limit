import axios, { AxiosInstance } from 'axios';
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import {
    axiosParallelLimit,
    QueueTimeoutError,
    QueueFullError,
    isQueueTimeoutError,
    isQueueFullError,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Test harness
//
// We install a fully controllable transport as the instance's adapter so that
// `axiosParallelLimit` wraps it. Each dispatched request parks in `controllers`
// until the test resolves/rejects it, which lets us hold slots open and drive
// the queue deterministically. The transport is a jest.fn so we can assert
// exactly how many requests reached the wire ("transport NOT called").
// ---------------------------------------------------------------------------

interface Controller {
    config: any;
    resolve: (data?: any) => void;
    reject: (err?: any) => void;
}

interface HarnessOptions {
    maxRequests: number;
    maxQueueSize?: number;
    queueTimeout?: number;
    onDispatch?: (info: any) => void;
    onQueueTimeout?: (info: any) => void;
    onQueueOverflow?: (info: any) => void;
}

interface Harness {
    instance: AxiosInstance;
    transport: ReturnType<typeof jest.fn>;
    controllers: Controller[];
    state: { active: number; pending: number };
    events: { active: number[]; pending: number[] };
    resolve: (index: number, data?: any) => void;
    reject: (index: number, err?: any) => void;
}

function createHarness(opts: HarnessOptions): Harness {
    const instance = axios.create();
    const controllers: Controller[] = [];

    const transport = jest.fn((config: any) =>
        new Promise((resolve, reject) => {
            controllers.push({
                config,
                resolve: (data: any = { ok: true }) =>
                    resolve({ data, status: 200, statusText: 'OK', headers: {}, config }),
                reject,
            });
        }),
    );

    instance.defaults.adapter = transport as any;

    const state = { active: 0, pending: 0 };
    const events = { active: [] as number[], pending: [] as number[] };

    axiosParallelLimit(instance, {
        maxRequests: opts.maxRequests,
        maxQueueSize: opts.maxQueueSize,
        queueTimeout: opts.queueTimeout,
        onActiveCountChange: (n) => {
            state.active = n;
            events.active.push(n);
        },
        onPendingCountChange: (n) => {
            state.pending = n;
            events.pending.push(n);
        },
        onDispatch: opts.onDispatch,
        onQueueTimeout: opts.onQueueTimeout,
        onQueueOverflow: opts.onQueueOverflow,
    });

    return {
        instance,
        transport,
        controllers,
        state,
        events,
        resolve: (index, data) => controllers[index].resolve(data),
        reject: (index, err) => controllers[index].reject(err),
    };
}

/** Like Promise.allSettled for a single promise; attaches a handler immediately
 *  so an expected rejection never surfaces as an unhandled rejection. */
const outcome = (p: Promise<unknown>): Promise<{ status: 'fulfilled' | 'rejected'; value?: unknown; reason?: any }> =>
    p.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
    );

/** Drain the microtask queue until `cond` holds (no fake-timer advance). */
async function flushUntil(cond: () => boolean, label = 'condition'): Promise<void> {
    for (let i = 0; i < 500; i++) {
        if (cond()) return;
        await Promise.resolve();
    }
    throw new Error(`flushUntil: ${label} was never met`);
}

afterEach(() => {
    jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('typed queue errors', () => {
    const config = { url: '/x', method: 'get' } as any;

    test('QueueTimeoutError carries a stable discriminant, message and config', () => {
        const err = new QueueTimeoutError(config);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(QueueTimeoutError);
        expect(err.name).toBe('QueueTimeoutError');
        expect(err.code).toBe('ERR_QUEUE_TIMEOUT');
        expect(err.config).toBe(config);
        expect(err.message).toMatch(/queue/i);
        expect(axios.isAxiosError(err)).toBe(false);
    });

    test('QueueFullError carries a stable discriminant, message and config', () => {
        const err = new QueueFullError(config);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(QueueFullError);
        expect(err.name).toBe('QueueFullError');
        expect(err.code).toBe('ERR_QUEUE_FULL');
        expect(err.config).toBe(config);
        expect(err.message).toMatch(/queue/i);
        expect(axios.isAxiosError(err)).toBe(false);
    });

    test('type guards discriminate the two queue errors from each other and from generic errors', () => {
        const timeout = new QueueTimeoutError(config);
        const full = new QueueFullError(config);

        expect(isQueueTimeoutError(timeout)).toBe(true);
        expect(isQueueTimeoutError(full)).toBe(false);
        expect(isQueueTimeoutError(new Error('nope'))).toBe(false);
        expect(isQueueTimeoutError(null)).toBe(false);
        expect(isQueueTimeoutError(undefined)).toBe(false);

        expect(isQueueFullError(full)).toBe(true);
        expect(isQueueFullError(timeout)).toBe(false);
        expect(isQueueFullError(new Error('nope'))).toBe(false);
        expect(isQueueFullError({})).toBe(false);
    });
});

describe('default behavior (no new options)', () => {
    test('reproduces the active/pending transition model for a simple queued workload', async () => {
        const h = createHarness({ maxRequests: 1 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A admitted');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        // A admitted immediately, B queued behind it.
        expect(h.events.active).toEqual([1]);
        expect(h.events.pending).toEqual([1]);
        expect(h.transport.mock.calls.length).toBe(1);

        // Free A → B is dispatched from the queue.
        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2, 'B dispatched');
        h.resolve(1);
        await Promise.all([pA, pB]);

        // active: admit A(1), release A(0), dispatch B(1), release B(0)
        expect(h.events.active).toEqual([1, 0, 1, 0]);
        // pending: enqueue B(1), dispatch B(0)
        expect(h.events.pending).toEqual([1, 0]);
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
    });
});

describe('queueTimeout', () => {
    test('a request with an immediately available slot is never subject to queueTimeout', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 2, queueTimeout: 100 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        // No queue timer armed for an immediately-admitted request.
        expect(jest.getTimerCount()).toBe(0);

        // Advance far past queueTimeout while A is still in-flight: it must not be touched.
        await jest.advanceTimersByTimeAsync(1000);
        expect(h.transport.mock.calls.length).toBe(1);

        h.resolve(0);
        const res = await pA;
        expect(res.status).toBe('fulfilled');
        expect(h.state.active).toBe(0);
    });

    test('a request dispatched before queueTimeout succeeds and its timer is cleared', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, queueTimeout: 1000 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');
        expect(jest.getTimerCount()).toBe(1); // B's queue-timeout timer is armed

        await jest.advanceTimersByTimeAsync(300); // still under the 1000ms budget
        h.resolve(0); // free the slot → B dispatched
        await flushUntil(() => h.transport.mock.calls.length === 2, 'B dispatched');

        // Dispatching B clears its queue-timeout timer.
        expect(jest.getTimerCount()).toBe(0);

        // Even far past the original deadline, B keeps running (timeout covers queue-wait only).
        await jest.advanceTimersByTimeAsync(5000);
        h.resolve(1);
        const [rA, rB] = await Promise.all([pA, pB]);
        expect(rA.status).toBe('fulfilled');
        expect(rB.status).toBe('fulfilled');
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
    });

    test('a request that waits past queueTimeout rejects, never reaches transport, and leaves active unchanged', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, queueTimeout: 1000 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        const activeEventsBefore = h.events.active.length;

        await jest.advanceTimersByTimeAsync(1000);
        const rB = await pB;

        expect(rB.status).toBe('rejected');
        expect(isQueueTimeoutError(rB.reason)).toBe(true);
        // Transport only ever saw A.
        expect(h.transport.mock.calls.length).toBe(1);
        // pending-- fired and returned to 0; active was never touched by the timeout.
        expect(h.state.pending).toBe(0);
        expect(h.state.active).toBe(1);
        expect(h.events.active.length).toBe(activeEventsBefore);
        expect(jest.getTimerCount()).toBe(0); // timer cleared on timeout

        h.resolve(0);
        const rA = await pA;
        expect(rA.status).toBe('fulfilled');
        expect(h.state.active).toBe(0);
    });

    test('a per-request queueTimeout overrides the instance-level value', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, queueTimeout: 10000 }); // generous instance default

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');

        const pB = outcome(h.instance.get('/b', { queueTimeout: 200 } as any));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        await jest.advanceTimersByTimeAsync(200); // hits the per-request budget, not the instance one
        const rB = await pB;
        expect(rB.status).toBe('rejected');
        expect(isQueueTimeoutError(rB.reason)).toBe(true);

        h.resolve(0);
        await pA;
        expect(h.state.active).toBe(0);
    });
});

describe('maxQueueSize', () => {
    test('overflow rejects immediately with QueueFullError, fires no count callback, and leaves queued items intact', async () => {
        const h = createHarness({ maxRequests: 1, maxQueueSize: 1 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued (queue now full)');

        const activeEvents = h.events.active.length;
        const pendingEvents = h.events.pending.length;

        // C overflows: queue already holds 1 (== maxQueueSize).
        const rC = await outcome(h.instance.get('/c'));
        expect(rC.status).toBe('rejected');
        expect(isQueueFullError(rC.reason)).toBe(true);

        // No count callback fired for the overflow-rejected request.
        expect(h.events.active.length).toBe(activeEvents);
        expect(h.events.pending.length).toBe(pendingEvents);
        // Already-queued B is unaffected; transport only saw A.
        expect(h.state.pending).toBe(1);
        expect(h.transport.mock.calls.length).toBe(1);

        // B still drains normally once A frees the slot.
        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2, 'B dispatched');
        h.resolve(1);
        const [rA, rB] = await Promise.all([pA, pB]);
        expect(rA.status).toBe('fulfilled');
        expect(rB.status).toBe('fulfilled');
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
    });
});

describe('invariants under load', () => {
    test('active never exceeds maxRequests even when many queued requests time out simultaneously', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 2, queueTimeout: 500 });

        const results = [];
        for (let i = 0; i < 10; i++) {
            results.push(outcome(h.instance.get('/r' + i)));
        }
        await flushUntil(() => h.transport.mock.calls.length === 2 && h.state.pending === 8, 'saturated');

        expect(Math.max(...h.events.active)).toBe(2);

        // All 8 queued requests hit their deadline on the same tick.
        await jest.advanceTimersByTimeAsync(500);

        expect(h.state.pending).toBe(0);
        expect(h.state.active).toBe(2); // the two genuinely in-flight are untouched
        expect(Math.max(...h.events.active)).toBe(2); // cap never breached
        expect(h.transport.mock.calls.length).toBe(2); // only the admitted two reached transport

        h.resolve(0);
        h.resolve(1);
        const settled = await Promise.all(results);
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(rejected.length).toBe(8);
        expect(rejected.every((r) => isQueueTimeoutError(r.reason))).toBe(true);

        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('mixed workload (immediate, dispatched, timeout, overflow, cancel) keeps counters and callbacks exact', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, maxQueueSize: 3, queueTimeout: 1000 });

        // A: admitted immediately.
        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A admitted');
        // B, C queued.
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');
        const pC = outcome(h.instance.get('/c'));
        await flushUntil(() => h.state.pending === 2, 'C queued');
        // E queued (abortable) — fills the queue to maxQueueSize (3).
        const controllerE = new AbortController();
        const pE = outcome(h.instance.get('/e', { signal: controllerE.signal }));
        await flushUntil(() => h.state.pending === 3, 'E queued');

        // D overflows (queue is full) — must not touch any counter.
        const rD = await outcome(h.instance.get('/d'));
        expect(rD.status).toBe('rejected');
        expect(isQueueFullError(rD.reason)).toBe(true);

        // Free A → B dispatched from the queue (success-from-queue path).
        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2 && h.state.pending === 2, 'B dispatched');

        // Cancel E while it waits (middle of the queue).
        controllerE.abort();
        await flushUntil(() => h.state.pending === 1, 'E cancelled');
        expect(jest.getTimerCount()).toBe(1); // only C's timer remains armed

        // C times out.
        await jest.advanceTimersByTimeAsync(1000);
        await flushUntil(() => h.state.pending === 0, 'C timed out');

        // Finish B.
        h.resolve(1);

        const [rA, rB, rC, rE] = await Promise.all([pA, pB, pC, pE]);
        expect(rA.status).toBe('fulfilled');
        expect(rB.status).toBe('fulfilled');
        expect(rC.status).toBe('rejected');
        expect(isQueueTimeoutError(rC.reason)).toBe(true);
        expect(rE.status).toBe('rejected');
        expect(axios.isCancel(rE.reason)).toBe(true);

        // Exact transition sequences:
        // active: admit A(1), release A(0), dispatch B(1), release B(0)
        expect(h.events.active).toEqual([1, 0, 1, 0]);
        // pending: B(1), C(2), E(3), dispatch B(2), cancel E(1), timeout C(0)
        expect(h.events.pending).toEqual([1, 2, 3, 2, 1, 0]);

        // Only A and B reached transport.
        expect(h.transport.mock.calls.length).toBe(2);
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
        expect(jest.getTimerCount()).toBe(0); // no leaked timers
    });

    test('timeout and dispatch scheduled on the same tick resolve to exactly one outcome', async () => {
        jest.useFakeTimers();
        const dispatched: any[] = [];
        const timedOut: any[] = [];
        const h = createHarness({
            maxRequests: 1,
            queueTimeout: 1000,
            onDispatch: (i) => dispatched.push(i),
            onQueueTimeout: (i) => timedOut.push(i),
        });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        // Arrange for A to settle on the very tick B's queue-timeout fires.
        setTimeout(() => h.resolve(0), 1000);

        await jest.advanceTimersByTimeAsync(1000);
        await pA; // A is released on this tick either way

        const bTimedOut = timedOut.filter((i) => i.config.url === '/b').length;
        const bDispatched = dispatched.filter((i) => i.config.url === '/b').length;

        // Exactly one transition acted on B — never both, never neither.
        expect(bTimedOut + bDispatched).toBe(1);

        if (bDispatched === 1) {
            // Dispatch won: B is in-flight; finish it so it can settle.
            h.resolve(1);
            const rB = await pB;
            expect(rB.status).toBe('fulfilled');
            expect(h.transport.mock.calls.length).toBe(2);
        } else {
            // Timeout won: B already rejected, transport never saw it.
            const rB = await pB;
            expect(rB.status).toBe('rejected');
            expect(isQueueTimeoutError(rB.reason)).toBe(true);
            expect(h.transport.mock.calls.length).toBe(1);
        }

        // Whichever path won, the system is consistent and leak-free afterwards.
        await flushUntil(() => h.state.active === 0, 'drained');
        expect(h.state.pending).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('no timers or handles remain after a mixed batch settles', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, queueTimeout: 300 });

        const pImmediate = outcome(h.instance.get('/immediate'));
        await flushUntil(() => h.state.active === 1, 'immediate running');
        const pQueued = outcome(h.instance.get('/queued'));
        const pTimedOut = outcome(h.instance.get('/timeout'));
        await flushUntil(() => h.state.pending === 2, 'two queued');
        expect(jest.getTimerCount()).toBe(2); // one queue-timeout timer per queued request

        // Free the slot → the first queued item ('/queued') is dispatched, its timer cleared.
        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2 && h.state.pending === 1, 'queued dispatched');

        // The remaining queued item ('/timeout') exceeds its deadline.
        await jest.advanceTimersByTimeAsync(300);
        await flushUntil(() => h.state.pending === 0, 'queue drained');

        // Finish the dispatched item (transport call index 1).
        h.resolve(1);
        await flushUntil(() => h.state.active === 0, 'all settled');

        const [rImmediate, rQueued, rTimedOut] = await Promise.all([pImmediate, pQueued, pTimedOut]);
        expect(rImmediate.status).toBe('fulfilled');
        expect(rQueued.status).toBe('fulfilled');
        expect(rTimedOut.status).toBe('rejected');
        expect(isQueueTimeoutError(rTimedOut.reason)).toBe(true);

        expect(jest.getTimerCount()).toBe(0);
        expect(h.state.active).toBe(0);
        expect(h.state.pending).toBe(0);
    });
});

describe('cancellation while queued', () => {
    test('aborting an AbortSignal removes the queued request, fires pending--, rejects as a cancel, and clears its timer', async () => {
        jest.useFakeTimers();
        const h = createHarness({ maxRequests: 1, queueTimeout: 1000 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');

        const controller = new AbortController();
        const pB = outcome(h.instance.get('/b', { signal: controller.signal }));
        await flushUntil(() => h.state.pending === 1, 'B queued');
        expect(jest.getTimerCount()).toBe(1);

        const activeEventsBefore = h.events.active.length;
        controller.abort();
        const rB = await pB;

        expect(rB.status).toBe('rejected');
        expect(axios.isCancel(rB.reason)).toBe(true);
        expect(h.state.pending).toBe(0); // pending-- fired
        expect(h.state.active).toBe(1); // active untouched
        expect(h.events.active.length).toBe(activeEventsBefore);
        expect(h.transport.mock.calls.length).toBe(1); // B never dispatched
        expect(jest.getTimerCount()).toBe(0); // queue-timeout timer cleared

        // Advancing past the original deadline must not double-settle anything.
        await jest.advanceTimersByTimeAsync(2000);
        expect(h.state.pending).toBe(0);

        h.resolve(0);
        await pA;
        expect(h.state.active).toBe(0);
    });

    test('cancelling via an Axios CancelToken removes the queued request and rejects as a cancel', async () => {
        const h = createHarness({ maxRequests: 1 });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');

        const source = axios.CancelToken.source();
        const pB = outcome(h.instance.get('/b', { cancelToken: source.token }));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        source.cancel('caller went away');
        const rB = await pB;

        expect(rB.status).toBe('rejected');
        expect(axios.isCancel(rB.reason)).toBe(true);
        expect(h.state.pending).toBe(0);
        expect(h.state.active).toBe(1);
        expect(h.transport.mock.calls.length).toBe(1);

        h.resolve(0);
        await pA;
        expect(h.state.active).toBe(0);
    });
});

describe('observability callbacks', () => {
    test('onDispatch reports queue-wait latency (0 for immediate, elapsed for dispatched)', async () => {
        jest.useFakeTimers();
        const dispatched: any[] = [];
        const h = createHarness({ maxRequests: 1, onDispatch: (i) => dispatched.push(i) });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        expect(dispatched.length).toBe(1);
        expect(dispatched[0].config.url).toBe('/a');
        expect(dispatched[0].waitMs).toBe(0); // got a slot immediately

        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');
        await jest.advanceTimersByTimeAsync(420);
        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2, 'B dispatched');

        expect(dispatched.length).toBe(2);
        expect(dispatched[1].config.url).toBe('/b');
        expect(dispatched[1].waitMs).toBe(420); // waited 420ms in the queue

        h.resolve(1);
        await Promise.all([pA, pB]);
    });

    test('onQueueOverflow fires with the offending config and the queue size at rejection', async () => {
        const overflows: any[] = [];
        const h = createHarness({ maxRequests: 1, maxQueueSize: 1, onQueueOverflow: (i) => overflows.push(i) });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued (full)');

        const rC = await outcome(h.instance.get('/c'));
        expect(rC.status).toBe('rejected');

        expect(overflows.length).toBe(1);
        expect(overflows[0].config.url).toBe('/c');
        expect(overflows[0].queueSize).toBe(1); // queue was full at size 1 when C was rejected

        h.resolve(0);
        await flushUntil(() => h.transport.mock.calls.length === 2, 'B dispatched');
        h.resolve(1);
        await Promise.all([pA, pB]);
    });

    test('onQueueTimeout fires with the offending config and the time waited', async () => {
        jest.useFakeTimers();
        const timeouts: any[] = [];
        const h = createHarness({ maxRequests: 1, queueTimeout: 750, onQueueTimeout: (i) => timeouts.push(i) });

        const pA = outcome(h.instance.get('/a'));
        await flushUntil(() => h.state.active === 1, 'A running');
        const pB = outcome(h.instance.get('/b'));
        await flushUntil(() => h.state.pending === 1, 'B queued');

        await jest.advanceTimersByTimeAsync(750);
        await pB;

        expect(timeouts.length).toBe(1);
        expect(timeouts[0].config.url).toBe('/b');
        expect(timeouts[0].waitMs).toBe(750);

        h.resolve(0);
        await pA;
    });
});
