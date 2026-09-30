import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: /api → the API on :3100 (prefix stripped), like nginx in compose.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3100', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
