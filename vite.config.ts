import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configuración de Vite para BIOSKIN Admin Panel
// El proxy en desarrollo apunta a la URL de producción de Vercel (o a vercel dev local).
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // lucide-react causa problemas si se pre-bundlea; se excluye para que Vite lo sirva directamente
    exclude: ['lucide-react'],
  },
  server: {
    proxy: {
      // Redirige /api/* al backend Vercel (ajustar la URL en producción o usar `vercel dev`)
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
