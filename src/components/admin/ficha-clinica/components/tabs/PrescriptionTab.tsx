import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Save, FileText, Copy, Printer, Search, Calendar, Check, AlertCircle, Pill, Pencil } from 'lucide-react';
import prescriptionOptions from '../../data/prescription_options.json';
import { Tooltip } from '../../../../ui/Tooltip';

/** Extrae solo YYYY-MM-DD de un ISO timestamp o string de PG para evitar desfase de zona horaria */
const toDateOnly = (d: string | null | undefined): string => {
  if (!d) return '';
  const s = String(d);
  if (s.includes('T')) return s.split('T')[0]; // "2026-05-15T00:00:00.000Z"
  if (s.includes(' ') && s.length > 10) return s.split(' ')[0]; // "2026-05-15 00:00:00"
  return s; // ya es "YYYY-MM-DD"
};
/** Retorna la fecha LOCAL actual en YYYY-MM-DD (no UTC) */
const getLocalDate = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface PrescriptionItem {
  medicamento: string;
  nombre_comercial: string;
  presentacion: string;
  dosis: string;
  frecuencia: string;
  via: string;
  duracion: string;
  turno: string;
  indicaciones: string;
  rutina: 'mañana' | 'noche' | 'ambos' | '';
}

interface Prescription {
  id?: number;
  fecha: string;
  diagnostico: string;
  items: PrescriptionItem[];
}

interface PrescriptionTabProps {
  recordId: number;
  patientName: string;
  patientAge?: number | string;
}

const EMPTY_ITEM: PrescriptionItem = {
  medicamento: '',
  nombre_comercial: '',
  presentacion: '',
  dosis: '',
  frecuencia: '',
  via: '',
  duracion: '',
  turno: '',
  indicaciones: '',
  rutina: ''
};

export default function PrescriptionTab({ recordId, patientName, patientAge }: PrescriptionTabProps) {
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [currentPrescription, setCurrentPrescription] = useState<Prescription>({
    fecha: getLocalDate(),
    diagnostico: '',
    items: [{ ...EMPTY_ITEM }]
  });
  const [dateLocked, setDateLocked] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    loadPrescriptions();
    loadTemplates();
  }, [recordId]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadPrescriptions = async () => {
    try {
      const res = await fetch(`/api/records?action=listPrescriptions&record_id=${recordId}`);
      const data = await res.json();
      setPrescriptions(data);
    } catch (error) {
      console.error('Error loading prescriptions:', error);
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/records?action=getTemplates');
      const data = await res.json();
      setTemplates(data);
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const action = currentPrescription.id ? 'updatePrescription' : 'createPrescription';
      const body = {
        ...currentPrescription,
        ficha_id: recordId,
        items: currentPrescription.items.filter(i => i.medicamento || i.nombre_comercial || i.indicaciones) // Filter empty rows (allow if only indications exist)
      };

      const res = await fetch(`/api/records?action=${action}`, {
        method: currentPrescription.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        await loadPrescriptions();
        if (action === 'createPrescription') {
          // Reset form if new
          setCurrentPrescription({
            fecha: getLocalDate(),
            diagnostico: '',
            items: [{ ...EMPTY_ITEM }]
          });
          setDateLocked(false);
        }
        setMessage({ type: 'success', text: 'Receta guardada correctamente' });
      } else {
        throw new Error('Error al guardar');
      }
    } catch (error) {
      console.error('Error saving:', error);
      setMessage({ type: 'error', text: 'Error al guardar la receta' });
    } finally {
      setLoading(false);
    }
  };

  const handleLoadPrescription = async (id: number) => {
    try {
      const res = await fetch(`/api/records?action=getPrescription&id=${id}`);
      const data = await res.json();
      setCurrentPrescription({ ...data, fecha: toDateOnly(data.fecha) });
      setDateLocked(true);
      setMessage(null);
    } catch (error) {
      console.error('Error loading details:', error);
    }
  };

  const handleNew = () => {
    setCurrentPrescription({
      fecha: getLocalDate(),
      diagnostico: '',
      items: [{ ...EMPTY_ITEM }]
    });
    setDateLocked(false);
    setMessage(null);
  };

  const handleDuplicate = () => {
    const { id, ...rest } = currentPrescription;
    setCurrentPrescription({
      ...rest,
      fecha: getLocalDate()
    });
    setDateLocked(false);
    setMessage({ type: 'success', text: 'Receta duplicada. Guarde para crear una nueva.' });
  };

  const handleDelete = async () => {
    if (!currentPrescription.id || !confirm('¿Eliminar esta receta?')) return;
    setDeleting(true);
    try {
      await fetch(`/api/records?action=deletePrescription&id=${currentPrescription.id}`, { method: 'DELETE' });
      await loadPrescriptions();
      handleNew();
      setMessage({ type: 'success', text: 'Receta eliminada correctamente' });
    } catch (error) {
      console.error('Error deleting:', error);
      setMessage({ type: 'error', text: 'Error al eliminar la receta' });
    } finally {
      setDeleting(false);
    }
  };

  const updateItem = (index: number, field: keyof PrescriptionItem, value: string) => {
    const newItems = [...currentPrescription.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setCurrentPrescription(prev => ({ ...prev, items: newItems }));
  };

  const addItem = () => {
    setCurrentPrescription(prev => ({
      ...prev,
      items: [...prev.items, { ...EMPTY_ITEM }]
    }));
  };

  const removeItem = (index: number) => {
    setCurrentPrescription(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  const handleSaveTemplate = async () => {
    const name = prompt('Nombre de la plantilla:');
    if (!name) return;

    try {
      await fetch('/api/records?action=saveTemplate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: name,
          items: currentPrescription.items.filter(i => i.medicamento || i.nombre_comercial)
        })
      });
      loadTemplates();
      setMessage({ type: 'success', text: 'Plantilla guardada correctamente' });
    } catch (error) {
      console.error('Error saving template:', error);
      setMessage({ type: 'error', text: 'Error al guardar la plantilla' });
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate || !confirm('¿Eliminar esta plantilla?')) return;

    try {
      await fetch(`/api/records?action=deleteTemplate&id=${selectedTemplate}`, { method: 'DELETE' });
      loadTemplates();
      setSelectedTemplate('');
      setMessage({ type: 'success', text: 'Plantilla eliminada' });
    } catch (error) {
      console.error('Error deleting template:', error);
      setMessage({ type: 'error', text: 'Error al eliminar la plantilla' });
    }
  };

  const handleApplyTemplate = () => {
    const template = templates.find(t => t.id.toString() === selectedTemplate);
    if (template) {
      const items = JSON.parse(template.items_json);
      setCurrentPrescription(prev => ({
        ...prev,
        items: [...prev.items.filter(i => i.medicamento || i.nombre_comercial), ...items]
      }));
      setMessage({ type: 'success', text: 'Plantilla aplicada' });
    }
  };

  const handlePrint = () => {
    setMessage({ type: 'success', text: 'Abriendo vista de impresión...' });
    const dateStr = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
    const logoUrl = `${window.location.origin}/images/logo/logo.png`;

    const html = `
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Receta Médica - ${patientName}</title>
          <style>
            @page { size: A4 portrait; margin: 0; }
            body { font-family: 'Arial', sans-serif; padding: 0; max-width: 100%; margin: 0; box-sizing: border-box; }
            .container { display: flex; gap: 30px; height: 140mm; padding: 30px; }
            .column { flex: 1; position: relative; display: flex; flex-direction: column; }
            .column:first-child { border-right: 1px dashed #ccc; padding-right: 30px; }
            
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 2px solid #000; padding-bottom: 10px; }
            .logo { height: 45px; object-fit: contain; }
            .doctor-info { text-align: right; }
            .doctor-info h2 { margin: 0; font-size: 10px; color: #333; letter-spacing: 2px; font-weight: normal; }
            .doctor-info h3 { margin: 5px 0 0; font-size: 12px; font-weight: bold; }

            .patient-info { margin-bottom: 15px; font-size: 10px; }
            .patient-info p { margin: 5px 0; }
            .patient-details { display: flex; justify-content: space-between; margin-top: 10px; }

            .section-title { font-weight: bold; margin-bottom: 10px; font-size: 10px; text-transform: uppercase; border-bottom: 2px solid #000; display: inline-block; padding-bottom: 2px; width: 20px; border-bottom: 3px solid #000; }
            .section-header { font-weight: bold; margin-bottom: 10px; font-size: 10px; text-transform: uppercase; }

            .product-list { list-style-type: decimal; padding-left: 20px; margin: 0; }
            .product-list li { margin-bottom: 6px; font-size: 10px; line-height: 1.4; }

            .routine-section { margin-bottom: 15px; }
            .routine-title { font-size: 10px; color: #333; margin-bottom: 8px; text-transform: uppercase; }

            .footer { margin-top: auto; font-size: 8px; color: #666; padding-top: 10px; }
            .footer-item { display: flex; align-items: center; gap: 5px; margin-bottom: 3px; }
            .icon { margin-right: 5px; }
          </style>
        </head>
        <body>
          <div class="container">
            <!-- Left Column -->
            <div class="column">
               <div class="header">
                 <img src="${logoUrl}" class="logo" alt="Bio Skin" />
                 <div class="doctor-info">
                   <h2>SALUD Y ESTÉTICA</h2>
                   <h3>DRA. DANIELA CREAMER</h3>
                 </div>
               </div>
               
               <div class="patient-info">
                 <p><strong>Cuenca, a ${dateStr}</strong></p>
                 <div class="patient-details">
                    <span><strong>Paciente:</strong> ${patientName.toUpperCase()}</span>
                    <span><strong>EDAD:</strong> ${patientAge || ''} AÑOS</span>
                 </div>
               </div>

               <div class="section-header">INDICACIONES:</div>
               <ol class="product-list">
                 ${currentPrescription.items.map(item => `
                   <li>
                     ${item.nombre_comercial || item.medicamento} ${item.presentacion || ''}
                   </li>
                 `).join('')}
               </ol>

               <div class="footer">
                  <div class="footer-item"><span class="icon"></span> 0998653732 / 0969890689</div>
                  <div class="footer-item"><span class="icon"></span> Av. Ordoñez Lasso y Calle del Culantro, Edificio Torre Victoria, Planta Baja.</div>
               </div>
            </div>

            <!-- Right Column -->
            <div class="column">
               <div class="header">
                 <img src="${logoUrl}" class="logo" alt="Bio Skin" />
                 <div class="doctor-info">
                   <h2>SALUD Y ESTÉTICA</h2>
                   <h3>DRA. DANIELA CREAMER</h3>
                 </div>
               </div>
               
               <div class="patient-info">
                 <p><strong>Cuenca, a ${dateStr}</strong></p>
                 <div class="patient-details">
                    <span><strong>Paciente:</strong> ${patientName.toUpperCase()}</span>
                    <span><strong>EDAD:</strong> ${patientAge || ''} AÑOS</span>
                 </div>
               </div>

               <div class="section-header">INDICACIONES:</div>
               
               <div class="routine-section">
                 <div class="routine-title">RUTINA DE MAÑANA</div>
                 <ol class="product-list">
                   ${currentPrescription.items.filter(i => i.rutina === 'mañana' || i.rutina === 'ambos').map(item => `
                     <li>
                       ${item.indicaciones || `Aplicar ${item.nombre_comercial || item.medicamento}`}
                     </li>
                   `).join('')}
                 </ol>
               </div>

               <div class="routine-section">
                 <div class="routine-title">RUTINA DE NOCHE</div>
                 <ol class="product-list">
                   ${currentPrescription.items.filter(i => i.rutina === 'noche' || i.rutina === 'ambos').map(item => `
                     <li>
                       ${item.indicaciones || `Aplicar ${item.nombre_comercial || item.medicamento}`}
                     </li>
                   `).join('')}
                 </ol>
               </div>
               
               <div class="footer">
                  <div class="footer-item"><span class="icon"></span> 0998653732 / 0969890689</div>
                  <div class="footer-item"><span class="icon"></span> Av. Ordoñez Lasso y Calle del Culantro, Edificio Torre Victoria, Planta Baja.</div>
               </div>
            </div>
          </div>
          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
      </html>
    `;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col md:flex-row h-auto md:h-[600px] gap-6"
    >
      {/* Sidebar List */}
      <div className="w-full md:w-72 border-r-0 md:border-r border-b md:border-b-0 border-gray-100 pr-0 md:pr-6 pb-4 md:pb-0 flex flex-col gap-4 shrink-0">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial de Recetas
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {prescriptions.map((p, index) => {
            const rawDate = p.fecha || '';
            const dateObj = rawDate ? new Date(toDateOnly(rawDate) + 'T12:00:00') : null;
            const dateFormatted = dateObj && !isNaN(dateObj.getTime())
              ? dateObj.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' })
              : rawDate;
            const itemCount = Array.isArray(p.items) ? p.items.filter(i => i.medicamento || i.nombre_comercial).length : null;
            const isSelected = currentPrescription.id === p.id;
            return (
            <motion.div
              key={p.id || index}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => p.id && handleLoadPrescription(p.id)}
              className={`p-4 rounded-xl cursor-pointer border transition-all shadow-sm ${
                isSelected
                  ? 'bg-[#deb887] text-white border-[#deb887] shadow-md'
                  : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-[#deb887]/30'
              }`}
            >
              {/* Fecha */}
              <div className={`flex items-center gap-1.5 text-xs font-semibold mb-1.5 ${
                isSelected ? 'text-white/80' : 'text-[#deb887]'
              }`}>
                <Calendar className="w-3.5 h-3.5" />
                <span>{dateFormatted}</span>
              </div>
              {/* Diagnóstico */}
              <div className={`font-semibold text-sm leading-tight truncate mb-2 ${
                isSelected ? 'text-white' : 'text-gray-800'
              }`}>
                {p.diagnostico || <span className={`italic font-normal ${ isSelected ? 'text-white/60' : 'text-gray-400'}`}>Sin diagnóstico</span>}
              </div>
              {/* Footer */}
              <div className={`flex items-center justify-between text-xs ${
                isSelected ? 'text-white/70' : 'text-gray-400'
              }`}>
                <div className="flex items-center gap-1">
                  <Pill className="w-3 h-3" />
                  <span>{itemCount !== null ? `${itemCount} medicamento${itemCount !== 1 ? 's' : ''}` : 'Ver detalle'}</span>
                </div>
                <FileText className="w-3.5 h-3.5 opacity-60" />
              </div>
            </motion.div>
            );
          })}
          {prescriptions.length === 0 && (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay recetas registradas
            </div>
          )}
        </div>
      </div>

      {/* Main Form */}
      <div className="flex-1 flex flex-col gap-6 relative overflow-visible md:overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm sticky top-0 z-10">
          <div className="flex gap-2 items-center">
            <Tooltip content="Nueva Receta">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleNew} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Plus className="w-5 h-5" />
              </motion.button>
            </Tooltip>
            
            <Tooltip content="Guardar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSave} 
                disabled={loading} 
                className="p-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] shadow-lg shadow-[#deb887]/20 disabled:opacity-70"
              >
                {loading ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Save className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Duplicar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Copy className="w-5 h-5" />
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete}
                disabled={deleting}
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 disabled:opacity-50"
              >
                {deleting ? <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-500 rounded-full" /> : <Trash2 className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Imprimir">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePrint} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Printer className="w-5 h-5" />
              </motion.button>
            </Tooltip>
          </div>
          
          <div className="flex gap-2 items-center">
            <select 
              className="p-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
            >
              <option value="">Seleccionar Plantilla...</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.nombre}</option>
              ))}
            </select>
            
            <Tooltip content="Aplicar Plantilla">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleApplyTemplate} 
                className="text-sm bg-gray-100 px-3 py-2 rounded-lg hover:bg-gray-200 text-gray-700 font-medium transition-colors"
              >
                Aplicar
              </motion.button>
            </Tooltip>

            {selectedTemplate && (
              <Tooltip content="Eliminar Plantilla">
                <motion.button 
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleDeleteTemplate} 
                  className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 transition-colors"
                >
                  <Trash2 className="w-5 h-5" />
                </motion.button>
              </Tooltip>
            )}

            <Tooltip content="Guardar como Plantilla">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSaveTemplate} 
                className="text-sm bg-gray-100 px-3 py-2 rounded-lg hover:bg-gray-200 text-gray-700 font-medium transition-colors"
              >
                Guardar Plantilla
              </motion.button>
            </Tooltip>
          </div>
        </div>

        <AnimatePresence>
          {message && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`p-4 rounded-xl flex items-center gap-3 shadow-sm ${
                message.type === 'success' 
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                  : 'bg-red-50 text-red-700 border border-red-100'
              }`}
            >
              <div className={`p-1.5 rounded-full ${message.type === 'success' ? 'bg-emerald-100' : 'bg-red-100'}`}>
                {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              </div>
              <span className="font-medium text-sm">{message.text}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header Fields */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Fecha</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="date"
                  disabled={dateLocked}
                  className={`w-full pl-10 p-2 border rounded-lg outline-none transition-all ${
                    dateLocked
                      ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'border-gray-200 focus:ring-2 focus:ring-[#deb887] bg-gray-50/50 focus:bg-white'
                  }`}
                  value={currentPrescription.fecha}
                  onChange={e => setCurrentPrescription(prev => ({ ...prev, fecha: e.target.value }))}
                />
              </div>
              {currentPrescription.id && dateLocked && (
                <Tooltip content="Actualizar fecha">
                  <button
                    type="button"
                    onClick={() => setDateLocked(false)}
                    className="p-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors shrink-0"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="col-span-1 md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Diagnóstico</label>
            <input
              type="text"
              className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentPrescription.diagnostico}
              onChange={e => setCurrentPrescription(prev => ({ ...prev, diagnostico: e.target.value }))}
              placeholder="Diagnóstico o indicaciones generales..."
            />
          </div>
        </div>

        {/* Items List (Cards) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar pb-24 bg-gray-50/50 rounded-xl border border-gray-200">
          {currentPrescription.items.map((item, idx) => (
            <motion.div 
              key={idx}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm relative hover:shadow-md transition-all group"
            >
              <div className="absolute top-4 right-4 z-10">
                <Tooltip content="Eliminar medicamento">
                  <motion.button 
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => removeItem(idx)} 
                    className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-full transition-colors"
                  >
                    <Trash2 className="w-5 h-5" />
                  </motion.button>
                </Tooltip>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4 pr-12">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                    Principio Activo <span className="text-red-400">*</span>
                  </label>
                  <input
                    list={`meds-${idx}`}
                    className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all bg-gray-50 focus:bg-white font-medium"
                    value={item.medicamento}
                    onChange={e => updateItem(idx, 'medicamento', e.target.value)}
                    placeholder="Buscar medicamento..."
                  />
                  <datalist id={`meds-${idx}`}>
                    {prescriptionOptions.medications.map((m, i) => <option key={i} value={m} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Nombre Comercial</label>
                  <input
                    className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all bg-gray-50 focus:bg-white"
                    value={item.nombre_comercial}
                    onChange={e => updateItem(idx, 'nombre_comercial', e.target.value)}
                    placeholder="Opcional"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Presentación</label>
                  <input
                    list={`pres-${idx}`}
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white"
                    value={item.presentacion}
                    onChange={e => updateItem(idx, 'presentacion', e.target.value)}
                    placeholder="Ej. Tabletas"
                  />
                  <datalist id={`pres-${idx}`}>
                    {prescriptionOptions.presentations.map((p, i) => <option key={i} value={p} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Dosis</label>
                  <input
                    list={`dose-${idx}`}
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white"
                    value={item.dosis}
                    onChange={e => updateItem(idx, 'dosis', e.target.value)}
                    placeholder="Ej. 500mg"
                  />
                  <datalist id={`dose-${idx}`}>
                    {prescriptionOptions.doses.map((d, i) => <option key={i} value={d} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Frecuencia</label>
                  <input
                    list={`freq-${idx}`}
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white"
                    value={item.frecuencia}
                    onChange={e => updateItem(idx, 'frecuencia', e.target.value)}
                    placeholder="Ej. Cada 8 horas"
                  />
                  <datalist id={`freq-${idx}`}>
                    {prescriptionOptions.frequencies.map((f, i) => <option key={i} value={f} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Vía</label>
                  <input
                    list={`route-${idx}`}
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white"
                    value={item.via}
                    onChange={e => updateItem(idx, 'via', e.target.value)}
                    placeholder="Ej. Oral"
                  />
                  <datalist id={`route-${idx}`}>
                    {prescriptionOptions.routes.map((r, i) => <option key={i} value={r} />)}
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Duración</label>
                  <input
                    list={`dur-${idx}`}
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white"
                    value={item.duracion}
                    onChange={e => updateItem(idx, 'duracion', e.target.value)}
                    placeholder="Ej. 7 días"
                  />
                  <datalist id={`dur-${idx}`}>
                    {prescriptionOptions.durations.map((d, i) => <option key={i} value={d} />)}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-500 uppercase">Rutina</label>
                  <select
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white cursor-pointer"
                    value={item.rutina}
                    onChange={e => updateItem(idx, 'rutina', e.target.value as any)}
                  >
                    <option value="">Seleccionar...</option>
                    <option value="mañana">☀️ Mañana</option>
                    <option value="noche">🌙 Noche</option>
                    <option value="ambos">🔄 Ambos</option>
                  </select>
                </div>
                <div className="lg:col-span-2 space-y-1.5 flex flex-col">
                  <label className="text-xs font-medium text-gray-500 uppercase">Indicaciones Adicionales</label>
                  <textarea
                    className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all hover:bg-gray-50 focus:bg-white min-h-[42px] overflow-hidden resize-none"
                    value={item.indicaciones}
                    onChange={e => {
                      updateItem(idx, 'indicaciones', e.target.value);
                      e.target.style.height = 'auto'; 
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    onFocus={e => {
                      e.target.style.height = 'auto'; 
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    rows={1}
                    placeholder="Instrucciones específicas para el paciente..."
                  />
                </div>
              </div>
            </motion.div>
          ))}

          {currentPrescription.items.length === 0 && (
            <div className="text-center py-12 flex flex-col items-center gap-3 text-gray-400">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                <FileText className="w-6 h-6 opacity-40" />
              </div>
              <p>No hay medicamentos en esta receta</p>
              <p className="text-xs opacity-60">Haga clic en "Agregar Medicamento" para comenzar</p>
            </div>
          )}
        </div>
        
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={addItem}
          className="absolute bottom-6 right-6 bg-[#deb887] text-white px-6 py-3 rounded-full shadow-lg hover:bg-[#c5a075] transition-all z-20 flex items-center gap-2 font-medium shadow-[#deb887]/30"
        >
          <Plus className="w-5 h-5" />
          Agregar Medicamento
        </motion.button>
      </div>
    </motion.div>
  );
}
