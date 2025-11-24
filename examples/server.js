import http from 'http';
import readline from 'readline';

const PORT = 3000;
let activeRequests = 0;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (query, defaultVal) => new Promise(resolve => {
    rl.question(`${query} (default: ${defaultVal}): `, answer => {
        resolve(answer.trim() || defaultVal);
    });
});

async function run() {
    console.log('--- Test Server Configuration ---');
    const mode = await ask('Delay mode? (1) Fixed, (2) Random', '2');

    let getDelay;

    if (mode === '1') {
        const delayStr = await ask('Fixed delay in ms?', '2000');
        const delay = parseInt(delayStr, 10);
        getDelay = () => delay;
        console.log(`Server starting with FIXED delay of ${delay}ms`);
    } else {
        const minStr = await ask('Min delay in ms?', '100');
        const maxStr = await ask('Max delay in ms?', '5000');
        const min = parseInt(minStr, 10);
        const max = parseInt(maxStr, 10);
        getDelay = () => Math.floor(Math.random() * (max - min)) + min;
        console.log(`Server starting with RANDOM delay between ${min}ms and ${max}ms`);
    }

    const server = http.createServer(async (req, res) => {
        activeRequests++;
        console.log(`[SERVER] Active requests: ${activeRequests}`);

        const delay = getDelay();

        await new Promise(resolve => setTimeout(resolve, delay));

        activeRequests--;
        console.log(`[SERVER] Request finished. Active requests: ${activeRequests}`);

        const timestamp = new Date().toISOString();
        const responseText = `${timestamp} ${delay}ms`;

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(responseText);
    });

    server.listen(PORT, () => {
        console.log(`Test server running at http://localhost:${PORT}`);
        // Don't close rl immediately if we want to keep process alive, 
        // but actually server.listen keeps it alive. 
        // We can close rl as we don't need input anymore.
        rl.close();
    });
}

run().catch(console.error);
