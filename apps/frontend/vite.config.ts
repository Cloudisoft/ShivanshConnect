import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  preview: {
    // Railway's generated domain (and any custom domain) won't match Vite's
    // default preview host allowlist, so accept any Host header here.
    allowedHosts: true,
  },
});
