import { defineConfig } from 'vite';
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './server/app.js';

try {
  process.loadEnvFile('.host-switch/mcs.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function hostSwitchApi() {
  return {
    name: 'craftsystem-host-switch-api',
    apply: 'serve',
    async configureServer(server) {
      const { app } = await createApp({ apiOnly: true });
      server.middlewares.use(app);
    },
  };
}

export default defineConfig({
  plugins: [hostSwitchApi()],
  cacheDir: path.join(os.tmpdir(), 'craftsystem-vite-cache', String(process.getuid?.() ?? 'default')),
  build: {
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
    port: 80,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 80,
    strictPort: true,
  },
});
