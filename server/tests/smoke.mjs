// Minimal smoke test: boots the server in-process, hits /api/health, exits.
// Usage: npm run smoke
import { createApp } from '../src/index.js';

const { app } = createApp();

const server = app.listen(0, async () => {
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await res.json();
    if (res.ok && body.ok === true) {
      console.log(`SMOKE TEST PASSED: ${JSON.stringify(body)}`);
      server.close(() => process.exit(0));
    } else {
      console.error(`SMOKE TEST FAILED: ${JSON.stringify(body)}`);
      server.close(() => process.exit(1));
    }
  } catch (err) {
    console.error(`SMOKE TEST FAILED: ${err.message}`);
    server.close(() => process.exit(1));
  }
});
