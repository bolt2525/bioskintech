import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Save, AlertCircle, ChevronRight, ChevronLeft, Package, Plus, Calendar, CheckCircle, Loader2 } from 'lucide-react';

interface InventoryFormProps {
  initialData?: any;
  suggestedSku?: string;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
  /** Called only on new products, with initial stock data */
  onSaveWithStock?: (itemData: any, stockData: any) => Promise<void>;
}

export default function InventoryForm({ initialData, suggestedSku, onClose, onSave, onSaveWithStock }: InventoryFormProps) {
  const isEditing = !!initialData?.id;
  const [step, setStep] = useState<1 | 2>(1);

  const [formData, setFormData] = useState({
    sku: initialData?.sku || '',
    name: initialData?.name || '',
    brand: initialData?.brand || '',
    description: initialData?.description || '',
    category: initialData?.category || 'Inyectable',
    group_name: initialData?.group_name || '',
    unit_of_measure: initialData?.unit_of_measure || 'Vial',
    min_stock_level: initialData?.min_stock_level ?? 5,
    requires_cold_chain: initialData?.requires_cold_chain || false,
    sanitary_registration: initialData?.sanitary_registration || '',
    cost_price: initialData?.cost_price ?? '',
    sale_price: initialData?.sale_price ?? ''
  });

  const [stockData, setStockData] = useState({
    batch_number: '',
    expiration_date: '',
    quantity: 1,
    cost_per_unit: 0
  });
  const [noExpiry, setNoExpiry] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const f = (field: string, value: any) => setFormData(p => ({ ...p, [field]: value }));

  const getPayloadFormData = () => {
    const typedSku = String(formData.sku || '').trim();
    const fallbackSku = !isEditing && suggestedSku ? suggestedSku : '';
    return {
      ...formData,
      sku: typedSku || fallbackSku,
    };
  };

  const handleStep1Next = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) { setError('El nombre es obligatorio'); return; }
    setError(null);
    if (isEditing) {
      handleFinalSave();
    } else {
      setStep(2);
    }
  };

  const handleFinalSave = async () => {
    setLoading(true);
    setError(null);
    try {
      await onSave({ ...getPayloadFormData(), id: initialData?.id });
      setDone(true);
      setTimeout(() => onClose(), 900);
    } catch (err: any) {
      setError(err.message || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  const handleStep2Save = async (skip: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const payloadFormData = getPayloadFormData();
      if (skip || !onSaveWithStock) {
        await onSave(payloadFormData);
      } else {
        const finalBatch = stockData.batch_number.trim()
          || `LOTE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 1000)}`;
        await onSaveWithStock(payloadFormData, {
          ...stockData,
          batch_number: finalBatch,
          expiration_date: noExpiry ? '2099-12-31' : stockData.expiration_date
        });
      }
      setDone(true);
      setTimeout(() => onClose(), 900);
    } catch (err: any) {
      setError(err.message || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887] focus:border-[#deb887] outline-none transition-all bg-gray-50 focus:bg-white";
  const labelCls = "block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide";

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-gray-900 text-lg">
              {isEditing ? 'Editar Producto' : 'Nuevo Producto'}
            </h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Step indicator — only for new products */}
          {!isEditing && (
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all ${step === 1 ? 'bg-[#deb887] text-white' : 'bg-emerald-100 text-emerald-700'}`}>
                {step === 1 ? <Package className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
                {step === 1 ? 'Datos del producto' : 'Producto ✓'}
              </div>
              <ChevronRight className="w-4 h-4 text-gray-300" />
              <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all ${step === 2 ? 'bg-[#deb887] text-white' : 'bg-gray-100 text-gray-400'}`}>
                <Plus className="w-3 h-3" />
                Stock inicial
              </div>
            </div>
          )}
        </div>

        {/* Success state */}
        <AnimatePresence>
          {done && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-16 px-6"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4"
              >
                <CheckCircle className="w-8 h-8 text-emerald-600" />
              </motion.div>
              <p className="text-gray-700 font-semibold">¡Guardado exitosamente!</p>
            </motion.div>
          )}
        </AnimatePresence>

        {!done && (
          <>
            {/* Step 1: Product data */}
            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.form
                  key="step1"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  onSubmit={handleStep1Next}
                  className="p-6 space-y-4 overflow-y-auto max-h-[65vh]"
                >
                  {error && (
                    <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm flex items-center gap-2 border border-red-100">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {error}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>SKU / Código</label>
                      <input type="text" className={inputCls} value={formData.sku}
                        onChange={e => f('sku', e.target.value)}
                        placeholder={!isEditing && suggestedSku ? suggestedSku : 'Ej. BOT-001'} />
                    </div>
                    <div>
                      <label className={labelCls}>Nombre *</label>
                      <input type="text" required className={inputCls} value={formData.name}
                        onChange={e => f('name', e.target.value)} placeholder="Nombre del producto" />
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Marca</label>
                    <input type="text" className={inputCls} value={formData.brand}
                      onChange={e => f('brand', e.target.value)} placeholder="Ej. Allergan, Galderma" />
                  </div>

                  <div>
                    <label className={labelCls}>Descripción</label>
                    <textarea className={`${inputCls} resize-none`} rows={2} value={formData.description}
                      onChange={e => f('description', e.target.value)} placeholder="Descripción breve..." />
                  </div>

                  <div>
                    <label className={labelCls}>Registro Sanitario</label>
                    <input type="text" className={inputCls} value={formData.sanitary_registration}
                      onChange={e => f('sanitary_registration', e.target.value)} placeholder="Ej. ISP-12345" />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Categoría</label>
                      <select className={inputCls} value={formData.category} onChange={e => f('category', e.target.value)}>
                        <option>Inyectable</option>
                        <option>Consumible</option>
                        <option>Venta</option>
                        <option>Equipamiento</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Grupo / Subcategoría</label>
                      <input type="text" className={inputCls} value={formData.group_name}
                        onChange={e => f('group_name', e.target.value)} placeholder="Ej. Rellenos" />
                    </div>
                  </div>

                  {/* Precios — solo para categoría Venta */}
                  {formData.category === 'Venta' && (
                    <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-100 space-y-3">
                      <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Precios de referencia</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>Costo de adquisición <span className="normal-case font-normal text-gray-400">(opcional)</span></label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                            <input
                              type="number" step="0.01" min="0" placeholder="0.00"
                              className={`${inputCls} pl-7`}
                              value={formData.cost_price}
                              onChange={e => f('cost_price', e.target.value)}
                            />
                          </div>
                        </div>
                        <div>
                          <label className={labelCls}>Precio de venta</label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                            <input
                              type="number" step="0.01" min="0" placeholder="0.00"
                              className={`${inputCls} pl-7`}
                              value={formData.sale_price}
                              onChange={e => f('sale_price', e.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                      {formData.cost_price && formData.sale_price && parseFloat(formData.sale_price as string) > 0 && (
                        <div className="flex justify-between items-center text-xs text-gray-600 border-t border-emerald-100 pt-2">
                          <span>Margen estimado:</span>
                          <span className={`font-semibold ${
                            parseFloat(formData.sale_price as string) - parseFloat(formData.cost_price as string) >= 0
                              ? 'text-emerald-600' : 'text-red-500'
                          }`}>
                            ${(parseFloat(formData.sale_price as string) - parseFloat(formData.cost_price as string)).toFixed(2)}
                            {parseFloat(formData.cost_price as string) > 0 && (
                              <span className="text-gray-400 font-normal ml-1">
                                ({(((parseFloat(formData.sale_price as string) - parseFloat(formData.cost_price as string)) / parseFloat(formData.cost_price as string)) * 100).toFixed(0)}%)
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Unidad de Medida</label>
                      <select className={inputCls} value={formData.unit_of_measure} onChange={e => f('unit_of_measure', e.target.value)}>
                        {['Vial','Jeringa','Unidad','Caja','mL','Kit','g','oz','UI'].map(u => (
                          <option key={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Stock mínimo (alerta)</label>
                      <input type="number" min="0" className={inputCls}
                        value={formData.min_stock_level}
                        onChange={e => f('min_stock_level', parseInt(e.target.value) || 0)} />
                    </div>
                  </div>

                  <label className="flex items-center gap-3 p-3 bg-sky-50 rounded-xl border border-sky-100 cursor-pointer hover:bg-sky-100 transition-colors">
                    <input type="checkbox" className="w-4 h-4 accent-sky-500 rounded"
                      checked={formData.requires_cold_chain}
                      onChange={e => f('requires_cold_chain', e.target.checked)} />
                    <span className="text-sm font-medium text-sky-800">❄️ Requiere Cadena de Frío</span>
                  </label>

                  <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose}
                      className="px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition-colors">
                      Cancelar
                    </button>
                    <motion.button type="submit" disabled={loading}
                      whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                      className="px-5 py-2.5 bg-[#deb887] text-white rounded-xl hover:bg-[#c5a075] transition-colors flex items-center gap-2 text-sm font-semibold shadow-sm shadow-[#deb887]/30 disabled:opacity-60">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      {isEditing ? (
                        <><Save className="w-4 h-4" /> Guardar Cambios</>
                      ) : (
                        <><ChevronRight className="w-4 h-4" /> Siguiente: Stock inicial</>
                      )}
                    </motion.button>
                  </div>
                </motion.form>
              )}

              {/* Step 2: Initial stock (new product only) */}
              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="p-6 space-y-4"
                >
                  <div className="p-3 bg-[#deb887]/10 rounded-xl border border-[#deb887]/20 text-sm text-[#7a5c2e]">
                    <p className="font-medium">Agrega el stock inicial de <span className="font-bold">{formData.name}</span></p>
                    <p className="text-xs text-[#9a7040] mt-0.5">Puedes omitir este paso y agregar stock más tarde desde el inventario.</p>
                  </div>

                  {error && (
                    <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm flex items-center gap-2 border border-red-100">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {error}
                    </div>
                  )}

                  <div>
                    <label className={labelCls}>Número de Lote <span className="text-gray-400 normal-case">(opcional)</span></label>
                    <input type="text" className={inputCls} value={stockData.batch_number}
                      onChange={e => setStockData(p => ({ ...p, batch_number: e.target.value }))}
                      placeholder="Ej. L-2026-001 (se genera si está vacío)" />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={labelCls}>Fecha de Vencimiento</label>
                      <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                        <input type="checkbox" className="w-3.5 h-3.5 accent-[#deb887]"
                          checked={noExpiry}
                          onChange={e => { setNoExpiry(e.target.checked); if (e.target.checked) setStockData(p => ({ ...p, expiration_date: '' })); }} />
                        Sin vencimiento
                      </label>
                    </div>
                    <div className="relative">
                      <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input type="date" disabled={noExpiry} required={!noExpiry}
                        className={`${inputCls} pl-9 ${noExpiry ? 'opacity-40' : ''}`}
                        value={stockData.expiration_date}
                        onChange={e => setStockData(p => ({ ...p, expiration_date: e.target.value }))} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Cantidad ({formData.unit_of_measure})</label>
                      <input type="number" min="1" required className={inputCls}
                        value={stockData.quantity}
                        onChange={e => setStockData(p => ({ ...p, quantity: parseInt(e.target.value) || 1 }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Costo Unitario ($)</label>
                      <input type="number" min="0" step="0.01" className={inputCls}
                        value={stockData.cost_per_unit}
                        onChange={e => setStockData(p => ({ ...p, cost_per_unit: parseFloat(e.target.value) || 0 }))} />
                    </div>
                  </div>

                  <div className="flex justify-between items-center gap-3 pt-2">
                    <button type="button" onClick={() => setStep(1)}
                      className="flex items-center gap-1.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition-colors">
                      <ChevronLeft className="w-4 h-4" /> Atrás
                    </button>
                    <div className="flex gap-2">
                      <motion.button type="button" onClick={() => handleStep2Save(true)}
                        disabled={loading}
                        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                        className="px-4 py-2.5 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-60">
                        Omitir por ahora
                      </motion.button>
                      <motion.button type="button" onClick={() => handleStep2Save(false)}
                        disabled={loading || (!noExpiry && !stockData.expiration_date)}
                        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                        className="px-5 py-2.5 bg-[#deb887] text-white rounded-xl hover:bg-[#c5a075] transition-colors flex items-center gap-2 text-sm font-semibold shadow-sm shadow-[#deb887]/30 disabled:opacity-60">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                        Crear con Stock
                      </motion.button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </motion.div>
    </div>
  );
}
