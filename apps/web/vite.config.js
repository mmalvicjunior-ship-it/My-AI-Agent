import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function backendPortFromEnv(env = {}) {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3001;
}

export function configureApiProxy(proxy, target) {
  proxy.on('error', (_error, _request, response) => {
    console.error(`[web] Cannot reach the backend at ${target}.`);
    if (!response || response.destroyed) return;
    if (response.headersSent) {
      response.end();
      return;
    }

    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      ok: false,
      error: `Cannot reach the backend at ${target}. Check that the backend is running on its configured port, then restart both services.`,
    }));
  });
}

export function createViteConfig(env = {}) {
  const backendTarget = `http://127.0.0.1:${backendPortFromEnv(env)}`;
  return {
    plugins: [{
      name: 'myai-lan-url',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          const address = server.httpServer.address();
          const port = typeof address === 'object' && address ? address.port : 5173;
          const addresses = Object.values(os.networkInterfaces())
            .flatMap((interfaces) => interfaces || [])
            .filter((entry) => entry.family === 'IPv4' && !entry.internal)
            .map((entry) => `http://${entry.address}:${port}`);
          for (const url of addresses) console.log(`[web] network URL: ${url}`);
        });
      },
    }],
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
          configure: (proxy) => configureApiProxy(proxy, backendTarget),
        },
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, projectRoot, '');
  return createViteConfig({ ...process.env, PORT: process.env.PORT || PORT });
});
