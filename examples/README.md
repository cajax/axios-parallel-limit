# Examples

This directory contains a simple test setup to demonstrate the `axios-parallel-limit` library in action.

## Prerequisites

Before running the examples, make sure you have built the project:

```bash
npm install
npm run build
```

## Running the Test Server

The server simulates a slow API with random response delays (100ms - 1000ms).

Open a terminal and run:

```bash
node examples/server.js
```

It will listen on `http://localhost:3000`.

## Running the Client

The client application connects to the test server and sends multiple requests using `axios-parallel-limit`.

Open a **separate** terminal and run:

```bash
node examples/client.js
```

Follow the interactive prompts to configure:
1.  **Total requests**: How many requests to queue (default: 10).
2.  **Parallel limit**: How many requests to allow simultaneously (default: 4).

The client will log the active/pending count and the responses from the server.
