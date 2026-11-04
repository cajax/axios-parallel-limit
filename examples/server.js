import http from 'http';
import readline from 'readline';

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
    <title>Axios Parallel Limit — Interactive Traffic & Concurrency Simulator</title>
    <style>
        :root {
            --bg-color: #0b1120;
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
        .container { max-width: 1140px; margin: 0 auto; }
        header {
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 12px;
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
            margin-bottom: 6px;
        }
        h1 { font-size: 1.65rem; font-weight: 700; margin-bottom: 4px; }
        .subtitle { color: var(--text-muted); font-size: 0.9rem; }
        
        .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
        @media (min-width: 900px) {
            .grid { grid-template-columns: 380px 1fr; }
        }
        
        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 18px;
            margin-bottom: 18px;
        }
        .card h2 { font-size: 1.1rem; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
        
        .form-group { margin-bottom: 12px; }
        label { display: block; font-size: 0.825rem; font-weight: 600; color: var(--text-muted); margin-bottom: 5px; }
        .label-val { float: right; color: var(--accent-blue); font-weight: 700; }
        input[type="number"], select {
            width: 100%;
            padding: 7px 10px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            background: #080d1a;
            color: white;
            font-size: 0.875rem;
        }
        input[type="range"] {
            width: 100%;
            cursor: pointer;
            accent-color: #38bdf8;
        }
        .help-text { font-size: 0.72rem; color: #64748b; margin-top: 3px; }
        
        .btn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        button {
            border: none;
            padding: 8px 12px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.15s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-stream { background: #16a34a; color: white; width: 100%; padding: 10px; font-size: 0.95rem; }
        .btn-stream.active { background: #dc2626; }
        .btn-action { background: #2563eb; color: white; flex: 1; }
        .btn-secondary { background: #334155; color: white; }
        .btn-danger { background: #b91c1c; color: white; }
        
        .stats-bar {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            margin-bottom: 16px;
        }
        @media (min-width: 600px) {
            .stats-bar { grid-template-columns: repeat(4, 1fr); }
        }
        .stat-item {
            background: #080d1a;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 10px 12px;
            text-align: center;
        }
        .stat-val { font-size: 1.5rem; font-weight: 700; line-height: 1.2; }
        .stat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }
        .val-active { color: var(--accent-blue); }
        .val-pending { color: var(--accent-amber); }
        .val-done { color: var(--accent-green); }
        .val-failed { color: var(--accent-red); }
        
        .request-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
            gap: 8px;
            max-height: 310px;
            overflow-y: auto;
            padding: 4px;
            background: #080d1a;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            margin-bottom: 16px;
        }
        .req-chip {
            background: #1e293b;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 6px 8px;
            font-size: 0.75rem;
            transition: all 0.2s ease;
        }
        .req-chip.state-queued { border-left: 4px solid var(--accent-amber); }
        .req-chip.state-active { border-left: 4px solid var(--accent-blue); background: #0c2135; box-shadow: 0 0 8px rgba(56, 189, 248, 0.2); }
        .req-chip.state-done { border-left: 4px solid var(--accent-green); opacity: 0.75; }
        .req-chip.state-timeout { border-left: 4px solid var(--accent-red); opacity: 0.65; }
        .req-chip.state-overflow { border-left: 4px solid var(--accent-purple); opacity: 0.65; }
        .req-chip.state-flushed { border-left: 4px solid #64748b; opacity: 0.5; }
        .chip-id { font-weight: 600; display: flex; justify-content: space-between; font-size: 0.78rem; }
        .chip-state { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }
        .chip-wait { font-size: 0.65rem; color: #94a3b8; margin-top: 1px; }
        
        .terminal {
            background: #050811;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 10px 12px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.78rem;
            height: 180px;
            overflow-y: auto;
            color: #cbd5e1;
        }
        .log-entry { margin-bottom: 3px; }
        .log-time { color: #64748b; margin-right: 6px; }
        .log-info { color: var(--accent-blue); }
        .log-warn { color: var(--accent-amber); }
        .log-err { color: var(--accent-red); }
        .log-success { color: var(--accent-green); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <span class="badge">Live Concurrency & Queue Simulator</span>
                <h1>axios-parallel-limit</h1>
                <p class="subtitle">Bounded work queue, concurrency limiter, and fail-fast resilience wrapper for Axios</p>
            </div>
            <div style="text-align: right;">
                <button onclick="resetAll()" class="btn-secondary" style="font-size: 0.78rem; padding: 6px 10px;">Reset Simulator</button>
            </div>
        </header>

        <div class="grid">
            <!-- Left column: Live Controls -->
            <div>
                <!-- Ingestion / Job Generation Card -->
                <div class="card">
                    <h2>Traffic Ingestion (Continuous Addition)</h2>
                    
                    <div class="form-group">
                        <label>Continuous Stream Rate: <span id="rateDisplay" class="label-val">4 jobs/sec</span></label>
                        <input type="range" id="streamRate" min="1" max="20" value="4" oninput="updateStreamRate(this.value)">
                        <div class="help-text">Controls how fast new jobs are continuously submitted into the pool.</div>
                    </div>

                    <button id="streamBtn" class="btn-stream" onclick="toggleStream()">Start Continuous Ingestion</button>

                    <div style="margin-top: 14px; border-top: 1px solid var(--border-color); padding-top: 12px;">
                        <label>Manual Job Ingestion (Click Any Time)</label>
                        <div class="btn-row">
                            <button class="btn-action" onclick="addJobs(1)">+ 1 Job</button>
                            <button class="btn-action" onclick="addJobs(5)">+ 5 Jobs</button>
                            <button class="btn-action" onclick="addJobs(15)">+ 15 Burst</button>
                        </div>
                    </div>
                </div>

                <!-- Pool & Resilience Configuration Card -->
                <div class="card">
                    <h2>Pool & Backpressure Settings</h2>

                    <div class="form-group">
                        <label>Live Concurrency Cap (maxRequests): <span id="capDisplay" class="label-val">3</span></label>
                        <input type="range" id="maxRequests" min="1" max="15" value="3" oninput="updateConcurrencyCap(this.value)">
                        <div class="help-text">Adjust dynamically mid-flight! Dispatches queued tasks immediately on scale-up.</div>
                    </div>

                    <div class="form-group">
                        <label for="serverDelay">Simulated Downstream Service Time (ms)</label>
                        <input type="number" id="serverDelay" value="400" min="50" max="4000" step="50" onchange="updateDelay(this.value)">
                        <div class="help-text">HTTP response duration per request. High service time causes queues to build up.</div>
                    </div>

                    <div class="form-group">
                        <label for="queueTimeout">Queue Timeout (ms) [0 = Off]</label>
                        <input type="number" id="queueTimeout" value="1200" min="0" step="100" placeholder="0 = infinite">
                        <div class="help-text">Max time a request waits in the queue before timing out (fail-fast).</div>
                    </div>

                    <div class="form-group">
                        <label for="maxQueueSize">Max Queue Size (maxQueueSize) [0 = Unbounded]</label>
                        <input type="number" id="maxQueueSize" value="10" min="0" placeholder="0 = unbounded">
                        <div class="help-text">Hard queue limit. Further requests shed immediately with QueueFullError.</div>
                    </div>

                    <div class="btn-row" style="margin-top: 14px;">
                        <button class="btn-danger" style="width: 100%;" onclick="flushQueue()">Emergency Flush Queue (clearQueue)</button>
                    </div>
                </div>
            </div>

            <!-- Right column: Live Visualization & Logs -->
            <div>
                <div class="stats-bar">
                    <div class="stat-item">
                        <div id="statActive" class="stat-val val-active">0</div>
                        <div class="stat-label">In-Flight (Active)</div>
                    </div>
                    <div class="stat-item">
                        <div id="statPending" class="stat-val val-pending">0</div>
                        <div class="stat-label">Queued (Pending)</div>
                    </div>
                    <div class="stat-item">
                        <div id="statDone" class="stat-val val-done">0</div>
                        <div class="stat-label">Completed</div>
                    </div>
                    <div class="stat-item">
                        <div id="statShed" class="stat-val val-failed">0</div>
                        <div class="stat-label">Shed / Timed Out</div>
                    </div>
                </div>

                <div class="card" style="margin-bottom: 16px;">
                    <h2>
                        <span>Live Jobs Pipeline</span>
                        <span id="rateIndicator" style="font-size: 0.78rem; color: var(--text-muted); font-weight: normal;">Idle</span>
                    </h2>
                    <div id="requestGrid" class="request-grid">
                        <div id="emptyHint" style="color: var(--text-muted); font-size: 0.85rem; padding: 16px; grid-column: 1 / -1; text-align: center;">
                            Start continuous ingestion or click "+ 1 Job" / "+ 5 Jobs" to submit requests.
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2>Live Callback Event Stream</h2>
                    <div id="terminal" class="terminal">
                        <div class="log-entry"><span class="log-time">[System]</span>Server ready on port ${PORT}. Ingestion simulator initialized.</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // --- Client-side Bounded Work Queue Implementation (matches @cajax/axios-parallel-limit) ---
        class ClientLimiter {
            constructor(maxConcurrency) {
                this.maxConcurrency = maxConcurrency;
                this.active = 0;
                this.queue = [];
            }

            get activeCount() { return this.active; }
            get pendingCount() { return this.queue.length; }

            setMaxConcurrency(limit) {
                this.maxConcurrency = limit;
                while (this.active < this.maxConcurrency && this.queue.length > 0) {
                    this.pullNext();
                }
            }

            clearQueue(reason) {
                const count = this.queue.length;
                if (count === 0) return 0;
                const items = this.queue.splice(0, this.queue.length);
                for (const item of items) {
                    if (item.settled) continue;
                    item.settled = true;
                    if (item.timer) clearTimeout(item.timer);
                    item.reject(reason || new Error('ERR_QUEUE_CLEARED'));
                }
                updateCounters();
                return count;
            }

            acquire(context, opts = {}) {
                if (this.active < this.maxConcurrency) {
                    this.active++;
                    updateCounters();
                    log('Job #' + context.id + ' admitted immediately into slot (' + this.active + '/' + this.maxConcurrency + ' active)', 'info');
                    return Promise.resolve(this.makeRelease());
                }

                const maxQueueSize = opts.maxQueueSize;
                if (maxQueueSize && maxQueueSize > 0 && this.queue.length >= maxQueueSize) {
                    log('Job #' + context.id + ' rejected immediately: maxQueueSize (' + maxQueueSize + ') exceeded', 'err');
                    const err = new Error('ERR_QUEUE_FULL');
                    err.name = 'QueueFullError';
                    return Promise.reject(err);
                }

                return new Promise((resolve, reject) => {
                    const item = {
                        context,
                        enqueuedAt: Date.now(),
                        settled: false,
                        resolve,
                        reject,
                        timer: null
                    };

                    const timeout = opts.queueTimeout;
                    if (timeout && timeout > 0) {
                        item.timer = setTimeout(() => {
                            if (item.settled) return;
                            item.settled = true;
                            const idx = this.queue.indexOf(item);
                            if (idx !== -1) this.queue.splice(idx, 1);
                            updateCounters();
                            const err = new Error('ERR_QUEUE_TIMEOUT');
                            err.name = 'QueueTimeoutError';
                            item.reject(err);
                        }, timeout);
                    }

                    this.queue.push(item);
                    updateCounters();
                    log('Job #' + context.id + ' queued in position ' + this.queue.length + ' (' + this.queue.length + ' pending)', 'warn');
                });
            }

            makeRelease() {
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    this.active--;
                    updateCounters();
                    this.pullNext();
                };
            }

            pullNext() {
                if (this.active >= this.maxConcurrency) return;
                const item = this.queue.shift();
                if (!item) return;

                item.settled = true;
                if (item.timer) clearTimeout(item.timer);

                this.active++;
                updateCounters();
                const waitMs = Date.now() - item.enqueuedAt;
                log('Job #' + item.context.id + ' dispatched from queue after waiting ' + waitMs + 'ms', 'info');
                item.resolve({ release: this.makeRelease(), waitMs });
            }
        }

        // --- Simulator State ---
        let currentCap = 3;
        const limiter = new ClientLimiter(currentCap);
        let jobCounter = 0;
        let completedCount = 0;
        let shedCount = 0;
        let streamTimer = null;
        let streamRate = 4;
        let serverDelayMs = 400;

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

        function updateCounters() {
            document.getElementById('statActive').textContent = limiter.activeCount;
            document.getElementById('statPending').textContent = limiter.pendingCount;
            document.getElementById('statDone').textContent = completedCount;
            document.getElementById('statShed').textContent = shedCount;
        }

        function updateConcurrencyCap(val) {
            currentCap = parseInt(val, 10);
            document.getElementById('capDisplay').textContent = currentCap;
            limiter.setMaxConcurrency(currentCap);
            log('Concurrency limit dynamically adjusted to ' + currentCap, 'info');
            updateCounters();
        }

        function updateStreamRate(val) {
            streamRate = parseInt(val, 10);
            document.getElementById('rateDisplay').textContent = streamRate + ' jobs/sec';
            if (streamTimer) {
                clearInterval(streamTimer);
                startStreamInterval();
            }
        }

        function updateDelay(val) {
            serverDelayMs = Math.max(50, parseInt(val, 10) || 400);
            log('Service delay updated to ' + serverDelayMs + 'ms', 'info');
        }

        function toggleStream() {
            const btn = document.getElementById('streamBtn');
            if (streamTimer) {
                clearInterval(streamTimer);
                streamTimer = null;
                btn.textContent = 'Start Continuous Ingestion';
                btn.className = 'btn-stream';
                document.getElementById('rateIndicator').textContent = 'Stream Paused';
                log('Continuous job ingestion stopped', 'warn');
            } else {
                startStreamInterval();
                btn.textContent = 'Stop Continuous Ingestion';
                btn.className = 'btn-stream active';
                document.getElementById('rateIndicator').textContent = 'Ingesting ~' + streamRate + ' jobs/s';
                log('Continuous job ingestion started at ' + streamRate + ' jobs/sec', 'success');
            }
        }

        function startStreamInterval() {
            const intervalMs = Math.round(1000 / streamRate);
            streamTimer = setInterval(() => {
                addJobs(1);
            }, intervalMs);
        }

        function addJobs(count) {
            const hint = document.getElementById('emptyHint');
            if (hint) hint.remove();

            for (let i = 0; i < count; i++) {
                jobCounter++;
                submitJob(jobCounter);
            }
        }

        async function submitJob(id) {
            const grid = document.getElementById('requestGrid');
            const chip = document.createElement('div');
            chip.className = 'req-chip state-queued';
            chip.id = 'chip-' + id;
            chip.innerHTML = '<div class="chip-id"><span>Job #' + id + '</span></div>' +
                             '<div class="chip-state" id="state-' + id + '">Queued</div>' +
                             '<div class="chip-wait" id="wait-' + id + '">In queue...</div>';
            grid.insertBefore(chip, grid.firstChild);

            // Cap visible chips to prevent DOM bloat
            if (grid.children.length > 60) {
                grid.removeChild(grid.lastChild);
            }

            const queueTimeout = parseInt(document.getElementById('queueTimeout').value, 10) || 0;
            const maxQueueSize = parseInt(document.getElementById('maxQueueSize').value, 10) || 0;

            const submittedAt = Date.now();
            const waitInterval = setInterval(() => {
                const waitEl = document.getElementById('wait-' + id);
                if (waitEl && chip.classList.contains('state-queued')) {
                    waitEl.textContent = 'Wait: ' + (Date.now() - submittedAt) + 'ms';
                } else {
                    clearInterval(waitInterval);
                }
            }, 80);

            try {
                const acquired = await limiter.acquire({ id }, { queueTimeout, maxQueueSize });
                clearInterval(waitInterval);

                chip.className = 'req-chip state-active';
                const stateEl = document.getElementById('state-' + id);
                const waitEl = document.getElementById('wait-' + id);
                if (stateEl) stateEl.textContent = 'In-Flight';
                if (waitEl) waitEl.textContent = 'Waited: ' + (acquired.waitMs || 0) + 'ms';

                // Perform real HTTP request to the server delay endpoint
                const startTime = Date.now();
                await fetch('/api/delay?delay=' + serverDelayMs + '&jobId=' + id);
                const duration = Date.now() - startTime;

                chip.className = 'req-chip state-done';
                if (stateEl) stateEl.textContent = 'Done (' + duration + 'ms)';
                completedCount++;
                updateCounters();
                log('Job #' + id + ' completed in ' + duration + 'ms', 'success');

                acquired.release();
            } catch (err) {
                clearInterval(waitInterval);
                shedCount++;
                updateCounters();

                const stateEl = document.getElementById('state-' + id);
                const waitEl = document.getElementById('wait-' + id);

                if (err.name === 'QueueTimeoutError') {
                    chip.className = 'req-chip state-timeout';
                    if (stateEl) stateEl.textContent = 'Timed Out';
                    if (waitEl) waitEl.textContent = 'Exceeded ' + queueTimeout + 'ms';
                    log('Job #' + id + ' shed: queueTimeout exceeded (' + (Date.now() - submittedAt) + 'ms)', 'err');
                } else if (err.name === 'QueueFullError') {
                    chip.className = 'req-chip state-overflow';
                    if (stateEl) stateEl.textContent = 'Queue Overflow';
                    if (waitEl) waitEl.textContent = 'Rejected instantly';
                } else {
                    chip.className = 'req-chip state-flushed';
                    if (stateEl) stateEl.textContent = 'Flushed';
                    if (waitEl) waitEl.textContent = 'Cancelled';
                    log('Job #' + id + ' cancelled via queue flush', 'warn');
                }
            }
        }

        function flushQueue() {
            const cleared = limiter.clearQueue(new Error('Flushed via UI'));
            if (cleared > 0) {
                log('Flush: removed and cancelled ' + cleared + ' jobs waiting in the queue', 'warn');
            } else {
                log('Flush: queue was already empty', 'info');
            }
        }

        function resetAll() {
            if (streamTimer) toggleStream();
            limiter.clearQueue(new Error('Reset'));
            jobCounter = 0;
            completedCount = 0;
            shedCount = 0;
            updateCounters();
            document.getElementById('requestGrid').innerHTML = '<div id="emptyHint" style="color: var(--text-muted); font-size: 0.85rem; padding: 16px; grid-column: 1 / -1; text-align: center;">Simulator reset. Start continuous ingestion or click "+ 1 Job" to submit requests.</div>';
            log('Simulator reset', 'info');
        }
    </script>
</body>
</html>`;
}

async function run() {
    await configureDelay();

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const accept = req.headers.accept || '';

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
