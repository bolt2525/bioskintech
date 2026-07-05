import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Check, Stethoscope, Copy, Trash2, Printer, Plus } from 'lucide-react';
import { Tooltip } from '../../../../ui/Tooltip';

interface ConsultationTabProps {
  recordId: number;
  initialData: any;
  historyData?: any[];
  onSave: () => void;
}

export default function ConsultationTab({ recordId, initialData, historyData = [], onSave }: ConsultationTabProps) {
  const [formData, setFormData] = useState({
    reason: '',
    current_illness: '',
  });
  
  // Flag to know if we are editing the "Current" state (initialData) or a "History" item
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    // Initializes form with current consultation info (initialData)
    // ONLY if we are not viewing a history item
    if (initialData && selectedHistoryId === null) {
      setFormData({
        reason: initialData.reason || '',
        current_illness: initialData.current_illness || ''
      });
    }
  }, [initialData, selectedHistoryId]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleSelectHistory = (item: any) => {
    setSelectedHistoryId(item.id);
    setFormData({
      reason: item.reason || '',
      current_illness: item.current_illness || '' // Note: History currently only has reason, but if we add illness later it will work
    });
    setMessage(null);
  };

  const handleNew = () => {
    setSelectedHistoryId(null);
    if (initialData) {
      setFormData({
        reason: initialData.reason || '',
        current_illness: initialData.current_illness || ''
      });
    } else {
        setFormData({ reason: '', current_illness: '' });
    }
    setMessage(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleDuplicate = () => {
    // Keep the text but switch to "New" mode so we can save as current
    setSelectedHistoryId(null);
    setMessage({ type: 'success', text: 'Información duplicada. Guarde para actualizar la consulta actual.' });
  };

  const handleDelete = async () => {
    if (!selectedHistoryId || !confirm('¿Eliminar este registro del historial?')) return;

    try {
        const response = await fetch(`/api/records?action=deleteConsultationHistory&id=${selectedHistoryId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            setMessage({ type: 'success', text: 'Registro eliminado correctamente' });
            onSave(); // Refresh data
            handleNew(); // Reset view
        } else {
            throw new Error('Error al eliminar');
        }
    } catch (error) {
        console.error('Error deleting history:', error);
        setMessage({ type: 'error', text: 'Error al eliminar el registro' });
    }
  };

  const handlePrint = () => {
    setMessage({ type: 'success', text: 'Abriendo vista de impresión...' });
    const html = `
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Motivo de Consulta</title>
          <style>
             body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
             h1 { color: #deb887; border-bottom: 2px solid #eee; padding-bottom: 15px; }
             .section { margin-bottom: 30px; }
             .label { font-weight: bold; display: block; margin-bottom: 8px; color: #555; }
             .content { background: #f9f9f9; padding: 15px; border-radius: 8px; border: 1px solid #eee; }
             .footer { margin-top: 50px; font-size: 12px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
          </style>
        </head>
        <body>
          <h1>Consulta Médica</h1>
          <div class="section">
            <span class="label">Fecha del Registro:</span>
            <div class="content">
              ${selectedHistoryId 
                  ? new Date(historyData.find(h => h.id === selectedHistoryId)?.created_at).toLocaleDateString() 
                  : new Date().toLocaleDateString()
              }
            </div>
          </div>
          <div class="section">
            <span class="label">Motivo de Consulta:</span>
            <div class="content">${formData.reason || 'No especificado'}</div>
          </div>
          <div class="section">
            <span class="label">Enfermedad Actual:</span>
            <div class="content" style="white-space: pre-wrap;">${formData.current_illness || 'No especificado'}</div>
          </div>
          <div class="footer">
            Generado el ${new Date().toLocaleString()}
          </div>
          <script>window.onload = () => window.print()</script>
        </body>
      </html>
    `;
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    // If viewing history, we can't save "over" it usually, unless we want to update the log??
    // But usually for "Consulta" we want to update the Current Status.
    // If user edits while viewing history, and clicks Save... do we update Current?
    // I will assume YES, saving always updates the Current Status (latest).
    
    try {
      const response = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveConsultation',
          recordId,
          reason: formData.reason,
          current_illness: formData.current_illness
        })
      });

      if (!response.ok) throw new Error('Error al guardar');

      setMessage({ type: 'success', text: 'Información guardada y registrada en historial' });
      setSelectedHistoryId(null); // Switch to "Current" view which now matches what we saved
      
      if (onSave) onSave(); // Refresh parent to get new history list
    } catch (error) {
      console.error('Error saving consultation:', error);
      setMessage({ type: 'error', text: 'Error al guardar la información' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col md:flex-row h-auto gap-6"
    >
      {/* Sidebar List */}
      <div className="w-full md:w-1/3 flex flex-col gap-4">
        <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2 border-l-4 border-[#deb887] pl-3">
          Historial de Consultas
        </h3>

        <button
            onClick={handleNew}
            className={`w-full p-4  text-left transition-all border rounded-xl flex items-center justify-between group ${
                selectedHistoryId === null
                ? 'bg-[#deb887] text-white shadow-lg shadow-[#deb887]/20 border-transparent'
                : 'bg-white hover:border-[#deb887]/50 text-gray-600 border-gray-100 hover:shadow-md'
            }`}
        >
            <span className="font-bold flex items-center gap-2">
                {selectedHistoryId === null ? <Check size={18} /> : <Stethoscope size={18} />}
                Consulta Actual
            </span>
            {selectedHistoryId === null && <span className="text-xs bg-white/20 px-2 py-1 rounded-full">Editando</span>}
        </button>

        <div className="flex-1 overflow-y-auto space-y-3 max-h-[600px] pr-2 custom-scrollbar">
            {historyData && historyData.length > 0 ? (
                historyData.map((item) => (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        onClick={() => handleSelectHistory(item)}
                        className={`p-4 rounded-xl cursor-pointer border transition-all hover:shadow-md ${
                            selectedHistoryId === item.id
                            ? 'bg-amber-50 border-[#deb887] ring-1 ring-[#deb887]'
                            : 'bg-white border-gray-100 hover:border-[#deb887]/30'
                        }`}
                    >
                        <div className="flex justify-between items-start mb-2">
                            <span className={`text-xs font-bold uppercase tracking-wider ${
                                selectedHistoryId === item.id ? 'text-[#deb887]' : 'text-gray-500'
                            }`}>
                                {new Date(item.created_at).toLocaleDateString()}
                            </span>
                            <span className="text-xs text-gray-400">
                                {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>
                        <p className={`text-sm line-clamp-2 ${
                            selectedHistoryId === item.id ? 'text-gray-800 font-medium' : 'text-gray-600'
                        }`}>
                            {item.reason}
                        </p>
                    </motion.div>
                ))
            ) : (
                <div className="text-center py-8 text-gray-400 bg-gray-50/50 rounded-xl border border-dashed border-gray-200">
                    <p className="text-sm">No hay historial disponible</p>
                </div>
            )}
        </div>
      </div>

      {/* Main Content */}
      <div className="w-full md:w-2/3 flex flex-col gap-4">
        
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-2 rounded-xl border border-gray-100 shadow-sm">
            <div className="flex gap-2">
                <Tooltip content="Guardar como Actual">
                    <button 
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors disabled:opacity-50 font-medium text-sm"
                    >
                        {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
                        Guardar
                    </button>
                </Tooltip>
                
                {selectedHistoryId && (
                     <Tooltip content="Copiar al Actual">
                        <button 
                            onClick={handleDuplicate}
                            className="p-2 text-gray-600 hover:text-[#deb887] hover:bg-amber-50 rounded-lg transition-colors"
                        >
                            <Copy size={18} />
                        </button>
                    </Tooltip>
                )}

                {selectedHistoryId && (
                    <Tooltip content="Eliminar del Historial">
                        <button 
                            onClick={handleDelete}
                            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                            <Trash2 size={18} />
                        </button>
                    </Tooltip>
                )}

                <Tooltip content="Imprimir">
                    <button 
                        onClick={handlePrint}
                        className="p-2 text-gray-600 hover:text-[#deb887] hover:bg-amber-50 rounded-lg transition-colors"
                    >
                        <Printer size={18} />
                    </button>
                </Tooltip>
            </div>

            {selectedHistoryId ? (
                <span className="text-xs font-medium text-amber-600 bg-amber-50 px-3 py-1 rounded-full border border-amber-100">
                    Modo Vista Histórica
                </span>
            ) : (
                <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                    Modo Edición Actual
                </span>
            )}
        </div>

        {/* Form */}
        <motion.div 
            layout
            className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex-1"
        >
            <AnimatePresence>
                {message && (
                <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${
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

            <div className="space-y-6">
                <div className="space-y-3 group">
                    <label className="block text-sm font-bold text-gray-700 group-hover:text-[#deb887] transition-colors">
                        Motivo de Consulta
                    </label>
                    <input
                        type="text"
                        name="reason"
                        value={formData.reason}
                        onChange={handleChange}
                        placeholder="Ingrese el motivo principal de la consulta..."
                        className="w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all bg-gray-50/30 focus:bg-white text-gray-800 placeholder-gray-400"
                    />
                </div>

                <div className="space-y-3 group">
                    <label className="block text-sm font-bold text-gray-700 group-hover:text-[#deb887] transition-colors">
                        Enfermedad Actual
                    </label>
                    <textarea
                        name="current_illness"
                        rows={12}
                        value={formData.current_illness}
                        onChange={handleChange}
                        placeholder="Describa la enfermedad actual, síntomas, evolución..."
                        className="w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none resize-none transition-all bg-gray-50/30 focus:bg-white text-gray-800 placeholder-gray-400 leading-relaxed"
                    />
                </div>
            </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
