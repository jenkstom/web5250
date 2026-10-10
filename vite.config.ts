import { defineConfig } from 'vite';

// Relative base so the built SPA works when Pangolin routes it under any
// sub-path (e.g. https://host/as400/ -> http://web5250:8080/).
export default defineConfig({
  base: './',
  root: 'src/client',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    target: 'es2020'
  },
  server: {
    proxy: {
      // Dev-only convenience: forward /ws to the local backend.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      }
    }
  }
});
