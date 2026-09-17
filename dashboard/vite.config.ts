import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The devnet server (devnet/server.mjs) listens on 8787. Proxying /api through Vite keeps the
// dashboard same-origin, so neither SSE nor POST needs CORS headers from that server.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_DEVNET_ORIGIN || 'http://127.0.0.1:8787';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          // SSE must not be buffered.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (String(proxyRes.headers['content-type']).includes('text/event-stream')) {
                delete proxyRes.headers['content-length'];
              }
            });
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
