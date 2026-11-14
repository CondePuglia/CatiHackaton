import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Em desenvolvimento (npm run dev), /api e /socket.io vão para a pilha do Docker.
const alvo = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': alvo,
      '/socket.io': { target: alvo, ws: true },
    },
  },
});
