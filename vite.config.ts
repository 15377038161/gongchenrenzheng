import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'CODER_'],
  server: {
    middlewareMode: true,
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: {
      overlay: true,
      path: '/hot/vite-hmr',
      timeout: 30000,
    },
    watch: {
      usePolling: true,
      interval: 100,
    }
  },
});