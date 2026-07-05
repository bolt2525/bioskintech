// src/components/BlogManagement.tsx
// Componente completo para gestión de blogs (CRUD + visualización)

import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Edit3, 
  Trash2, 
  Eye, 
  Search, 
  Save,
  X,
  FileText,
  Calendar,
  Loader2,
  AlertCircle
} from 'lucide-react';

interface Blog {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content?: string;
  category: 'medico-estetico' | 'tecnico';
  author: string;
  publishedAt: string;
  readTime: number;
  image: string;
  imagenPrincipal?: string;    // Nueva imagen principal personalizada
  imagenConclusion?: string;   // Nueva imagen después de conclusión
  featured: boolean;
  tags: string[];
  source: 'static' | 'dynamic';
  createdAt?: string;
  updatedAt?: string;
}

interface BlogStats {
  static: number;
  dynamic: number;
  total: number;
}

const BlogManagement: React.FC = () => {
  const [blogs, setBlogs] = useState<Blog[]>([]);
  const [stats, setStats] = useState<BlogStats>({ static: 0, dynamic: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filtros y búsqueda
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'medico-estetico' | 'tecnico'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'static' | 'dynamic'>('all');
  
  // Modal de edición
  const [editingBlog, setEditingBlog] = useState<Blog | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Estado para crear nuevo blog
  const [isCreating, setIsCreating] = useState(false);
  const [newBlog, setNewBlog] = useState<Partial<Blog>>({
    title: '',
    excerpt: '',
    content: '',
    category: 'medico-estetico',
    author: 'BIOSKIN IA',
    featured: false,
    tags: [],
    imagenPrincipal: '',
    imagenConclusion: ''
  });

  // Función para cargar blogs desde localStorage
  const loadBlogsFromLocalStorage = () => {
    try {
      const data = localStorage.getItem('bioskin_dynamic_blogs');
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.warn('Error leyendo localStorage:', error.message);
      return [];
    }
  };

  // Cargar blogs (combinando backend + localStorage)
  const loadBlogs = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Obtener blogs del backend (estáticos + dinámicos en memoria del servidor)
      const params = new URLSearchParams({
        limit: '50',
        source: 'all', // Siempre cargar todos del servidor
        ...(categoryFilter !== 'all' && { category: categoryFilter }),
        ...(searchTerm && { search: searchTerm })
      });

      const response = await fetch(`/api/blogs?${params}`);
      const data = await response.json();
      
      // Obtener blogs adicionales de localStorage
      const localStorageBlogs = loadBlogsFromLocalStorage();
      
      // Combinar blogs evitando duplicados
      let allBlogs = [];
      
      if (data.success && data.blogs) {
        allBlogs = [...data.blogs];
      }
      
      // Agregar blogs de localStorage que no estén en el servidor
      localStorageBlogs.forEach(localBlog => {
        const exists = allBlogs.some(serverBlog => 
          serverBlog.slug === localBlog.slug || serverBlog.id === localBlog.id
        );
        
        if (!exists) {
          // Marcar como fuente localStorage y agregar
          allBlogs.push({
            ...localBlog,
            source: 'localStorage'
          });
        }
      });

      // Aplicar filtros de fuente
      let filteredBlogs = allBlogs;
      if (sourceFilter === 'static') {
        filteredBlogs = allBlogs.filter(blog => blog.source === 'static');
      } else if (sourceFilter === 'dynamic') {
        filteredBlogs = allBlogs.filter(blog => blog.source === 'dynamic' || blog.source === 'localStorage');
      }

      // Aplicar filtros de categoría
      if (categoryFilter !== 'all') {
        filteredBlogs = filteredBlogs.filter(blog => blog.category === categoryFilter);
      }

      // Aplicar búsqueda
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        filteredBlogs = filteredBlogs.filter(blog =>
          blog.title.toLowerCase().includes(searchLower) ||
          blog.excerpt.toLowerCase().includes(searchLower) ||
          (blog.tags && blog.tags.some(tag => tag.toLowerCase().includes(searchLower)))
        );
      }

      // Ordenar por fecha (más recientes primero)
      filteredBlogs.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      setBlogs(filteredBlogs);
      
      // Calcular estadísticas
      const staticCount = allBlogs.filter(blog => blog.source === 'static').length;
      const dynamicCount = allBlogs.filter(blog => blog.source === 'dynamic' || blog.source === 'localStorage').length;
      
      setStats({
        static: staticCount,
        dynamic: dynamicCount,
        total: allBlogs.length
      });
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando blogs');
      
      // Fallback: intentar cargar solo desde localStorage
      try {
        const localStorageBlogs = loadBlogsFromLocalStorage();
        setBlogs(localStorageBlogs.map(blog => ({ ...blog, source: 'localStorage' })));
        setStats({
          static: 0,
          dynamic: localStorageBlogs.length,
          total: localStorageBlogs.length
        });
      } catch (localError) {
        console.error('Error incluso con fallback localStorage:', localError);
      }
    } finally {
      setLoading(false);
    }
  };

  // Función para sincronizar blogs de localStorage al servidor
  const syncLocalStorageToServer = async () => {
    try {
      setLoading(true);
      setError(null);

      const localStorageBlogs = loadBlogsFromLocalStorage();

      if (localStorageBlogs.length === 0) {
        alert('No hay blogs en localStorage para sincronizar');
        return;
      }

      const response = await fetch('/api/blogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate-all', blogs: localStorageBlogs })
      });

      const data = await response.json();

      if (data.success) {
        alert(`🎉 MIGRACIÓN EXITOSA!\n\n` +
              `📊 Total procesados: ${data.results.total}\n` +
              `✅ Agregados al servidor: ${data.results.added}\n` +
              `⏭️ Ya existían: ${data.results.skipped}\n` +
              `🌐 Total en servidor: ${data.newTotal}\n\n` +
              `Ahora todos los blogs estarán disponibles en cualquier dispositivo!`);
        
        // Limpiar localStorage después de sincronización exitosa
        if (data.results.added > 0 && confirm('¿Quieres limpiar localStorage ya que los blogs fueron sincronizados al servidor?')) {
          localStorage.removeItem('bioskin_dynamic_blogs');
        }
        
        // Recargar blogs para reflejar los cambios
        await loadBlogs();
      } else {
        throw new Error(data.message);
      }

    } catch (error) {
      setError('Error durante la sincronización: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Función para manejar carga de imágenes
  const handleImageUpload = async (file: File, imageType: 'principal' | 'conclusion'): Promise<string> => {
    try {
      // Crear FormData para subir la imagen
      const formData = new FormData();
      formData.append('image', file);
      formData.append('type', imageType);
      formData.append('folder', 'blog');

      // Subir imagen al servidor
      const response = await fetch('/api/upload-image', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (result.success) {
        return result.imageUrl;
      } else {
        throw new Error(result.message || 'Error subiendo imagen');
      }
    } catch (error) {
      console.error('Error subiendo imagen:', error);
      throw error;
    }
  };

  // Función para convertir imagen a base64 (fallback si no hay endpoint de upload)
  const convertImageToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // Función para exportar un blog individual en formato del proyecto
  const exportIndividualBlog = async (blog: Blog) => {
    try {
      // Formato estándar del proyecto
      const blogForExport = {
        id: blog.id,
        title: blog.title,
        slug: blog.slug,
        excerpt: blog.excerpt,
        content: blog.content,
        category: blog.category,
        author: blog.author,
        publishedAt: blog.publishedAt,
        readTime: blog.readTime,
        tags: blog.tags || [],
        image: blog.image,
        imagenPrincipal: blog.imagenPrincipal || blog.image,
        imagenConclusion: blog.imagenConclusion || '',
        featured: Boolean(blog.featured),
        source: 'json-exported'
      };

      // Crear archivo JSON individual
      const dataStr = JSON.stringify(blogForExport, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      
      // Crear link de descarga con nombre basado en slug
      const link = document.createElement('a');
      link.href = url;
      link.download = `${blog.slug}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      alert(`✅ Blog exportado!\n\n📄 "${blog.title}"\n📁 Archivo: ${blog.slug}.json\n\n💡 Este archivo se puede agregar directamente a la carpeta src/data/blogs/ del proyecto.`);
      
    } catch (error) {
      console.error('Error exportando blog individual:', error);
      alert('❌ Error al exportar blog: ' + error.message);
    }
  };

  // Función para exportar todos los blogs a JSON (backup completo)
  const exportBlogsToJSON = async () => {
    try {
      setLoading(true);
      
      // Obtener todos los blogs
      const { getAllBlogsWithLocalStorage } = await import('../../lib/frontend-blog-sync.js');
      const allBlogs = getAllBlogsWithLocalStorage();
      
      if (allBlogs.length === 0) {
        alert('❌ No hay blogs para exportar');
        return;
      }

      // Crear objeto de exportación con metadata
      const exportData = {
        exportDate: new Date().toISOString(),
        version: '1.0',
        totalBlogs: allBlogs.length,
        blogs: allBlogs.map(blog => ({
          ...blog,
          exportedAt: new Date().toISOString()
        }))
      };

      // Crear archivo JSON para descarga
      const dataStr = JSON.stringify(exportData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      
      // Crear link de descarga
      const link = document.createElement('a');
      link.href = url;
      link.download = `bioskin-blogs-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      alert(`✅ Backup completo!\n\n📊 ${allBlogs.length} blogs exportados\n📁 Archivo: ${link.download}\n\n💡 Para blogs individuales, usa el botón 📁 de cada blog.`);
      
    } catch (error) {
      console.error('Error exportando blogs:', error);
      alert('❌ Error al exportar blogs: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Función para importar blogs desde JSON
  const importBlogsFromJSON = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setLoading(true);
      
      const fileContent = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      });

      const importData = JSON.parse(fileContent);
      
      // Validar estructura del archivo
      if (!importData.blogs || !Array.isArray(importData.blogs)) {
        throw new Error('Formato de archivo inválido. Se esperaba un archivo de exportación de blogs.');
      }

      const blogsToImport = importData.blogs;
      let imported = 0;
      let skipped = 0;
      
      // Obtener blogs existentes para evitar duplicados
      const { getAllBlogsWithLocalStorage, syncBlogToLocalStorage } = await import('../../lib/frontend-blog-sync.js');
      const existingBlogs = getAllBlogsWithLocalStorage();
      const existingSlugs = new Set(existingBlogs.map(b => b.slug));

      for (const blog of blogsToImport) {
        if (!existingSlugs.has(blog.slug)) {
          // Asignar nuevo ID y fecha de importación
          const importedBlog = {
            ...blog,
            id: blog.id || Date.now().toString() + Math.random().toString(36).substr(2, 9),
            importedAt: new Date().toISOString(),
            source: 'imported'
          };
          
          // Guardar en localStorage para visibilidad inmediata
          syncBlogToLocalStorage(importedBlog);
          
          // También enviar al servidor
          try {
            await fetch('/api/blogs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'manage', blog: importedBlog })
            });
          } catch (serverError) {
            console.warn('Error enviando al servidor, pero guardado en localStorage:', serverError);
          }
          
          imported++;
        } else {
          skipped++;
        }
      }

      await loadBlogs(); // Recargar lista
      
      alert(`✅ Importación completada!\n\n📊 Blogs importados: ${imported}\n⏭️ Blogs omitidos (ya existían): ${skipped}\n📈 Total en archivo: ${blogsToImport.length}\n\n💡 Los blogs importados están ahora disponibles en todos tus dispositivos.`);
      
    } catch (error) {
      console.error('Error importando blogs:', error);
      alert('❌ Error al importar blogs: ' + error.message);
    } finally {
      setLoading(false);
      // Limpiar el input file
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  // Función para probar CRUD operations
  const testCRUDOperations = async () => {
    const testResults = {
      create: false,
      read: false,
      update: false,
      delete: false
    };

    try {
      setLoading(true);
      
      // Test CREATE
      const testBlog = {
        title: 'Test Blog CRUD - ' + Date.now(),
        slug: 'test-blog-crud-' + Date.now(),
        excerpt: 'Blog de prueba para verificar operaciones CRUD',
        content: 'Contenido de prueba para verificar que las operaciones CRUD funcionan correctamente.',
        category: 'prueba',
        status: 'published',
        imagenPrincipal: '',
        imagenConclusion: ''
      };

      console.log('🧪 Probando CREATE...');
      const createResponse = await fetch('/api/blogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manage', ...testBlog })
      });
      const createResult = await createResponse.json();
      testResults.create = createResult.success;
      
      if (testResults.create) {
        const createdId = createResult.blog.id;
        console.log(`✅ CREATE exitoso - ID: ${createdId}`);
        
        // Test READ
        console.log('🧪 Probando READ...');
        await loadBlogs();
        const foundBlog = blogs.find(b => b.id === createdId);
        testResults.read = !!foundBlog;
        console.log(testResults.read ? '✅ READ exitoso' : '❌ READ fallido');
        
        if (testResults.read) {
          // Test UPDATE
          console.log('🧪 Probando UPDATE...');
          const updatedBlog = {
            ...foundBlog,
            title: foundBlog.title + ' - ACTUALIZADO',
            content: foundBlog.content + ' - CONTENIDO ACTUALIZADO'
          };
          
          const updateResponse = await fetch('/api/blogs', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'manage', ...updatedBlog })
          });
          const updateResult = await updateResponse.json();
          testResults.update = updateResult.success;
          console.log(testResults.update ? '✅ UPDATE exitoso' : '❌ UPDATE fallido');
          
          // Test DELETE
          console.log('🧪 Probando DELETE...');
          const deleteResponse = await fetch('/api/blogs', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'manage', id: createdId })
          });
          const deleteResult = await deleteResponse.json();
          testResults.delete = deleteResult.success;
          console.log(testResults.delete ? '✅ DELETE exitoso' : '❌ DELETE fallido');
        }
      }

      // Mostrar resultados
      const passedTests = Object.values(testResults).filter(Boolean).length;
      const totalTests = Object.keys(testResults).length;
      
      alert(`🧪 Pruebas CRUD completadas:\n\n✅ CREATE: ${testResults.create ? 'PASÓ' : 'FALLÓ'}\n✅ READ: ${testResults.read ? 'PASÓ' : 'FALLÓ'}\n✅ UPDATE: ${testResults.update ? 'PASÓ' : 'FALLÓ'}\n✅ DELETE: ${testResults.delete ? 'PASÓ' : 'FALLÓ'}\n\nResultado: ${passedTests}/${totalTests} pruebas exitosas`);
      
      await loadBlogs(); // Recargar lista
      
    } catch (error) {
      console.error('Error en pruebas CRUD:', error);
      alert('❌ Error ejecutando pruebas CRUD: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Función de diagnóstico de persistencia
  const diagnosticPersistenceIssues = async () => {
    try {
      setLoading(true);
      
      const diagnostics = {
        localStorage: {},
        browser: {},
        server: {},
        recommendations: []
      };

      // Diagnóstico localStorage
      try {
        const testKey = 'bioskin_persistence_test';
        localStorage.setItem(testKey, 'test_value');
        const retrieved = localStorage.getItem(testKey);
        localStorage.removeItem(testKey);
        
        diagnostics.localStorage = {
          available: true,
          working: retrieved === 'test_value',
          quota: null
        };

        // Verificar quota de localStorage si es posible
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          diagnostics.localStorage.quota = {
            used: estimate.usage,
            available: estimate.quota,
            percentUsed: ((estimate.usage / estimate.quota) * 100).toFixed(2)
          };
        }
      } catch (e) {
        diagnostics.localStorage = {
          available: false,
          error: e.message
        };
      }

      // Diagnóstico del navegador
      diagnostics.browser = {
        userAgent: navigator.userAgent,
        isSafari: /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent),
        isFirefox: /Firefox/.test(navigator.userAgent),
        isChrome: /Chrome/.test(navigator.userAgent),
        isPWA: window.matchMedia('(display-mode: standalone)').matches,
        cookiesEnabled: navigator.cookieEnabled,
        isPrivateMode: false // Detectar más abajo
      };

      // Detectar modo privado/incógnito
      try {
        if (diagnostics.browser.isFirefox) {
          const db = indexedDB.open('test');
          diagnostics.browser.isPrivateMode = false;
        } else {
          // Para otros navegadores
          const testStorage = window.sessionStorage;
          testStorage.setItem('private_test', '1');
          testStorage.removeItem('private_test');
          diagnostics.browser.isPrivateMode = false;
        }
      } catch (e) {
        diagnostics.browser.isPrivateMode = true;
      }

      // Diagnóstico del servidor
      try {
        const serverResponse = await fetch('/api/blogs?action=health');
        const serverData = await serverResponse.json();
        diagnostics.server = {
          accessible: true,
          response: serverData,
          latency: null // Se podría medir
        };
      } catch (e) {
        diagnostics.server = {
          accessible: false,
          error: e.message
        };
      }

      // Generar recomendaciones
      if (diagnostics.browser.isSafari) {
        diagnostics.recommendations.push('🍎 Safari detectado: Los datos se eliminan automáticamente después de 7 días sin interacción. Recomendación: Exportar blogs regularmente.');
      }

      if (diagnostics.browser.isPrivateMode) {
        diagnostics.recommendations.push('🕶️ Modo privado detectado: Los datos se eliminan al cerrar el navegador. Use modo normal para persistencia.');
      }

      if (!diagnostics.localStorage.available) {
        diagnostics.recommendations.push('❌ localStorage no disponible: Use exportación JSON como respaldo único.');
      }

      if (!diagnostics.server.accessible) {
        diagnostics.recommendations.push('🌐 Servidor no accesible: Los blogs solo se guardan localmente. Verifique conexión a internet.');
      }

      diagnostics.recommendations.push('💡 Solución recomendada: Use "Exportar JSON" regularmente y guarde los archivos en un lugar seguro.');
      diagnostics.recommendations.push('🔄 Para recuperar: Use "Importar JSON" con los archivos exportados.');

      // Mostrar diagnóstico
      const report = `
🔍 DIAGNÓSTICO DE PERSISTENCIA DE BLOGS

📱 NAVEGADOR:
• Tipo: ${diagnostics.browser.isSafari ? 'Safari' : diagnostics.browser.isFirefox ? 'Firefox' : diagnostics.browser.isChrome ? 'Chrome' : 'Otro'}
• Modo privado: ${diagnostics.browser.isPrivateMode ? 'SÍ ⚠️' : 'NO ✅'}
• PWA instalada: ${diagnostics.browser.isPWA ? 'SÍ' : 'NO'}

💾 ALMACENAMIENTO LOCAL:
• Disponible: ${diagnostics.localStorage.available ? 'SÍ ✅' : 'NO ❌'}
• Funcionando: ${diagnostics.localStorage.working ? 'SÍ ✅' : 'NO ❌'}
${diagnostics.localStorage.quota ? `• Espacio usado: ${diagnostics.localStorage.quota.percentUsed}%` : ''}

🌐 SERVIDOR:
• Accesible: ${diagnostics.server.accessible ? 'SÍ ✅' : 'NO ❌'}

⚠️ POSIBLES CAUSAS DEL PROBLEMA:
${diagnostics.recommendations.map(r => '• ' + r).join('\n')}

💡 SOLUCIÓN INMEDIATA:
1. Haz clic en "Exportar JSON" AHORA
2. Guarda el archivo en un lugar seguro
3. Repite la exportación regularmente
4. Para restaurar: usa "Importar JSON"
      `;

      alert(report);

    } catch (error) {
      console.error('Error en diagnóstico:', error);
      alert('❌ Error ejecutando diagnóstico: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Función para forzar migración completa de TODOS los blogs
  const forceCompleteSync = async () => {
    if (!confirm('⚠️ MIGRACIÓN FORZADA COMPLETA\n\n¿Estás seguro de que quieres migrar TODOS los blogs de localStorage al servidor?\n\nEsto asegurará que estén disponibles en todos los dispositivos.')) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const localStorageBlogs = loadBlogsFromLocalStorage();

      if (localStorageBlogs.length === 0) {
        alert('❌ No hay blogs en localStorage para migrar');
        return;
      }

      console.log(`🚀 Iniciando migración forzada de ${localStorageBlogs.length} blogs...`);

      const response = await fetch('/api/blogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate-all', blogs: localStorageBlogs })
      });

      const data = await response.json();

      if (data.success) {
        alert(`🎉 ¡MIGRACIÓN FORZADA EXITOSA!\n\n` +
              `📊 Blogs procesados: ${data.results.total}\n` +
              `✅ Nuevos en servidor: ${data.results.added}\n` +
              `⏭️ Ya existían: ${data.results.skipped}\n` +
              `📈 Total en servidor: ${data.newTotal}\n\n` +
              `🌐 ¡Todos los blogs ahora están disponibles en cualquier dispositivo!\n\n` +
              `Recarga la página desde tu móvil para verlos.`);
        
        // Recargar blogs para reflejar los cambios
        await loadBlogs();
        
        // Sugerir limpiar localStorage
        if (data.results.added > 0 && confirm('✅ Migración exitosa!\n\n¿Quieres limpiar localStorage ahora que todos los blogs están en el servidor?\n\n(Recomendado para evitar duplicados)')) {
          localStorage.removeItem('bioskin_dynamic_blogs');
          alert('🧹 localStorage limpiado. Los blogs seguirán disponibles desde el servidor.');
          await loadBlogs(); // Recargar para mostrar solo los del servidor
        }
      } else {
        throw new Error(data.message);
      }

    } catch (error) {
      setError('Error durante la migración forzada: ' + error.message);
      alert('❌ Error en la migración: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Efectos
  useEffect(() => {
    loadBlogs();
  }, [searchTerm, categoryFilter, sourceFilter]);

  // Guardar blog (crear o actualizar)
  const saveBlog = async (blogData: Partial<Blog>, isUpdate = false) => {
    try {
      setIsSaving(true);
      
      const url = '/api/blogs';
      
      const method = isUpdate ? 'PUT' : 'POST';
      
      // Generar slug si no existe
      if (!blogData.slug && blogData.title) {
        blogData.slug = blogData.title
          .toLowerCase()
          .replace(/[áàäâ]/g, 'a')
          .replace(/[éèëê]/g, 'e')
          .replace(/[íìïî]/g, 'i')
          .replace(/[óòöô]/g, 'o')
          .replace(/[úùüû]/g, 'u')
          .replace(/ñ/g, 'n')
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/--+/g, '-')
          .replace(/^-+|-+$/g, '') + '-' + Date.now();
      }

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'manage', 
          blog: blogData,
          ...(isUpdate && { slug: blogData.slug })
        })
      });

      const result = await response.json();

      if (result.success) {
        // También sincronizar con localStorage para visibilidad inmediata
        if (!isUpdate) {
          // Para nuevos blogs, agregamos también a localStorage
          const blogForLocalStorage = {
            id: result.blog?.id || blogData.id || Date.now().toString(),
            title: blogData.title,
            slug: blogData.slug,
            excerpt: blogData.excerpt,
            content: blogData.content,
            category: blogData.category,
            author: blogData.author,
            publishedAt: new Date().toISOString(),
            readTime: blogData.readTime || 5,
            tags: blogData.tags || [],
            image: blogData.imagenPrincipal || blogData.image || '',
            imagenPrincipal: blogData.imagenPrincipal || '',
            imagenConclusion: blogData.imagenConclusion || '',
            featured: Boolean(blogData.featured),
            source: 'dynamic'
          };
          
          // Sincronizar con localStorage
          const { syncBlogToLocalStorage } = await import('../../lib/frontend-blog-sync.js');
          syncBlogToLocalStorage(blogForLocalStorage);
        }
        
        await loadBlogs(); // Recargar lista
        setEditingBlog(null);
        setIsEditing(false);
        setIsCreating(false);
        setNewBlog({
          title: '',
          excerpt: '',
          content: '',
          category: 'medico-estetico',
          author: 'BIOSKIN IA',
          featured: false,
          tags: []
        });
        return result;
      } else {
        throw new Error(result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error guardando blog';
      setError(message);
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  // Eliminar blog
  const deleteBlog = async (slug: string) => {
    if (!window.confirm('¿Estás seguro de que quieres eliminar este blog?')) {
      return;
    }

    try {
      const response = await fetch('/api/blogs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manage', slug })
      });

      const result = await response.json();

      if (result.success) {
        // También eliminar de localStorage si existe
        const { loadBlogsFromLocalStorage, saveBlogsToLocalStorage } = await import('../../lib/frontend-blog-sync.js');
        const localBlogs = loadBlogsFromLocalStorage();
        const updatedLocalBlogs = localBlogs.filter(blog => blog.slug !== slug);
        saveBlogsToLocalStorage(updatedLocalBlogs);
        
        await loadBlogs(); // Recargar lista
      } else {
        throw new Error(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error eliminando blog');
    }
  };

  // Renderizar formulario de edición
  const renderEditForm = (blog: Partial<Blog>, isNew = false) => (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-bold text-gray-800">
              {isNew ? 'Crear Nuevo Blog' : 'Editar Blog'}
            </h3>
            <button
              onClick={() => {
                setIsEditing(false);
                setIsCreating(false);
                setEditingBlog(null);
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X size={24} />
            </button>
          </div>

          <form onSubmit={(e) => {
            e.preventDefault();
            saveBlog(isNew ? newBlog : (editingBlog || {}), !isNew);
          }} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Título *
                </label>
                <input
                  type="text"
                  value={blog.title || ''}
                  onChange={(e) => {
                    if (isNew) {
                      setNewBlog({ ...newBlog, title: e.target.value });
                    } else {
                      setEditingBlog({ ...editingBlog!, title: e.target.value });
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Categoría
                </label>
                <select
                  value={blog.category || 'medico-estetico'}
                  onChange={(e) => {
                    const category = e.target.value as 'medico-estetico' | 'tecnico';
                    if (isNew) {
                      setNewBlog({ ...newBlog, category });
                    } else {
                      setEditingBlog({ ...editingBlog!, category });
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                >
                  <option value="medico-estetico">Médico Estético</option>
                  <option value="tecnico">Técnico</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Autor
                </label>
                <input
                  type="text"
                  value={blog.author || ''}
                  onChange={(e) => {
                    if (isNew) {
                      setNewBlog({ ...newBlog, author: e.target.value });
                    } else {
                      setEditingBlog({ ...editingBlog!, author: e.target.value });
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                />
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="featured"
                  checked={blog.featured || false}
                  onChange={(e) => {
                    if (isNew) {
                      setNewBlog({ ...newBlog, featured: e.target.checked });
                    } else {
                      setEditingBlog({ ...editingBlog!, featured: e.target.checked });
                    }
                  }}
                  className="mr-2"
                />
                <label htmlFor="featured" className="text-sm font-medium text-gray-700">
                  Blog destacado
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Extracto *
              </label>
              <textarea
                value={blog.excerpt || ''}
                onChange={(e) => {
                  if (isNew) {
                    setNewBlog({ ...newBlog, excerpt: e.target.value });
                  } else {
                    setEditingBlog({ ...editingBlog!, excerpt: e.target.value });
                  }
                }}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Contenido
              </label>
              <textarea
                value={blog.content || ''}
                onChange={(e) => {
                  if (isNew) {
                    setNewBlog({ ...newBlog, content: e.target.value });
                  } else {
                    setEditingBlog({ ...editingBlog!, content: e.target.value });
                  }
                }}
                rows={8}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                placeholder="Contenido en formato Markdown"
              />
            </div>

            {/* 🖼️ NUEVOS CAMPOS DE IMÁGENES PERSONALIZADAS */}
            <div className="border-t pt-6">
              <h4 className="text-lg font-semibold text-gray-800 mb-4">📸 Imágenes Personalizadas</h4>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Imagen Principal */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    🎯 Imagen Principal (al inicio del blog)
                  </label>
                  
                  {/* Selector de archivo */}
                  <div className="mb-2">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          try {
                            setIsLoading(true);
                            const imageUrl = await convertImageToBase64(file);
                            if (isNew) {
                              setNewBlog({ ...newBlog, imagenPrincipal: imageUrl });
                            } else {
                              setEditingBlog({ ...editingBlog!, imagenPrincipal: imageUrl });
                            }
                          } catch (error) {
                            console.error('Error cargando imagen:', error);
                            alert('Error cargando la imagen');
                          } finally {
                            setIsLoading(false);
                          }
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887] file:mr-4 file:py-1 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-[#deb887] file:text-white hover:file:bg-[#d4a574]"
                    />
                  </div>
                  
                  {/* Campo URL alternativo */}
                  <input
                    type="url"
                    value={blog.imagenPrincipal?.startsWith('data:') ? '' : blog.imagenPrincipal || ''}
                    onChange={(e) => {
                      if (isNew) {
                        setNewBlog({ ...newBlog, imagenPrincipal: e.target.value });
                      } else {
                        setEditingBlog({ ...editingBlog!, imagenPrincipal: e.target.value });
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                    placeholder="O ingresa una URL: https://ejemplo.com/imagen-principal.jpg"
                  />
                  
                  {blog.imagenPrincipal && (
                    <div className="mt-2">
                      <img 
                        src={blog.imagenPrincipal} 
                        alt="Vista previa principal" 
                        className="w-full h-32 object-cover rounded-md border"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Sube una imagen desde tu dispositivo o ingresa una URL válida
                  </p>
                </div>

                {/* Imagen de Conclusión */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    🏁 Imagen de Conclusión (después de conclusión)
                  </label>
                  
                  {/* Selector de archivo */}
                  <div className="mb-2">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          try {
                            setIsLoading(true);
                            const imageUrl = await convertImageToBase64(file);
                            if (isNew) {
                              setNewBlog({ ...newBlog, imagenConclusion: imageUrl });
                            } else {
                              setEditingBlog({ ...editingBlog!, imagenConclusion: imageUrl });
                            }
                          } catch (error) {
                            console.error('Error cargando imagen:', error);
                            alert('Error cargando la imagen');
                          } finally {
                            setIsLoading(false);
                          }
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887] file:mr-4 file:py-1 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-[#deb887] file:text-white hover:file:bg-[#d4a574]"
                    />
                  </div>
                  
                  {/* Campo URL alternativo */}
                  <input
                    type="url"
                    value={blog.imagenConclusion?.startsWith('data:') ? '' : blog.imagenConclusion || ''}
                    onChange={(e) => {
                      if (isNew) {
                        setNewBlog({ ...newBlog, imagenConclusion: e.target.value });
                      } else {
                        setEditingBlog({ ...editingBlog!, imagenConclusion: e.target.value });
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
                    placeholder="O ingresa una URL: https://ejemplo.com/imagen-conclusion.jpg"
                  />
                  
                  {blog.imagenConclusion && (
                    <div className="mt-2">
                      <img 
                        src={blog.imagenConclusion} 
                        alt="Vista previa conclusión" 
                        className="w-full h-32 object-cover rounded-md border"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Sube una imagen desde tu dispositivo o ingresa una URL válida
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-6">
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setIsCreating(false);
                  setEditingBlog(null);
                }}
                className="px-4 py-2 text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-[#deb887] text-white rounded-md hover:bg-[#d4a574] transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isSaving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Guardando...
                  </>
                ) : (
                  <>
                    <Save size={16} />
                    {isNew ? 'Crear Blog' : 'Guardar Cambios'}
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Gestión de Blogs</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={loadBlogs}
            className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="Recargar lista de blogs"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                <path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M3 21v-5h5"/>
              </svg>
            )}
            Recargar
          </button>
          <button
            onClick={syncLocalStorageToServer}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="Sincronizar blogs de localStorage al servidor"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M3 21v-5h5"/>
                <path d="M4 7l16 0"/>
                <path d="M10 15l6 0"/>
              </svg>
            )}
            Sincronizar
          </button>
          <button
            onClick={exportBlogsToJSON}
            className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="Backup completo: Exportar todos los blogs en un solo archivo JSON"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7,10 12,15 17,10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            )}
            🗂️ Backup Completo
          </button>
          
          <div className="relative">
            <input
              type="file"
              accept=".json"
              onChange={importBlogsFromJSON}
              className="hidden"
              id="import-blogs-input"
              disabled={loading}
            />
            <label
              htmlFor="import-blogs-input"
              className={`bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors cursor-pointer ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
              title="Importar blogs desde archivo JSON de backup"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17,8 12,3 7,8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              )}
              Importar JSON
            </label>
          </div>

          <button
            onClick={diagnosticPersistenceIssues}
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="Diagnosticar problemas de persistencia y obtener recomendaciones"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
            )}
            Diagnóstico
          </button>

          <button
            onClick={testCRUDOperations}
            className="bg-purple-500 hover:bg-purple-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="Probar todas las operaciones CRUD (Crear, Leer, Actualizar, Eliminar)"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12l2 2 4-4"/>
                <path d="M21 12c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1z"/>
                <path d="M3 12c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1z"/>
                <path d="M12 21c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1z"/>
                <path d="M12 3c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1z"/>
              </svg>
            )}
            Probar CRUD
          </button>
          <button
            onClick={forceCompleteSync}
            className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            disabled={loading}
            title="MIGRAR TODOS los blogs de localStorage al servidor (forzado)"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 6l4-4 4 4"/>
                <path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"/>
                <path d="M20 22l-6.828-6.828A4 4 0 0 1 12 12.3"/>
              </svg>
            )}
            🚀 MIGRAR TODOS
          </button>
          <button
            onClick={() => setIsCreating(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={16} />
            Nuevo Blog
          </button>
        </div>
      </div>

      {/* Banner informativo sobre persistencia */}
      <div className="bg-gradient-to-r from-orange-50 to-yellow-50 border-l-4 border-orange-400 p-4 rounded-md">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-orange-400">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-orange-800">
              💾 Importante: Persistencia de Blogs
            </h3>
            <div className="mt-1 text-sm text-orange-700">
              <p>Para máxima persistencia y control de blogs:</p>
              <ul className="mt-2 list-disc list-inside space-y-1">
                <li><strong>📁 Blogs JSON:</strong> Persistentes, en carpeta <code>src/data/blogs/</code></li>
                <li><strong>📥 Exportar Individual:</strong> Botón 📁 en cada blog → archivo JSON listo</li>
                <li><strong>🗂️ Backup Completo:</strong> Botón verde → backup de todos los blogs</li>
                <li><strong>⚠️ Navegadores:</strong> Safari elimina datos cada 7 días, modo privado al cerrar</li>
              </ul>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span className="bg-green-100 text-green-800 px-2 py-1 rounded">
                  ✅ Blogs JSON = Persistencia garantizada
                </span>
                <span className="bg-orange-100 text-orange-800 px-2 py-1 rounded">
                  🔍 Usa "Diagnóstico" si hay problemas
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Estadísticas */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Blogs</p>
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
            </div>
            <FileText className="w-8 h-8 text-blue-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Blogs Estáticos</p>
              <p className="text-2xl font-bold text-gray-900">{stats.static}</p>
            </div>
            <FileText className="w-8 h-8 text-green-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Blogs Generados</p>
              <p className="text-2xl font-bold text-gray-900">{stats.dynamic}</p>
            </div>
            <FileText className="w-8 h-8 text-purple-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Blogs JSON</p>
              <p className="text-2xl font-bold text-gray-900">
                {blogs.filter(b => b.source === 'json-file').length}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Archivos estáticos
              </p>
            </div>
            <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v6a1 1 0 001 1h6"/>
            </svg>
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white p-4 rounded-lg shadow">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
              <input
                type="text"
                placeholder="Buscar blogs..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
              />
            </div>
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
          >
            <option value="all">Todas las categorías</option>
            <option value="medico-estetico">Médico Estético</option>
            <option value="tecnico">Técnico</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#deb887]"
          >
            <option value="all">Todas las fuentes</option>
            <option value="static">Estáticos</option>
            <option value="dynamic">Generados</option>
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 flex items-center gap-2">
          <AlertCircle className="text-red-500" size={16} />
          <span className="text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Lista de blogs */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="animate-spin mx-auto mb-4" size={32} />
            <p className="text-gray-600">Cargando blogs...</p>
          </div>
        ) : blogs.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="mx-auto mb-4 text-gray-400" size={48} />
            <p className="text-gray-600">No se encontraron blogs</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Blog
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Categoría
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Autor
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fecha
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fuente
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {blogs.map((blog) => (
                  <tr key={blog.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-gray-900">
                              {blog.title}
                            </div>
                            {blog.featured && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                                Destacado
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 mt-1">
                            {blog.excerpt.substring(0, 100)}...
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        blog.category === 'medico-estetico' 
                          ? 'bg-blue-100 text-blue-800' 
                          : 'bg-purple-100 text-purple-800'
                      }`}>
                        {blog.category === 'medico-estetico' ? 'Médico Estético' : 'Técnico'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {blog.author}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(blog.publishedAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        blog.source === 'static' 
                          ? 'bg-green-100 text-green-800' 
                          : blog.source === 'localStorage'
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-purple-100 text-purple-800'
                      }`}>
                        {blog.source === 'static' ? 'Estático' : 
                         blog.source === 'localStorage' ? 'LocalStorage' : 'Generado'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/#/blogs/${blog.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-400 hover:text-gray-600"
                          title="Ver blog"
                        >
                          <Eye size={16} />
                        </a>
                        <button
                          onClick={() => exportIndividualBlog(blog)}
                          className="text-green-600 hover:text-green-900"
                          title="Exportar blog individual como JSON"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14,2 14,8 20,8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <polyline points="10,9 9,9 8,9"/>
                          </svg>
                        </button>
                        {blog.source === 'dynamic' && (
                          <>
                            <button
                              onClick={() => {
                                setEditingBlog(blog);
                                setIsEditing(true);
                              }}
                              className="text-blue-600 hover:text-blue-900"
                              title="Editar"
                            >
                              <Edit3 size={16} />
                            </button>
                            <button
                              onClick={() => deleteBlog(blog.slug)}
                              className="text-red-600 hover:text-red-900"
                              title="Eliminar"
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modales */}
      {isCreating && renderEditForm(newBlog, true)}
      {isEditing && editingBlog && renderEditForm(editingBlog, false)}
    </div>
  );
};

export default BlogManagement;