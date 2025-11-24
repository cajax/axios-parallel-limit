import axios from 'axios';
import readline from 'readline';
import { axiosParallelLimit } from '../dist/index.js';

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
    console.log('--- Axios Parallel Limit Test App ---');

    const totalRequestsStr = await ask('How many requests to queue?', '10');
    const parallelLimitStr = await ask('How many allowed in parallel?', '4');

    const totalRequests = parseInt(totalRequestsStr, 10);
    const parallelLimit = parseInt(parallelLimitStr, 10);

    console.log(`\nStarting ${totalRequests} requests with limit ${parallelLimit}...\n`);

    const http = axios.create({
        baseURL: 'http://localhost:3000'
    });

    // Let's use a shared state for logging to make it look like a status bar
    let active = 0;
    let pending = 0;

    axiosParallelLimit(http, {
        maxRequests: parallelLimit,
        onActiveCountChange: (count) => {
            active = count;
        },
        onPendingCountChange: (count) => {
            pending = count;
        }
    });

    const promises = [];
    const start = Date.now();

    for (let i = 0; i < totalRequests; i++) {
        const p = http.get('/').then(res => {
            console.log(`[REPLY ${i + 1}] ${res.data}`);
        }).catch(err => {
            console.error(`[ERROR ${i + 1}] ${err.message}`);
        });
        promises.push(p);
    }

    await Promise.all(promises);

    console.log(`\nDone! Total time: ${Date.now() - start}ms`);
    rl.close();
}

run().catch(console.error);
