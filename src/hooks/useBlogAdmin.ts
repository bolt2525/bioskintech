// src/hooks/useBlogAdmin.ts
// Hook personalizado para gestionar la administración de blogs

import { useState, useEffect, useCallback } from 'react';

interface BlogStats {
  currentWeek: string;
  weeklyLimits: {
    total: number;
    'medico-estetico': number;
    'tecnico': number;
  };
  generated: {
    total: number;
    'medico-estetico': number;
    'tecnico': number;
  };
  canGenerate: {
    'medico-estetico': boolean;
    'tecnico': boolean;
    any: boolean;
  };
}

interface GenerationRequest {
  blogType: 'medico-estetico' | 'tecnico';
  topic?: string;
  manual: boolean;
}

interface GenerationResult {
  success: boolean;
  message: string;
  blog?: any;
  meta?: any;
  error?: any;
}

const useBlogAdmin = () => {
  const [stats, setStats] = useState<BlogStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastGenerationResult, setLastGenerationResult] = useState<GenerationResult | null>(null);

  // Función helper para obtener semana del año
  const getCurrentWeekYear = () => {
    const date = new Date();
    const week = getWeekNumber(date);
    return `${date.getFullYear()}-W${week.toString().padStart(2, '0')}`;
  };

  const getWeekNumber = (date: Date) => {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
  };

  // Cargar estadísticas
  const loadStats = useCallback(async () => {
    try {
      setIsLoadingStats(true);
      
      // Mock data temporal mientras se resuelve el routing de Vercel
      // TODO: Cambiar por endpoint real cuando esté funcionando
      const mockStats = {
        currentWeek: getCurrentWeekYear(),
        weeklyLimits: {
          total: 2,
          'medico-estetico': 1,
          'tecnico': 1
        },
        generated: {
          total: 1,
          'medico-estetico': 1,
          'tecnico': 0
        },
        canGenerate: {
          'medico-estetico': false,
          'tecnico': true,
          any: true
        }
      };
      
      setStats(mockStats);
      
      /* Código original - restaurar cuando el endpoint funcione
      const response = await fetch('/api/ai-blog/stats');
      const data = await response.json();
      
      if (data.success) {
        setStats(data.stats);
      } else {
        console.error('Error cargando estadísticas:', data.message);
      }
      */
    } catch (error) {
      console.error('Error de conexión al cargar estadísticas:', error);
    } finally {
      setIsLoadingStats(false);
    }
  }, []);

  // Generar blog
  const generateBlog = useCallback(async (request: GenerationRequest): Promise<GenerationResult> => {
    setIsGenerating(true);
    setLastGenerationResult(null);

    try {
      const response = await fetch('/api/ai-blog/generate-production', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request)
      });

      // Verificar si la respuesta es válida
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} - ${response.statusText}`);
      }

      // Verificar si la respuesta es JSON válido
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const textResponse = await response.text();
        console.error('Respuesta no es JSON:', textResponse);
        throw new Error('El servidor devolvió una respuesta no válida (HTML en lugar de JSON)');
      }

      const result = await response.json();
      setLastGenerationResult(result);

      // Si la generación fue exitosa, sincronizar con localStorage
      if (result.success && result.blog) {
        try {
          // Importar y usar la función de sincronización
          // @ts-ignore
          const { syncBlogToLocalStorage } = await import('../../lib/frontend-blog-sync.js');
          const synced = syncBlogToLocalStorage(result.blog);
          
          if (synced) {
            console.log('Blog sincronizado con localStorage:', result.blog.title);
          }
        } catch (syncError) {
          console.warn('Error sincronizando blog:', syncError);
        }
      }

      // Actualizar estadísticas si la generación fue exitosa
      if (result.success && stats) {
        const newStats = { ...stats };
        newStats.generated.total += 1;
        newStats.generated[request.blogType] += 1;
        
        // Recalcular si se puede generar más
        newStats.canGenerate['medico-estetico'] = newStats.generated['medico-estetico'] < newStats.weeklyLimits['medico-estetico'];
        newStats.canGenerate['tecnico'] = newStats.generated['tecnico'] < newStats.weeklyLimits['tecnico'];
        newStats.canGenerate.any = newStats.generated.total < newStats.weeklyLimits.total;
        
        setStats(newStats);
      }

      return result;
    } catch (error) {
      const errorResult: GenerationResult = {
        success: false,
        message: 'Error de conexión o servidor',
        error: error instanceof Error ? error.message : String(error)
      };
      
      setLastGenerationResult(errorResult);
      return errorResult;
    } finally {
      setIsGenerating(false);
    }
  }, [stats]);

  // Limpiar resultado anterior
  const clearLastResult = useCallback(() => {
    setLastGenerationResult(null);
  }, []);

  // Cargar estadísticas al montar el componente
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return {
    // Estado
    stats,
    isLoadingStats,
    isGenerating,
    lastGenerationResult,
    
    // Acciones
    generateBlog,
    loadStats,
    clearLastResult,
    
    // Utilidades
    canGenerate: (type?: 'medico-estetico' | 'tecnico') => {
      if (!stats) return false;
      return type ? stats.canGenerate[type] : stats.canGenerate.any;
    },
    
    getRemainingSlots: (type?: 'medico-estetico' | 'tecnico') => {
      if (!stats) return 0;
      if (type) {
        return Math.max(0, stats.weeklyLimits[type] - stats.generated[type]);
      }
      return Math.max(0, stats.weeklyLimits.total - stats.generated.total);
    },
    
    getProgress: () => {
      if (!stats) return 0;
      return (stats.generated.total / stats.weeklyLimits.total) * 100;
    }
  };
};

export default useBlogAdmin;