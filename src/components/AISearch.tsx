import React, { useState, useRef, useEffect } from 'react';
import { Search, X, ArrowRight, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { slugify } from '../utils/slugify';
import products from '../data/products';
import { services } from '../data/services';

interface SearchResult {
  name: string;
  type: 'product' | 'service' | 'page' | 'blog';
  description: string;
  url?: string;
}

interface AISearchProps {
  inline?: boolean;
  variant?: 'floating' | 'icon' | 'bar';
  className?: string;
}

const staticPages = [
  { name: 'Agenda / Reserva', keywords: ['agenda', 'reserva', 'cita', 'turno', 'agendar'], url: '/appointment', description: 'Agenda tu cita médica o estética' },
  { name: 'Contacto / Ubicación', keywords: ['contacto', 'ubicacion', 'direccion', 'donde', 'telefono', 'email'], url: '/contact', description: 'Información de contacto y ubicación' },
  { name: 'Nosotros', keywords: ['nosotros', 'equipo', 'doctora', 'quienes', 'somos'], url: '/about', description: 'Conoce a nuestro equipo y la Dra. Daniela Creamer' },
  { name: 'Blog', keywords: ['blog', 'articulos', 'noticias', 'consejos', 'tips'], url: '/blogs', description: 'Artículos sobre salud y estética' },
  { name: 'Resultados', keywords: ['resultados', 'antes', 'despues', 'casos', 'fotos'], url: '/results', description: 'Galería de resultados de tratamientos' },
  { name: 'Diagnóstico', keywords: ['diagnostico', 'evaluacion', 'test', 'piel'], url: '/diagnosis', description: 'Realiza un diagnóstico de piel en línea' },
];

export default function AISearch({ inline = false, variant = 'floating', className = '' }: AISearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [localSuggestions, setLocalSuggestions] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Determine actual variant based on inline prop for backward compatibility
  const actualVariant = inline ? 'icon' : variant;

  useEffect(() => {
    if (isOpen && inputRef.current && actualVariant !== 'bar') {
      inputRef.current.focus();
    }
  }, [isOpen, actualVariant]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (actualVariant === 'bar') {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsOpen(false);
        }
      } else {
        if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
          setIsOpen(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, actualVariant]);

  // Local Autocomplete
  useEffect(() => {
    if (!query.trim()) {
      setLocalSuggestions([]);
      if (actualVariant === 'bar') setIsOpen(false);
      return;
    }

    if (actualVariant === 'bar') setIsOpen(true);

    const lowerQuery = query.toLowerCase();
    
    // 1. Search Static Pages
    const matchedPages = staticPages
      .filter(page => 
        page.name.toLowerCase().includes(lowerQuery) || 
        page.keywords.some(k => k.includes(lowerQuery))
      )
      .map(page => ({
        name: page.name,
        type: 'page' as const,
        description: page.description,
        url: page.url
      }));

    // 2. Search Products
    const matchedProducts = products
      .filter(p => p.name.toLowerCase().includes(lowerQuery))
      .map(p => ({
        name: p.name,
        type: 'product' as const,
        description: p.shortDescription,
        url: `/products/${slugify(p.name)}`
      }))
      .slice(0, 3);

    // 3. Search Services
    const matchedServices = services
      .filter(s => s.title.toLowerCase().includes(lowerQuery))
      .map(s => ({
        name: s.title,
        type: 'service' as const,
        description: s.shortDescription,
        url: `/services#${s.id}`
      }))
      .slice(0, 3);

    setLocalSuggestions([...matchedPages, ...matchedProducts, ...matchedServices]);
  }, [query, actualVariant]);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setResults([]);
    setAnswer(null);
    setSuggestion(null);
    // Clear local suggestions to show AI results
    setLocalSuggestions([]);
    setIsOpen(true);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      setResults(data.results || []);
      setAnswer(data.answer);
      setSuggestion(data.suggestion);
    } catch (error) {
      console.error('Search error:', error);
      setAnswer('Lo siento, hubo un error al buscar. Por favor intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const handleNavigate = (result: SearchResult) => {
    setIsOpen(false);
    if (actualVariant === 'bar') setQuery(''); // Clear query in bar mode after nav
    
    if (result.url) {
      if (result.url.includes('#')) {
        const [path, hash] = result.url.split('#');
        navigate(path);
        // Small delay to allow navigation to complete before scrolling
        setTimeout(() => {
          const element = document.getElementById(hash);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Add highlight effect
            element.classList.add('ring-4', 'ring-gold-400', 'transition-all', 'duration-500');
            setTimeout(() => element.classList.remove('ring-4', 'ring-gold-400'), 2000);
          }
        }, 100);
      } else {
        navigate(result.url);
      }
    } else {
      // Fallback logic
      if (result.type === 'product') {
        navigate(`/products/${slugify(result.name)}`);
      } else if (result.type === 'service') {
        navigate(`/services`);
      } else if (result.type === 'page' && result.url) {
        navigate(result.url);
      }
    }
  };

  if (window.location.pathname.startsWith('/admin')) return null;

  // Render Bar Variant
  if (actualVariant === 'bar') {
    return (
      <div ref={containerRef} className={`relative w-full max-w-2xl mx-auto ${className}`}>
        <form onSubmit={handleSearch} className="relative flex items-center">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (query.trim()) setIsOpen(true); }}
            placeholder="Buscar..."
            className="w-full py-2 pl-4 pr-10 bg-gray-100 border border-transparent focus:bg-white focus:border-gray-200 rounded-md text-gray-700 placeholder-gray-400 outline-none transition-all duration-200"
          />
          <button 
            type="submit"
            className="absolute right-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
            disabled={loading}
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
          </button>
        </form>

        {/* Dropdown Results for Bar Variant */}
        {isOpen && (query.trim() || results.length > 0 || answer) && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-lg shadow-xl border border-gray-100 overflow-hidden z-50 max-h-[60vh] overflow-y-auto">
            <div className="p-2">
              {answer && (
                <div className="bg-gold-50/50 p-3 rounded-lg mb-2 text-sm text-gray-700">
                  {answer}
                </div>
              )}

              {(localSuggestions.length > 0 || results.length > 0) ? (
                <div className="space-y-1">
                  {[...localSuggestions, ...results].map((result, index) => (
                    <button
                      key={index}
                      onClick={() => handleNavigate(result)}
                      className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-gray-50 transition-colors text-left group"
                    >
                      <div className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 ${
                        result.type === 'product' ? 'bg-blue-50 text-blue-500' : 
                        result.type === 'service' ? 'bg-purple-50 text-purple-500' :
                        result.type === 'page' ? 'bg-green-50 text-green-500' :
                        'bg-orange-50 text-orange-500'
                      }`}>
                        {result.type === 'product' ? '🛍️' : 
                         result.type === 'service' ? '💆‍♀️' :
                         result.type === 'page' ? '🔗' : '📝'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-gray-900 truncate group-hover:text-gold-600">
                          {result.name}
                        </h4>
                        <p className="text-xs text-gray-500 truncate">{result.description}</p>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                !loading && query.trim() && !answer && (
                  <div className="p-4 text-center text-gray-400 text-sm">
                    No se encontraron resultados
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render Icon/Floating Variant
  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={actualVariant === 'icon'
          ? `p-2 text-gray-600 hover:text-[#deb887] transition-colors ${className}`
          : `fixed bottom-6 right-6 z-40 p-4 rounded-full shadow-lg transition-all duration-300 hover:scale-110 group ${
              isOpen ? 'bg-gray-200 text-gray-600 scale-0 opacity-0' : 'bg-gold-500 text-white scale-100 opacity-100'
            } ${className}`
        }
        aria-label="Buscar"
      >
        <Search className="w-6 h-6" />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-black/50 backdrop-blur-sm transition-opacity">
          <div 
            ref={modalRef}
            className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in duration-200"
          >
            <div className="p-4 border-b border-gray-100 flex items-center gap-3 bg-gray-50/50">
              <Search className="w-6 h-6 text-gold-500" />
              <form onSubmit={handleSearch} className="flex-1 relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar tratamientos, productos..."
                  className="w-full bg-transparent border-none outline-none text-lg text-gray-800 placeholder-gray-400"
                />
                {query && (
                  <button 
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-0 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </form>
              <button 
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className="p-2 bg-gold-500 text-white rounded-lg hover:bg-gold-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
              </button>
            </div>

            <div className="overflow-y-auto p-4 space-y-6">
              
              {answer && (
                <div className="bg-gold-50/50 p-4 rounded-xl border border-gold-100">
                  <div className="flex items-start gap-3">
                    <Search className="w-5 h-5 text-gold-500 mt-1 flex-shrink-0" />
                    <p className="text-gray-700 leading-relaxed">{answer}</p>
                  </div>
                </div>
              )}

              {/* Local Suggestions (Autocomplete) */}
              {!loading && !answer && localSuggestions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Sugerencias</h3>
                  <div className="grid gap-3">
                    {localSuggestions.map((result, index) => (
                      <button
                        key={index}
                        onClick={() => handleNavigate(result)}
                        className="flex items-start gap-4 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left group border border-transparent hover:border-gray-100"
                      >
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          result.type === 'product' ? 'bg-blue-50 text-blue-500' : 
                          result.type === 'service' ? 'bg-purple-50 text-purple-500' :
                          result.type === 'page' ? 'bg-green-50 text-green-500' :
                          'bg-orange-50 text-orange-500'
                        }`}>
                          {result.type === 'product' ? '🛍️' : 
                           result.type === 'service' ? '💆‍♀️' :
                           result.type === 'page' ? '🔗' : '📝'}
                        </div>
                        <div className="flex-1">
                          <h4 className="font-medium text-gray-900 group-hover:text-gold-600 transition-colors">
                            {result.name}
                          </h4>
                          <p className="text-sm text-gray-500 line-clamp-2">{result.description}</p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-gold-500 mt-1" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Results */}
              {results.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Resultados</h3>
                  <div className="grid gap-3">
                    {results.map((result, index) => (
                      <button
                        key={index}
                        onClick={() => handleNavigate(result)}
                        className="flex items-start gap-4 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left group border border-transparent hover:border-gray-100"
                      >
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          result.type === 'product' ? 'bg-blue-50 text-blue-500' : 
                          result.type === 'service' ? 'bg-purple-50 text-purple-500' :
                          result.type === 'page' ? 'bg-green-50 text-green-500' :
                          'bg-orange-50 text-orange-500'
                        }`}>
                          {result.type === 'product' ? '🛍️' : 
                           result.type === 'service' ? '💆‍♀️' :
                           result.type === 'page' ? '🔗' : '📝'}
                        </div>
                        <div className="flex-1">
                          <h4 className="font-medium text-gray-900 group-hover:text-gold-600 transition-colors">
                            {result.name}
                          </h4>
                          <p className="text-sm text-gray-500 line-clamp-2">{result.description}</p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-gold-500 mt-1" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {suggestion && (
                <div className="text-center py-4">
                  <p className="text-gray-500 text-sm">
                    ¿Quisiste decir <button onClick={() => { setQuery(suggestion); handleSearch(); }} className="text-gold-600 font-medium hover:underline">{suggestion}</button>?
                  </p>
                </div>
              )}

              {!loading && !answer && results.length === 0 && localSuggestions.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>Escribe tu consulta para buscar</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {['Tratamientos faciales', 'Cremas hidratantes', 'Depilación láser', 'Rejuvenecimiento'].map(tag => (
                      <button
                        key={tag}
                        onClick={() => { setQuery(tag); handleSearch(); }}
                        className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-full text-xs text-gray-600 transition-colors"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
