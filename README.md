# axios-parallel-limit

A lightweight Axios wrapper that limits the number of parallel requests using `p-limit`. This library allows you to control the concurrency of your HTTP requests, ensuring that your application doesn't overwhelm the server or the client.

## Installation

```bash
npm install axios-parallel-limit
```

## Usage

```typescript
import axios from 'axios';
import { axiosParallelLimit } from 'axios-parallel-limit';

// Create an Axios instance
const http = axios.create({
  baseURL: 'https://api.example.com'
});

// Apply the parallel limit
axiosParallelLimit(http, {
  maxRequests: 5, // Limit to 5 concurrent requests
  onActiveCountChange: (active) => {
    console.log(`Active requests: ${active}`);
  },
  onPendingCountChange: (pending) => {
    console.log(`Pending requests: ${pending}`);
  }
});

// Now use the axios instance as usual
// Only 5 requests will run in parallel, others will be queued
for (let i = 0; i < 20; i++) {
  http.get(`/items/${i}`).then(response => {
    console.log(`Item ${i} loaded`);
  });
}
```

## Configuration

The `axiosParallelLimit` function takes two arguments:
1. `axiosInstance`: The Axios instance to wrap.
2. `options`: An object with the following properties:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `maxRequests` | `number` | Yes | The maximum number of requests that can run simultaneously. |
| `onActiveCountChange` | `(count: number) => void` | No | Callback function invoked when the number of active requests changes. |
| `onPendingCountChange` | `(count: number) => void` | No | Callback function invoked when the number of pending (queued) requests changes. |

## How it works

This library wraps the Axios adapter to intercept the actual request execution. It uses `p-limit` to manage a queue of requests. When a request is made, it is added to the queue. If the number of active requests is below `maxRequests`, the request is executed immediately. Otherwise, it waits until a slot becomes available.

## License

MIT
