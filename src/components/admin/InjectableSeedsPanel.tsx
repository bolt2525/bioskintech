import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, ChevronDown, ChevronUp, Syringe, Droplets, FlaskConical, Pipette } from 'lucide-react';

interface CatalogItem {
  id: number;
  categoria: string;
  elemento: string;
  descripcion?: string;
}

interface InjectableSeedsPanelProps {
  authHeader: () => Record<string, string>;
}

const CATEGORY_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  marca_toxina:        { label: 'Marcas — Toxina Botulínica', icon: <FlaskConical className="w-4 h-4" />, color: 'text-amber-600 bg-amber-50 border-amber-200' },
  marca_relleno_ha:    { label: 'Marcas — Relleno HA',        icon: <Droplets className="w-4 h-4" />,    color: 'text-purple-600 bg-purple-50 border-purple-200' },
  marca_hidratacion:   { label: 'Marcas — Hidratación',       icon: <Pipette className="w-4 h-4" />,     color: 'text-sky-600 bg-sky-50 border-sky-200' },
  marca_bioestimulador:{ label: 'Marcas — Bioestimuladores',  icon: <Syringe className="w-4 h-4" />,     color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  tecnica_inyectable:  { label: 'Técnicas de Inyección',      icon: <Syringe className="w-4 h-4" />,     color: 'text-gray-600 bg-gray-50 border-gray-200' },
  aguja_inyectable:    { label: 'Agujas / Cánulas',           icon: <Syringe className="w-4 h-4" />,     color: 'text-gray-600 bg-gray-50 border-gray-200' },
  planos_inyeccion:    { label: 'Planos de Inyección',        icon: <Syringe className="w-4 h-4" />,     color: 'text-gray-600 bg-gray-50 border-gray-200' },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS);

export default function InjectableSeedsPanel({ authHeader }: InjectableSeedsPanelProps) {
  const [items, setItems]           = useState<CatalogItem[]>([]);
  const [loading, setLoading]       = useState(false);
  const [expanded, setExpanded]     = useState<string | null>('marca_relleno_ha');
  const [newEl, setNewEl]           = useState<Record<string, string>>({});
  const [saving, setSaving]         = useState<string | null>(null);
  const [deleting, setDeleting]     = useState<number | null>(null);
  const [message, setMessage]       = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/records?action=listInjectableCatalog', { headers: authHeader() });
      if (r.ok) setItems(await r.json());
    } finally {
      setLoading(false);
    }
  }, [authHeader]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(t);
  }, [message]);

  const handleAdd = async (categoria: string) => {
    const elemento = (newEl[categoria] || '').trim();
    if (!elemento) return;
    setSaving(categoria);
    try {
      const r = await fetch('/api/records?action=saveInjectableSeed', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoria, elemento }),
      });
      if (r.ok) {
        setNewEl(prev => ({ ...prev, [categoria]: '' }));
        setMessage({ type: 'success', text: `"${elemento}" agregado a ${CATEGORY_LABELS[categoria]?.label || categoria}` });
        load();
      } else {
        setMessage({ type: 'error', text: 'Error al guardar' });
      }
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (id: number, elemento: string) => {
    if (!confirm(`¿Eliminar "${elemento}" del catálogo?`)) return;
    setDeleting(id);
    try {
      const r = await fetch(`/api/records?action=deleteInjectableSeed&id=${id}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      if (r.ok) {
        setMessage({ type: 'success', text: `"${elemento}" eliminado` });
        load();
      } else {
        setMessage({ type: 'error', text: 'Error al eliminar' });
      }
    } finally {
      setDeleting(null);
    }
  };

  const byCategory = ALL_CATEGORIES.reduce((acc, cat) => {
    acc[cat] = items.filter(i => i.categoria === cat);
    return acc;
  }, {} as Record<string, CatalogItem[]>);

  // Also capture any extra categories not in ALL_CATEGORIES
  const extraCats = [...new Set(items.map(i => i.categoria))].filter(c => !ALL_CATEGORIES.includes(c));

  return (
    <div className="space-y-3">
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium border ${
              message.type === 'success'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                : 'bg-red-50 text-red-700 border-red-100'
            }`}
          >
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="text-sm text-gray-400 text-center py-4">Cargando catálogo...</div>
      ) : (
        [...ALL_CATEGORIES, ...extraCats].map(cat => {
          const meta = CATEGORY_LABELS[cat];
          const catItems = byCategory[cat] || items.filter(i => i.categoria === cat);
          const isExpanded = expanded === cat;
          return (
            <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpanded(isExpanded ? null : cat)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
              >
                <span className={`p-1.5 rounded-lg border ${meta?.color || 'text-gray-600 bg-gray-50 border-gray-200'}`}>
                  {meta?.icon || <Syringe className="w-4 h-4" />}
                </span>
                <span className="flex-1 text-sm font-semibold text-gray-800">{meta?.label || cat}</span>
                <span className="text-xs text-gray-400 font-medium">{catItems.length} items</span>
                {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="p-4 space-y-3 bg-white">
                      {/* Add new item */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder={`Ej: Nueva marca / producto`}
                          value={newEl[cat] || ''}
                          onChange={e => setNewEl(prev => ({ ...prev, [cat]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') handleAdd(cat); }}
                          className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
                        />
                        <button
                          onClick={() => handleAdd(cat)}
                          disabled={saving === cat || !(newEl[cat] || '').trim()}
                          className="flex items-center gap-1.5 px-3 py-2 bg-[#deb887] text-white text-sm font-medium rounded-lg hover:bg-[#c5a075] disabled:opacity-50 transition-colors"
                        >
                          {saving === cat
                            ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            : <Plus className="w-4 h-4" />}
                          Agregar
                        </button>
                      </div>

                      {catItems.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-2 italic">
                          Sin items personalizados — los estándar vienen del catálogo base
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {catItems.map(item => (
                            <div
                              key={item.id}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 rounded-lg text-sm text-gray-700 group"
                            >
                              <span className="truncate max-w-[200px]">{item.elemento}</span>
                              <button
                                onClick={() => handleDelete(item.id, item.elemento)}
                                disabled={deleting === item.id}
                                className="ml-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                              >
                                {deleting === item.id
                                  ? <div className="w-3 h-3 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" />
                                  : <Trash2 className="w-3 h-3" />}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })
      )}
    </div>
  );
}
