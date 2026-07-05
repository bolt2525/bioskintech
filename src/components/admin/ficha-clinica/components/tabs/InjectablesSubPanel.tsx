import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Syringe, Plus, Save, Trash2,
  ChevronDown, ChevronUp, Box
} from 'lucide-react';
import injectablesCatalog from '../../data/injectables.json';
import Clinical3DViewer, { Marker3D } from '../Clinical3DViewer';

// ==========================================
// TYPES
// ==========================================

interface Injectable {
  id?: number;
  record_id?: number;
  treatment_id?: number;
  date: string;
  product_type: 'toxina' | 'relleno';
  product_name: string;
  brand: string;
  lot_number: string;
  expiration_date: string;
  volume_used: number | string;
  units_used: number | string;
  areas_treated: any;
  technique: string;
  injection_plane: string;
  needle_type: string;
  mapping_data: any;
  notes: string;
}

interface InjectablesSubPanelProps {
  recordId: number;
  treatmentId?: number;
  onMessage?: (msg: { type: 'success' | 'error'; text: string }) => void;
}

// ==========================================
// HELPERS — catalog lookups
// ==========================================

const getCatalogItems = (category: string): string[] => {
  return injectablesCatalog
    .filter((item: any) => item.categoria === category && item.activo === 1)
    .map((item: any) => item.elemento);
};

const toxinaBrands = getCatalogItems('marca_toxina');
const rellenoBrands = getCatalogItems('marca_relleno');
const techniques = getCatalogItems('tecnica_inyectable');
const needles = getCatalogItems('aguja_inyectable');
const planesInyeccion = getCatalogItems('planos_inyeccion');
const zonasSuperior = getCatalogItems('tercio_superior');
const zonasMedia = getCatalogItems('tercio_medio');
const zonasInferior = getCatalogItems('tercio_inferior');
const allZones = [...zonasSuperior, ...zonasMedia, ...zonasInferior];

const EMPTY_INJECTABLE: Injectable = {
  date: new Date().toISOString().split('T')[0],
  product_type: 'toxina',
  product_name: '',
  brand: '',
  lot_number: '',
  expiration_date: '',
  volume_used: '',
  units_used: '',
  areas_treated: [],
  technique: '',
  injection_plane: '',
  needle_type: '',
  mapping_data: null,
  notes: '',
};

// ==========================================
// COMPONENT
// ==========================================

export default function InjectablesSubPanel({ recordId, treatmentId, onMessage }: InjectablesSubPanelProps) {
  const [injectables, setInjectables] = useState<Injectable[]>([]);
  const [current, setCurrent] = useState<Injectable>({ ...EMPTY_INJECTABLE });
  const [saving, setSaving] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const [markers3D, setMarkers3D] = useState<Marker3D[]>([]);
  const [_loading, setLoading] = useState(false);

  // Load injectables for current treatment
  const loadInjectables = useCallback(async () => {
    if (!treatmentId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/records?action=getInjectablesByTreatment&treatment_id=${treatmentId}`);
      if (res.ok) {
        const data = await res.json();
        setInjectables(data);
      }
    } catch (e) {
      console.error('Error loading injectables:', e);
    } finally {
      setLoading(false);
    }
  }, [treatmentId]);

  useEffect(() => {
    loadInjectables();
  }, [loadInjectables]);

  // When selecting an existing injectable, load its mapping data as markers
  useEffect(() => {
    if (current.mapping_data) {
      try {
        const parsed = typeof current.mapping_data === 'string'
          ? JSON.parse(current.mapping_data)
          : current.mapping_data;
        if (Array.isArray(parsed)) {
          setMarkers3D(parsed);
        }
      } catch {
        setMarkers3D([]);
      }
    } else {
      setMarkers3D([]);
    }
  }, [current.id]);

  const handleSave = async () => {
    if (!current.product_name.trim()) {
      onMessage?.({ type: 'error', text: 'El nombre del producto es obligatorio' });
      return;
    }
    setSaving(true);
    try {
      const action = current.id ? 'updateInjectable' : 'addInjectable';
      const payload = {
        ...current,
        record_id: recordId,
        treatment_id: treatmentId,
        mapping_data: markers3D.length > 0 ? markers3D : null,
        areas_treated: current.areas_treated && current.areas_treated.length > 0
          ? current.areas_treated
          : null,
      };

      const res = await fetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        onMessage?.({ type: 'success', text: 'Inyectable guardado correctamente' });
        await loadInjectables();
        if (!current.id) handleNew();
      } else {
        throw new Error('Error al guardar');
      }
    } catch (error) {
      console.error('Error saving injectable:', error);
      onMessage?.({ type: 'error', text: 'Error al guardar el inyectable' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!current.id || !confirm('¿Eliminar este registro de inyectable?')) return;
    try {
      const res = await fetch(`/api/records?action=deleteInjectable&id=${current.id}`, { method: 'DELETE' });
      if (res.ok) {
        onMessage?.({ type: 'success', text: 'Inyectable eliminado' });
        await loadInjectables();
        handleNew();
      }
    } catch (error) {
      console.error('Error deleting injectable:', error);
      onMessage?.({ type: 'error', text: 'Error al eliminar' });
    }
  };

  const handleNew = () => {
    setCurrent({ ...EMPTY_INJECTABLE });
    setMarkers3D([]);
  };

  const handleSelect = (inj: Injectable) => {
    setCurrent({ ...inj });
  };

  const handleMarkerPlaced = (marker: Marker3D) => {
    setMarkers3D(prev => [...prev, marker]);
  };

  const brands = current.product_type === 'toxina' ? toxinaBrands : rellenoBrands;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="border-t border-[#deb887]/30 pt-6 mt-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-gray-800 flex items-center gap-2 text-sm">
          <div className="p-1.5 bg-violet-100 rounded-lg">
            <Syringe className="w-4 h-4 text-violet-600" />
          </div>
          Registro de Inyectables
        </h3>
        <div className="flex gap-2">
          <button
            onClick={handleNew}
            className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 border border-gray-200"
            title="Nuevo inyectable"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="p-1.5 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] shadow-sm disabled:opacity-50"
            title="Guardar"
          >
            <Save className="w-4 h-4" />
          </button>
          <button
            onClick={handleDelete}
            disabled={!current.id}
            className="p-1.5 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 disabled:opacity-50"
            title="Eliminar"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* History list (compact) */}
      {injectables.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {injectables.map((inj, idx) => (
            <button
              key={inj.id || idx}
              onClick={() => handleSelect(inj)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                current.id === inj.id
                  ? 'bg-violet-100 border-violet-300 text-violet-700'
                  : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {inj.product_name || 'Sin nombre'} — {inj.product_type}
            </button>
          ))}
        </div>
      )}

      {/* Form */}
      <div className="space-y-4">
        {/* Row 1: Type + Date */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Tipo</label>
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setCurrent({ ...current, product_type: 'toxina', brand: '' })}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  current.product_type === 'toxina'
                    ? 'bg-white text-cyan-700 shadow-sm'
                    : 'text-gray-500'
                }`}
              >
                Toxina
              </button>
              <button
                onClick={() => setCurrent({ ...current, product_type: 'relleno', brand: '' })}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  current.product_type === 'relleno'
                    ? 'bg-white text-violet-700 shadow-sm'
                    : 'text-gray-500'
                }`}
              >
                Relleno (HA)
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Fecha</label>
            <input
              type="date"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.date}
              onChange={e => setCurrent({ ...current, date: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Marca / Producto</label>
            <input
              type="text"
              list="injectable-brands"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.brand}
              onChange={e => setCurrent({ ...current, brand: e.target.value })}
              placeholder={current.product_type === 'toxina' ? 'Ej: BOTOX® 100UI' : 'Ej: Juvederm Ultra'}
            />
            <datalist id="injectable-brands">
              {brands.map((b, i) => <option key={i} value={b} />)}
            </datalist>
          </div>
        </div>

        {/* Row 2: Product name, Lot, Expiration */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Nombre del Producto</label>
            <input
              type="text"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.product_name}
              onChange={e => setCurrent({ ...current, product_name: e.target.value })}
              placeholder="Nombre comercial"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Lote</label>
            <input
              type="text"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.lot_number}
              onChange={e => setCurrent({ ...current, lot_number: e.target.value })}
              placeholder="Nro. de lote"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Vencimiento</label>
            <input
              type="date"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.expiration_date}
              onChange={e => setCurrent({ ...current, expiration_date: e.target.value })}
            />
          </div>
        </div>

        {/* Row 3: Volume/Units + Technique + Plane + Needle */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {current.product_type === 'toxina' ? (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-600">Unidades (UI)</label>
              <input
                type="number"
                step="0.5"
                className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
                value={current.units_used}
                onChange={e => setCurrent({ ...current, units_used: e.target.value })}
                placeholder="Ej: 20"
              />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-600">Volumen (ml)</label>
              <input
                type="number"
                step="0.1"
                className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
                value={current.volume_used}
                onChange={e => setCurrent({ ...current, volume_used: e.target.value })}
                placeholder="Ej: 1.0"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Técnica</label>
            <input
              type="text"
              list="injectable-techniques"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.technique}
              onChange={e => setCurrent({ ...current, technique: e.target.value })}
              placeholder="Técnica de inyección"
            />
            <datalist id="injectable-techniques">
              {techniques.map((t, i) => <option key={i} value={t} />)}
            </datalist>
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Plano</label>
            <input
              type="text"
              list="injectable-planes"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.injection_plane}
              onChange={e => setCurrent({ ...current, injection_plane: e.target.value })}
              placeholder="Plano de inyección"
            />
            <datalist id="injectable-planes">
              {planesInyeccion.map((p, i) => <option key={i} value={p} />)}
            </datalist>
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Aguja / Cánula</label>
            <input
              type="text"
              list="injectable-needles"
              className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={current.needle_type}
              onChange={e => setCurrent({ ...current, needle_type: e.target.value })}
              placeholder="Tipo de aguja"
            />
            <datalist id="injectable-needles">
              {needles.map((n, i) => <option key={i} value={n} />)}
            </datalist>
          </div>
        </div>

        {/* Row 4: Zones treated */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">Zonas Tratadas</label>
          <div className="flex flex-wrap gap-1.5">
            {allZones.map((zone, i) => {
              const currentAreas = Array.isArray(current.areas_treated) ? current.areas_treated : [];
              const isSelected = currentAreas.includes(zone);
              return (
                <button
                  key={i}
                  onClick={() => {
                    const updated = isSelected
                      ? currentAreas.filter((z: string) => z !== zone)
                      : [...currentAreas, zone];
                    setCurrent({ ...current, areas_treated: updated });
                  }}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all ${
                    isSelected
                      ? 'bg-[#deb887]/20 border-[#deb887] text-[#b8944d]'
                      : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {zone}
                </button>
              );
            })}
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">Observaciones</label>
          <textarea
            rows={2}
            className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none resize-none bg-gray-50/50"
            value={current.notes}
            onChange={e => setCurrent({ ...current, notes: e.target.value })}
            placeholder="Notas clínicas, reacciones, etc."
          />
        </div>

        {/* 3D Mapping Toggle */}
        <div className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setShow3D(!show3D)}
            className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-[#deb887] transition-colors"
          >
            <Box className="w-4 h-4" />
            Mapeo Facial 3D
            {show3D ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {markers3D.length > 0 && (
              <span className="ml-1 bg-violet-100 text-violet-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {markers3D.length}
              </span>
            )}
          </button>

          <AnimatePresence>
            {show3D && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3"
              >
                <Clinical3DViewer
                  markers={markers3D}
                  selectedPathology={current.product_type === 'toxina' ? 'botox' : 'filler'}
                  onMarkerPlaced={handleMarkerPlaced}
                  height="350px"
                />
                {markers3D.length > 0 && (
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-gray-500">
                      {markers3D.length} punto(s) marcado(s)
                    </span>
                    <button
                      onClick={() => setMarkers3D([])}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      Limpiar marcadores
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
