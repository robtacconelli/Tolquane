import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The built assets are served by the Python package, so they land straight in the
// package tree rather than in web/dist; the wheel picks them up from there.
const STATIC_DIR = fileURLToPath(new URL('../src/tolquane/web/static', import.meta.url));

// The port the Python server is on. `tolquane web` defaults to 8765; an e2e run that
// starts its own server on another port sets TOLQUANE_API_PORT to match.
const API_PORT = process.env.TOLQUANE_API_PORT ?? '8765';

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: STATIC_DIR,
    emptyOutDir: true,
    sourcemap: false,
    // The canvas and the code editor arrive in wave 2 as lazy chunks; warn early if the
    // shell itself starts to grow.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: false,
    // `vite preview` does not inherit the dev server's proxy and the e2e run is served
    // from it, so the same rule is repeated for the journeys that talk to a real server.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: true,
    restoreMocks: true,
  },
});
