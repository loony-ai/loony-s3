import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    // During development, proxy API calls to the loony-s3 server.
    // Set VITE_API_URL to override (e.g. for a remote server).
    proxy: {
      '/auth':    { target: 'http://localhost:8006', changeOrigin: true },
      '/buckets': { target: 'http://localhost:8006', changeOrigin: true },
      '/health':  { target: 'http://localhost:8006', changeOrigin: true },
    },
  },
});
