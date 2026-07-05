// src/components/BlogSyncManager.tsx
// Componente para manejar la sincronización de blogs entre backend y localStorage

import { useEffect } from 'react';

// @ts-ignore
import { syncBlogToLocalStorage } from '../../lib/frontend-blog-sync.js';

interface BlogSyncManagerProps {
  onBlogGenerated?: (blog: any) => void;
}

const BlogSyncManager: React.FC<BlogSyncManagerProps> = ({ onBlogGenerated }) => {

  useEffect(() => {
    // Listener para eventos personalizados de blog generado
    const handleBlogGenerated = (event: CustomEvent) => {
      const newBlog = event.detail;
      
      // Sincronizar con localStorage
      const synced = syncBlogToLocalStorage(newBlog);
      
      if (synced) {
        console.log('Blog sincronizado con localStorage:', newBlog.title);
        
        // Notificar al componente padre si es necesario
        if (onBlogGenerated) {
          onBlogGenerated(newBlog);
        }
        
        // Recargar la página para mostrar el nuevo blog (temporal)
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      }
    };

    // Agregar listener para eventos de blog generado
    window.addEventListener('blogGenerated', handleBlogGenerated as EventListener);

    return () => {
      window.removeEventListener('blogGenerated', handleBlogGenerated as EventListener);
    };
  }, [onBlogGenerated]);

  // Función para disparar evento cuando se genera un blog
  const triggerBlogGenerated = (blog: any) => {
    const event = new CustomEvent('blogGenerated', { detail: blog });
    window.dispatchEvent(event);
  };

  // Exponer función globalmente para que sea llamada desde otros componentes
  useEffect(() => {
    (window as any).triggerBlogGenerated = triggerBlogGenerated;
    
    return () => {
      delete (window as any).triggerBlogGenerated;
    };
  }, []);

  return null; // Este componente no renderiza nada
};

export default BlogSyncManager;