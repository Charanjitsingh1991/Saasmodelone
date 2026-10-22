import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

const proxy = {
  '/v1': { target: apiTarget, changeOrigin: false },
  '/health': { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 3000,
    strictPort: true,
    proxy,
  },
  build: {
    sourcemap: false,
  },
});
