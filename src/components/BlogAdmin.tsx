// src/components/BlogAdmin.tsx
// Componente de administración para generar blogs con IA

import React, { useState } from 'react';
import { Plus, Sparkles, FileText, Settings, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import useBlogAdmin from '../hooks/useBlogAdmin';

const BlogAdmin: React.FC = () => {
  const [blogType, setBlogType] = useState<'medico-estetico' | 'tecnico'>('medico-estetico');
  const [customTopic, setCustomTopic] = useState('');
  const [suggestedTopics, setSuggestedTopics] = useState<Record<string, string[]>>({});
  const [isRefreshingTopics, setIsRefreshingTopics] = useState(false);
  
  const {
    stats,
    isGenerating,
    lastGenerationResult,
    generateBlog,
    canGenerate
  } = useBlogAdmin();

  const handleGenerateBlog = async () => {
    await generateBlog({
      blogType,
      topic: customTopic || undefined,
      manual: true
    });
  };

  // ✅ NUEVA FUNCIÓN: Refrescar temas sugeridos con IA
  const refreshSuggestedTopics = async () => {
    setIsRefreshingTopics(true);
    try {
      const response = await fetch('/api/ai-blog/generate-topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: blogType })
      });
      
      const data = await response.json();
      if (data.success) {
        setSuggestedTopics(prev => ({ ...prev, [blogType]: data.topics }));
      }
    } catch (error) {
      console.error('Error generando temas:', error);
    } finally {
      setIsRefreshingTopics(false);
    }
  };

  const predefinedTopics = {
    'medico-estetico': [
      'Beneficios del tratamiento HIFU para rejuvenecimiento facial',
      'Medicina regenerativa con exosomas: la revolución antiaging',
      'Hidratación profunda facial: protocolos y resultados',
      'Tratamientos de manchas faciales con tecnología láser',
      'Lifting no invasivo: comparativa de tecnologías',
    ],
    'tecnico': [
      'Análisis técnico de equipos de radiofrecuencia monopolar',
      'Innovaciones en tecnología láser CO2 fraccionado',
      'Sistemas de diagnóstico por imagen en medicina estética',
      'Protocolos de calibración para equipos IPL',
      'Comparativa de tecnologías HIFU: eficacia y seguridad',
    ]
  };

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="w-8 h-8 text-[#deb887]" />
        <h2 className="text-2xl font-bold text-gray-800">Administración de Blogs IA</h2>
      </div>

      {/* Estadísticas Semanales */}
      <div className="bg-gray-50 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-gray-600" />
            <span className="font-semibold text-gray-700">Límite Semanal</span>
          </div>
          <div className="text-right">
            <span className={`text-lg font-bold ${canGenerate() ? 'text-green-600' : 'text-red-600'}`}>
              {stats?.generated.total || 0} / {stats?.weeklyLimits.total || 0}
            </span>
            <p className="text-sm text-gray-500">blogs generados esta semana</p>
          </div>
        </div>
      </div>

      {/* Configuración de Generación */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        
        {/* Tipo de Blog */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Tipo de Blog
          </label>
          <div className="space-y-2">
            <label className="flex items-center">
              <input
                type="radio"
                name="blogType"
                value="medico-estetico"
                checked={blogType === 'medico-estetico'}
                onChange={(e) => setBlogType(e.target.value as 'medico-estetico')}
                className="mr-3"
              />
              <span className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-pink-500" />
                Médico Estético
              </span>
            </label>
            <label className="flex items-center">
              <input
                type="radio"
                name="blogType"
                value="tecnico"
                checked={blogType === 'tecnico'}
                onChange={(e) => setBlogType(e.target.value as 'tecnico')}
                className="mr-3"
              />
              <span className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-500" />
                Técnico
              </span>
            </label>
          </div>
        </div>

        {/* Tema Personalizado */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Tema Personalizado (Opcional)
          </label>
          <textarea
            value={customTopic}
            onChange={(e) => setCustomTopic(e.target.value)}
            placeholder="Escribe un tema específico o deja en blanco para generar automáticamente..."
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
            rows={3}
          />
          <div className="mt-2 p-2 bg-blue-50 rounded-lg border border-blue-200">
            <p className="text-xs text-blue-700 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              <strong>Búsqueda Inteligente:</strong> Las imágenes se buscan en tiempo real según tu tema específico usando IA
            </p>
          </div>
        </div>
      </div>

      {/* Temas Sugeridos */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            Temas Sugeridos para {blogType === 'medico-estetico' ? 'Médico Estético' : 'Técnico'}
          </h3>
          <button
            onClick={refreshSuggestedTopics}
            disabled={isRefreshingTopics}
            className="flex items-center gap-2 px-3 py-1 text-xs bg-[#deb887] text-white rounded-lg hover:bg-[#d4a574] transition-colors disabled:opacity-50"
          >
            <Sparkles className={`w-3 h-3 ${isRefreshingTopics ? 'animate-spin' : ''}`} />
            {isRefreshingTopics ? 'Generando...' : 'Temas Frescos IA'}
          </button>
        </div>
        <div className="grid gap-2">
          {/* Mostrar temas dinámicos si existen, sino usar predefinidos */}
          {(suggestedTopics[blogType] || predefinedTopics[blogType]).map((topic, index) => (
            <button
              key={index}
              onClick={() => setCustomTopic(topic)}
              className="text-left p-3 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm text-gray-700 transition-colors border border-transparent hover:border-[#deb887]"
            >
              {topic}
            </button>
          ))}
        </div>
      </div>

      {/* Botón de Generación */}
      <button
        onClick={handleGenerateBlog}
        disabled={isGenerating || !canGenerate()}
        className={`w-full flex items-center justify-center gap-2 py-4 px-6 rounded-lg font-semibold text-white transition-all ${
          canGenerate() && !isGenerating
            ? 'bg-[#deb887] hover:bg-[#d4a574] shadow-lg hover:shadow-xl'
            : 'bg-gray-400 cursor-not-allowed'
        }`}
      >
        {isGenerating ? (
          <>
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
            Generando Blog con IA...
          </>
        ) : !canGenerate ? (
          <>
            <AlertCircle className="w-5 h-5" />
            Límite Semanal Alcanzado
          </>
        ) : (
          <>
            <Plus className="w-5 h-5" />
            Generar Blog con IA
          </>
        )}
      </button>

      {/* Resultado de Generación */}
      {lastGenerationResult && (
        <div className={`mt-6 p-4 rounded-lg ${
          lastGenerationResult.success 
            ? 'bg-green-50 border border-green-200' 
            : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-center gap-2 mb-3">
            {lastGenerationResult.success ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-600" />
            )}
            <span className={`font-semibold ${
              lastGenerationResult.success ? 'text-green-800' : 'text-red-800'
            }`}>
              {lastGenerationResult.message}
            </span>
          </div>

          {lastGenerationResult.success && lastGenerationResult.blog && (
            <div className="space-y-2 text-sm">
              <p><strong>Título:</strong> {lastGenerationResult.blog.title}</p>
              <p><strong>Categoría:</strong> {lastGenerationResult.blog.category}</p>
              <p><strong>Tiempo de lectura:</strong> {lastGenerationResult.blog.read_time} minutos</p>
              <p><strong>Palabras:</strong> {lastGenerationResult.meta?.wordCount || 'N/A'}</p>
              <p><strong>Tags:</strong> {lastGenerationResult.blog.tags.join(', ')}</p>
              <p><strong>Extracto:</strong> {lastGenerationResult.blog.excerpt}</p>
              
              <div className="mt-4 p-3 bg-white rounded border">
                <p className="text-green-700">
                  ✅ Blog generado exitosamente y guardado con slug: <code>{lastGenerationResult.blog.slug}</code>
                </p>
              </div>
            </div>
          )}

          {!lastGenerationResult.success && lastGenerationResult.error && (
            <div className="mt-2 p-3 bg-red-100 rounded border text-sm text-red-700">
              <strong>Error:</strong> {JSON.stringify(lastGenerationResult.error, null, 2)}
            </div>
          )}
        </div>
      )}

      {/* Información del Sistema */}
      <div className="mt-8 p-4 bg-blue-50 rounded-lg text-sm text-blue-800">
        <h4 className="font-semibold mb-2">ℹ️ Información del Sistema</h4>
        <ul className="space-y-1 list-disc list-inside">
          <li>Los blogs se generan automáticamente con GPT-4o-mini</li>
          <li>Cada blog tiene entre 500-700 palabras con estructura profesional</li>
          <li>Límite: 2 blogs por semana (1 médico-estético + 1 técnico)</li>
          <li>Los blogs aparecerán automáticamente en la sección pública</li>
          <li>Sistema optimizado para SEO y legibilidad</li>
        </ul>
      </div>
    </div>
  );
};

export default BlogAdmin;