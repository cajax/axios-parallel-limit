import http from 'http';
import readline from 'readline';
import axios from 'axios';
import { axiosParallelLimit, isQueueTimeoutError, isQueueFullError } from '../dist/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
let activeRequests = 0;
let totalRequestsServed = 0;

let getDelay = () => Math.floor(Math.random() * (1000 - 100)) + 100;
let delayConfigDescription = 'RANDOM delay between 100ms and 1000ms';

const ask = (rl, query, defaultVal) => new Promise(resolve => {
    if (!process.stdin.isTTY) {
        return resolve(defaultVal);
    }
    rl.question(`${query} (default: ${defaultVal}): `, answer => {
        resolve(answer.trim() || defaultVal);
    });
});

async function configureDelay() {
    if (!process.stdin.isTTY) {
        console.log(`Server starting with default ${delayConfigDescription}`);
        return;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        console.log('--- Test Server Configuration ---');
        const mode = await ask(rl, 'Delay mode? (1) Fixed, (2) Random', '2');

        if (mode === '1') {
            const delayStr = await ask(rl, 'Fixed delay in ms?', '2000');
            const delay = parseInt(delayStr, 10) || 2000;
            getDelay = () => delay;
            delayConfigDescription = `FIXED delay of ${delay}ms`;
            console.log(`Server starting with ${delayConfigDescription}`);
        } else {
            const minStr = await ask(rl, 'Min delay in ms?', '100');
            const maxStr = await ask(rl, 'Max delay in ms?', '1000');
            const min = parseInt(minStr, 10) || 100;
            const max = parseInt(maxStr, 10) || 1000;
            getDelay = () => Math.floor(Math.random() * (max - min)) + min;
            delayConfigDescription = `RANDOM delay between ${min}ms and ${max}ms`;
            console.log(`Server starting with ${delayConfigDescription}`);
        }
    } finally {
        rl.close();
    }
}

function renderHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Axios Parallel Limit — Interactive Demo</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --border-color: #334155;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent-blue: #38bdf8;
            --accent-green: #4ade80;
            --accent-amber: #fbbf24;
            --accent-red: #f87171;
            --accent-purple: #c084fc;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            line-height: 1.5;
            padding: 24px 16px;
        }
        .container { max-width: 1040px; margin: 0 auto; }
        header {
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
        }
        .badge {
            display: inline-block;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            padding: 3px 8px;
            border-radius: 4px;
            background: #0284c7;
            color: white;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }
        h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 6px; }
        .subtitle { color: var(--text-muted); font-size: 0.95rem; }
        
        .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
        @media (min-width: 860px) {
            .grid { grid-template-columns: 360px 1fr; }
        }
        
        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
        }
        .card h2 { font-size: 1.15rem; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
        
        .form-group { margin-bottom: 14px; }
        label { display: block; font-size: 0.825rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
        input, select {
            width: 100%;
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            background: #0b1120;
            color: white;
            font-size: 0.9rem;
        }
        input:focus, select:focus { outline: none; border-color: var(--accent-blue); }
        .help-text { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
        
        button.btn-primary {
            width: 100%;
            background: #2563eb;
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            transition: background 0.15s ease;
            margin-top: 8px;
        }
        button.btn-primary:hover { background: #1d4ed8; }
        button.btn-primary:disabled { background: #475569; cursor: not-allowed; }
        
        .stats-bar {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        @media (min-width: 600px) {
            .stats-bar { grid-template-columns: repeat(4, 1fr); }
        }
        .stat-item {
            background: #0b1120;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            text-align: center;
        }
        .stat-val { font-size: 1.5rem; font-weight: 700; line-height: 1.2; }
        .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 4px; }
        .val-active { color: var(--accent-blue); }
        .val-pending { color: var(--accent-amber); }
        .val-done { color: var(--accent-green); }
        .val-failed { color: var(--accent-red); }
        
        .request-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
            gap: 10px;
            max-height: 280px;
            overflow-y: auto;
            padding-right: 4px;
            margin-bottom: 20px;
        }
        .req-chip {
            background: #0b1120;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 0.75rem;
            transition: all 0.2s ease;
        }
        .req-chip.state-queued { border-left: 4px solid var(--accent-amber); }
        .req-chip.state-active { border-left: 4px solid var(--accent-blue); background: #0c2135; }
        .req-chip.state-done { border-left: 4px solid var(--accent-green); }
        .req-chip.state-timeout { border-left: 4px solid var(--accent-red); opacity: 0.8; }
        .req-chip.state-overflow { border-left: 4px solid var(--accent-purple); opacity: 0.8; }
        .chip-id { font-weight: 600; display: flex; justify-content: space-between; }
        .chip-state { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }
        .chip-wait { font-size: 0.65rem; color: #64748b; }
        
        .terminal {
            background: #090d16;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.8rem;
            height: 180px;
            overflow-y: auto;
            color: #cbd5e1;
        }
        .log-entry { margin-bottom: 3px; }
        .log-time { color: #64748b; margin-right: 8px; }
        .log-info { color: var(--accent-blue); }
        .log-warn { color: var(--accent-amber); }
        .log-err { color: var(--accent-red); }
        .log-success { color: var(--accent-green); }
        
        .code-box {
            background: #090d16;
            padding: 10px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 0.8rem;
            color: #e2e8f0;
            overflow-x: auto;
            margin-top: 10px;
            border: 1px solid var(--border-color);
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <span class="badge">Axios Concurrency Control</span>
            <h1>axios-parallel-limit</h1>
            <p class="subtitle">Bounded work queue, concurrency limiter, and fail-fast resilience wrapper for Axios</p>
        </header>

        <div class="grid">
            <!-- Left column: Configuration -->
            <div class="card">
                <h2>Simulation Options</h2>
                
                <div class="form-group">
                    <label for="totalRequests">Total Requests to Send</label>
                    <input type="number" id="totalRequests" value="12" min="1" max="100">
                    <div class="help-text">Number of parallel requests to fire simultaneously.</div>
                </div>

                <div class="form-group">
                    <label for="maxRequests">Max Concurrency (maxRequests)</label>
                    <input type="number" id="maxRequests" value="3" min="1" max="20">
                    <div class="help-text">At most this many run in-flight; others queue.</div>
                </div>

                <div class="form-group">
                    <label for="queueTimeout">Queue Timeout (ms) [Optional]</label>
                    <input type="number" id="queueTimeout" value="0" min="0" placeholder="0 = disabled">
                    <div class="help-text">Max time a request waits in queue before fail-fast timeout.</div>
                </div>

                <div class="form-group">
                    <label for="maxQueueSize">Max Queue Size [Optional]</label>
                    <input type="number" id="maxQueueSize" value="0" min="0" placeholder="0 = unbounded">
                    <div class="help-text">Upper limit on queue depth. Overflows reject immediately.</div>
                </div>

                <div class="form-group">
                    <label for="delayMs">Simulated Server Delay (ms)</label>
                    <input type="number" id="delayMs" value="500" min="50" max="5000">
                    <div class="help-text">Artificial delay for each HTTP request.</div>
                </div>

                <button id="runBtn" class="btn-primary" onclick="runSimulation()">Run Concurrency Test</button>
                
                <div style="margin-top: 24px; border-top: 1px solid var(--border-color); padding-top: 16px;">
                    <div style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px;">Terminal CLI Example:</div>
                    <div class="code-box">node examples/client.js</div>
                    <div class="help-text" style="margin-top:6px;">Sends requests against this server with interactive prompts.</div>
                </div>
            </div>

            <!-- Right column: Live Visualization -->
            <div>
                <div class="stats-bar">
                    <div class="stat-item">
                        <div id="statActive" class="stat-val val-active">0</div>
                        <div class="stat-label">Active (In-Flight)</div>
                    </div>
                    <div class="stat-item">
                        <div id="statPending" class="stat-val val-pending">0</div>
                        <div class="stat-label">Pending (Queued)</div>
                    </div>
                    <div class="stat-item">
                        <div id="statDone" class="stat-val val-done">0</div>
                        <div class="stat-label">Completed</div>
                    </div>
                    <div class="stat-item">
                        <div id="statFailed" class="stat-val val-failed">0</div>
                        <div class="stat-label">Timed Out / Dropped</div>
                    </div>
                </div>

                <div class="card" style="margin-bottom: 20px;">
                    <h2>
                        <span>Request Statuses</span>
                        <span id="elapsedDisplay" style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;"></span>
                    </h2>
                    <div id="requestGrid" class="request-grid">
                        <div style="color: var(--text-muted); font-size: 0.85rem; padding: 12px; grid-column: 1 / -1;">
                            Click "Run Concurrency Test" to view request batch lifecycle.
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2>Live Event Log</h2>
                    <div id="terminal" class="terminal">
                        <div class="log-entry"><span class="log-time">[System]</span>Server ready on port ${PORT}</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        function log(msg, type = 'info') {
            const term = document.getElementById('terminal');
            const now = new Date().toTimeString().split(' ')[0];
            const div = document.createElement('div');
            div.className = 'log-entry';
            let spanClass = 'log-info';
            if (type === 'warn') spanClass = 'log-warn';
            if (type === 'err') spanClass = 'log-err';
            if (type === 'success') spanClass = 'log-success';
            div.innerHTML = '<span class="log-time">[' + now + ']</span> <span class="' + spanClass + '">' + msg + '</span>';
            term.appendChild(div);
            term.scrollTop = term.scrollHeight;
        }

        async function runSimulation() {
            const btn = document.getElementById('runBtn');
            const total = parseInt(document.getElementById('totalRequests').value, 10) || 10;
            const max = parseInt(document.getElementById('maxRequests').value, 10) || 3;
            const queueTimeout = parseInt(document.getElementById('queueTimeout').value, 10) || 0;
            const maxQueueSize = parseInt(document.getElementById('maxQueueSize').value, 10) || 0;
            const delayMs = parseInt(document.getElementById('delayMs').value, 10) || 500;

            btn.disabled = true;
            btn.textContent = 'Simulating...';

            const grid = document.getElementById('requestGrid');
            grid.innerHTML = '';
            
            // Build chips
            const chips = {};
            for (let i = 1; i <= total; i++) {
                const chip = document.createElement('div');
                chip.className = 'req-chip state-queued';
                chip.id = 'chip-' + i;
                chip.innerHTML = '<div class="chip-id"><span>Req #' + i + '</span></div><div class="chip-state" id="state-' + i + '">Queued</div><div class="chip-wait" id="wait-' + i + '">Waiting...</div>';
                grid.appendChild(chip);
                chips[i] = chip;
            }

            document.getElementById('statActive').textContent = '0';
            document.getElementById('statPending').textContent = total.toString();
            document.getElementById('statDone').textContent = '0';
            document.getElementById('statFailed').textContent = '0';

            log('Starting simulation: ' + total + ' requests (maxRequests: ' + max + ', queueTimeout: ' + (queueTimeout || 'none') + ', maxQueueSize: ' + (maxQueueSize || 'unbounded') + ')');

            const startTime = Date.now();
            const timer = setInterval(() => {
                document.getElementById('elapsedDisplay').textContent = 'Elapsed: ' + Math.round((Date.now() - startTime) / 100) / 10 + 's';
            }, 100);

            try {
                const response = await fetch('/api/run-simulation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        totalRequests: total,
                        maxRequests: max,
                        queueTimeout: queueTimeout || undefined,
                        maxQueueSize: maxQueueSize || undefined,
                        delayMs: delayMs
                    })
                });

                const data = await response.json();
                clearInterval(timer);

                if (data.events) {
                    for (const ev of data.events) {
                        if (ev.type === 'activeCount') {
                            document.getElementById('statActive').textContent = ev.count;
                        } else if (ev.type === 'pendingCount') {
                            document.getElementById('statPending').textContent = ev.count;
                        } else if (ev.type === 'dispatch') {
                            const c = chips[ev.reqId];
                            if (c) {
                                c.className = 'req-chip state-active';
                                document.getElementById('state-' + ev.reqId).textContent = 'In Flight';
                                document.getElementById('wait-' + ev.reqId).textContent = 'Waited: ' + ev.waitMs + 'ms';
                            }
                            log('Req #' + ev.reqId + ' dispatched after ' + ev.waitMs + 'ms queue wait');
                        } else if (ev.type === 'timeout') {
                            const c = chips[ev.reqId];
                            if (c) {
                                c.className = 'req-chip state-timeout';
                                document.getElementById('state-' + ev.reqId).textContent = 'Queue Timeout';
                                document.getElementById('wait-' + ev.reqId).textContent = 'Waited ' + ev.waitMs + 'ms';
                            }
                            log('Req #' + ev.reqId + ' timed out in queue after ' + ev.waitMs + 'ms', 'err');
                        } else if (ev.type === 'overflow') {
                            const c = chips[ev.reqId];
                            if (c) {
                                c.className = 'req-chip state-overflow';
                                document.getElementById('state-' + ev.reqId).textContent = 'Queue Overflow';
                                document.getElementById('wait-' + ev.reqId).textContent = 'Rejected immediately';
                            }
                            log('Req #' + ev.reqId + ' rejected: maxQueueSize reached', 'err');
                        } else if (ev.type === 'completed') {
                            const c = chips[ev.reqId];
                            if (c) {
                                c.className = 'req-chip state-done';
                                document.getElementById('state-' + ev.reqId).textContent = 'Done (' + ev.duration + 'ms)';
                            }
                        }
                    }
                }

                // Final stats
                document.getElementById('statActive').textContent = '0';
                document.getElementById('statPending').textContent = '0';
                document.getElementById('statDone').textContent = data.summary.succeeded;
                document.getElementById('statFailed').textContent = data.summary.timedOut + data.summary.overflowed;

                log('Finished all ' + total + ' requests in ' + data.summary.totalElapsedMs + 'ms. (Succeeded: ' + data.summary.succeeded + ', TimedOut: ' + data.summary.timedOut + ', Overflow: ' + data.summary.overflowed + ')', 'success');
            } catch (err) {
                clearInterval(timer);
                log('Simulation error: ' + err.message, 'err');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Run Concurrency Test';
            }
        }
    </script>
</body>
</html>`;
}

// Executes a batch simulation using the actual axiosParallelLimit library
async function handleRunSimulation(req, res) {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
        let params;
        try {
            params = JSON.parse(bodyStr || '{}');
        } catch {
            params = {};
        }

        const totalRequests = Math.min(Math.max(params.totalRequests || 10, 1), 100);
        const maxRequests = Math.min(Math.max(params.maxRequests || 3, 1), 50);
        const queueTimeout = params.queueTimeout && params.queueTimeout > 0 ? params.queueTimeout : undefined;
        const maxQueueSize = params.maxQueueSize && params.maxQueueSize > 0 ? params.maxQueueSize : undefined;
        const delayMs = params.delayMs || 300;

        const events = [];
        let reqCounter = 0;

        const http = axios.create({
            baseURL: `http://127.0.0.1:${PORT}`,
            timeout: 15000,
        });

        axiosParallelLimit(http, {
            maxRequests,
            maxQueueSize,
            queueTimeout,
            onActiveCountChange: (count) => {
                events.push({ type: 'activeCount', count, time: Date.now() });
            },
            onPendingCountChange: (count) => {
                events.push({ type: 'pendingCount', count, time: Date.now() });
            },
            onDispatch: ({ config, waitMs }) => {
                const reqId = config?.metadata?.reqId;
                events.push({ type: 'dispatch', reqId, waitMs, time: Date.now() });
            },
            onQueueTimeout: ({ config, waitMs }) => {
                const reqId = config?.metadata?.reqId;
                events.push({ type: 'timeout', reqId, waitMs, time: Date.now() });
            },
            onQueueOverflow: ({ config }) => {
                const reqId = config?.metadata?.reqId;
                events.push({ type: 'overflow', reqId, time: Date.now() });
            },
        });

        const start = Date.now();
        const promises = [];
        let succeeded = 0;
        let timedOut = 0;
        let overflowed = 0;

        for (let i = 1; i <= totalRequests; i++) {
            const reqId = i;
            const p = http.get(`/api/delay?delay=${delayMs}&reqId=${reqId}`, {
                metadata: { reqId },
            }).then(response => {
                succeeded++;
                events.push({ type: 'completed', reqId, duration: delayMs, time: Date.now() });
            }).catch(err => {
                if (isQueueTimeoutError(err)) {
                    timedOut++;
                } else if (isQueueFullError(err)) {
                    overflowed++;
                } else {
                    events.push({ type: 'error', reqId, error: err.message, time: Date.now() });
                }
            });
            promises.push(p);
        }

        await Promise.all(promises);
        const totalElapsedMs = Date.now() - start;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            events,
            summary: {
                totalRequests,
                maxRequests,
                succeeded,
                timedOut,
                overflowed,
                totalElapsedMs
            }
        }));
    });
}

async function run() {
    await configureDelay();

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const accept = req.headers.accept || '';

        // API simulation runner
        if (req.method === 'POST' && url.pathname === '/api/run-simulation') {
            return handleRunSimulation(req, res);
        }

        // Web Dashboard if accessed by browser
        const isHtmlRequest = accept.includes('text/html') && !accept.includes('application/json');
        if (req.method === 'GET' && url.pathname === '/' && isHtmlRequest) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(renderHtml());
        }

        // Server status endpoint
        if (req.method === 'GET' && url.pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                activeRequests,
                totalRequestsServed,
                delayConfig: delayConfigDescription,
                uptime: process.uptime()
            }));
        }

        // Default or /api/delay: Original test endpoint behavior
        activeRequests++;
        totalRequestsServed++;
        console.log(`[SERVER] Active requests: ${activeRequests}`);

        const requestedDelay = parseInt(url.searchParams.get('delay'), 10);
        const delay = !isNaN(requestedDelay) && requestedDelay >= 0 ? requestedDelay : getDelay();

        await new Promise(resolve => setTimeout(resolve, delay));

        activeRequests--;
        console.log(`[SERVER] Request finished. Active requests: ${activeRequests}`);

        const timestamp = new Date().toISOString();
        const responseText = `${timestamp} ${delay}ms`;

        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(responseText);
    });

    server.listen(PORT, HOST, () => {
        console.log(`Test server running at http://${HOST}:${PORT}`);
    });
}

run().catch(console.error);
