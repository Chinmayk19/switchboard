import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const server = 'http://localhost:' + (env.PORT || '4000');
  const webPort = new URL(env.WEB_ORIGIN || 'http://localhost:5173').port;
  return {
    plugins: [react()],
    server: {
      port: Number(webPort || 5173),
      strictPort: true,
      proxy: {
        '/api': server,
        '/auth': server,
        '/healthz': server,
        '/ws': { target: server, ws: true },
      },
    },
  };
});
