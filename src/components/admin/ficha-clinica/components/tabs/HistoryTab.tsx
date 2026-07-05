import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Plus, Check, History } from 'lucide-react';
import historyOptions from '../../data/history_options.json';
import { Tooltip } from '../../../../ui/Tooltip';

interface HistoryTabProps {
  recordId: number;
  initialData: any;
  onSave: () => void;
}

interface HistoryFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  categoryId?: keyof typeof historyOptions;
  disabled?: boolean;
}

const HistoryField = ({ label, name, value, onChange, placeholder, categoryId, disabled }: HistoryFieldProps) => {
  const [inputValue, setInputValue] = useState('');
  const listId = `list-${name}`;

  const items = categoryId ? (historyOptions[categoryId as keyof typeof historyOptions] || []) : [];

  const handleAdd = (val: string) => {
    if (!val) return;
    
    const currentValue = value || '';
    const separator = currentValue.length > 0 ? '\n' : '';
    const newValue = `${currentValue}${separator}- ${val}`;
    
    const event = {
      target: {
        name,
        value: newValue
      }
    } as React.ChangeEvent<HTMLTextAreaElement>;
    
    onChange(event);
    setInputValue('');
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3 bg-white p-5 rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-all duration-300 group"
    >
      <label className="block text-sm font-bold text-gray-700 flex items-center gap-2 group-hover:text-[#deb887] transition-colors">
        <div className="w-1 h-4 bg-[#deb887] rounded-full" />
        {label}
      </label>
      
      {items.length > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              list={listId}
              type="text"
              className="w-full p-2.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none disabled:bg-gray-50 disabled:text-gray-400 transition-all bg-gray-50/30"
              placeholder="Buscar y agregar..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd(inputValue);
                }
              }}
            />
            <datalist id={listId}>
              {items.map((item: string, index: number) => (
                <option key={index} value={item} />
              ))}
            </datalist>
          </div>
          <Tooltip content="Agregar a la lista">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              type="button"
              onClick={() => handleAdd(inputValue)}
              className="bg-[#deb887] text-white p-2.5 rounded-lg hover:bg-[#c5a075] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              <Plus className="w-4 h-4" />
            </motion.button>
          </Tooltip>
        </div>
      )}

      <textarea
        name={name}
        rows={4}
        className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none resize-none disabled:bg-gray-50 disabled:text-gray-500 transition-all bg-white text-gray-700 text-sm leading-relaxed"
        placeholder={placeholder}
        value={value || ''}
        onChange={onChange}
      />
    </motion.div>
  );
};

export default function HistoryTab({ recordId, initialData, onSave }: HistoryTabProps) {
  const [formData, setFormData] = useState(initialData || {});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  
  const recordIdRef = useRef(recordId);

  useEffect(() => {
    if (recordId) {
      recordIdRef.current = recordId;
    }
  }, [recordId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev: any) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const idToUse = recordId || recordIdRef.current;

    if (!idToUse) {
      setMessage({ type: 'error', text: 'Error: No se encontró el ID del expediente. Intente recargar la página.' });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/records?action=saveHistory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: idToUse, ...formData }),
      });

      if (response.ok) {
        setMessage({ type: 'success', text: 'Antecedentes guardados correctamente' });
        setTimeout(() => setMessage(null), 3000);
        onSave();
      } else {
        throw new Error('Error al guardar');
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Error al guardar los antecedentes' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-[#deb887]/10 rounded-lg">
          <History className="w-6 h-6 text-[#deb887]" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-gray-800">Antecedentes Clínicos</h3>
          <p className="text-sm text-gray-500">Registre el historial médico y hábitos del paciente</p>
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <HistoryField
          label="Antecedentes Patológicos"
          name="pathological"
          value={formData.pathological}
          onChange={handleChange}
          placeholder="Enfermedades crónicas, hospitalizaciones previas..."
          categoryId="antecedente_personal"
        />

        <HistoryField
          label="Hábitos"
          name="non_pathological"
          value={formData.non_pathological}
          onChange={handleChange}
          placeholder="Tabaco, alcohol, actividad física, alimentación..."
          categoryId="habito"
        />

        <HistoryField
          label="Antecedentes Familiares"
          name="family_history"
          value={formData.family_history}
          onChange={handleChange}
          placeholder="Enfermedades hereditarias, antecedentes de cáncer..."
          categoryId="antecedente_familiar"
        />

        <HistoryField
          label="Antecedentes Quirúrgicos"
          name="surgical_history"
          value={formData.surgical_history}
          onChange={handleChange}
          placeholder="Cirugías previas, fechas aproximadas..."
          categoryId="quirurgico"
        />

        <HistoryField
          label="Alergias"
          name="allergies"
          value={formData.allergies}
          onChange={handleChange}
          placeholder="Medicamentos, alimentos, látex..."
          categoryId="alergia"
        />

        <HistoryField
          label="Medicamentos Actuales"
          name="current_medications"
          value={formData.current_medications}
          onChange={handleChange}
          placeholder="Nombre, dosis, frecuencia..."
          categoryId="medicacion"
        />

        <HistoryField
          label="Antecedentes Estéticos"
          name="aesthetic_history"
          value={formData.aesthetic_history}
          onChange={handleChange}
          placeholder="Tratamientos previos, reacciones adversas..."
          categoryId="otros"
        />

        <HistoryField
          label="Antecedentes Ginecológicos"
          name="gynecological_history"
          value={formData.gynecological_history}
          onChange={handleChange}
          placeholder="FUM, anticonceptivos, embarazos..."
          categoryId="obstetrico"
        />

        <HistoryField
          label="Rutina de Cuidado Facial"
          name="facial_routine"
          value={formData.facial_routine}
          onChange={handleChange}
          placeholder="Limpieza, hidratación, protección solar..."
          categoryId="rutina_cuidado_facial"
        />
      </div>

      <div className="flex justify-end pt-6 border-t border-gray-100">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={saving}
          className="bg-[#deb887] text-white px-8 py-3 rounded-xl hover:bg-[#c5a075] transition-colors flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-[#deb887]/20 font-medium"
        >
          {saving ? (
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
          ) : (
            <Save className="w-5 h-5" />
          )}
          {saving ? 'Guardando...' : 'Guardar Cambios'}
        </motion.button>
      </div>
    </form>
  );
}
