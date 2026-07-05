import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileText, Plus, Trash2, Edit, Eye, Save, Printer, 
  CheckCircle, XCircle, AlertTriangle, ChevronRight, ChevronDown,
  Copy, RefreshCw, QrCode, Smartphone, Eraser, X, Maximize2, Search, Check, AlertCircle
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import SignatureCanvas from 'react-signature-canvas';
import { Tooltip } from '../../../../ui/Tooltip';

// Load templates
const templatesGlob = import.meta.glob('/src/data/consent-templates/*.json', { eager: true });
const templates = Object.values(templatesGlob).map((mod: any) => mod.default || mod);

interface ConsentForm {
  id?: number;
  record_id: number;
  patient_id: number;
  status: 'draft' | 'finalized' | 'annulled';
  created_at?: string;
  created_by?: string;
  procedure_type: string;
  zone: string;
  sessions: number;
  objectives: string[];
  description: string;
  risks: string[];
  benefits: string[];
  alternatives: string[];
  pre_care: string[];
  post_care: string[];
  contraindications: string[];
  critical_antecedents: {
    allergies: string;
    medications: string;
    pregnancy: boolean;
    herpes: boolean;
    others: string[];
  };
  authorizations: {
    image_use: boolean;
    photo_video: boolean;
  };
  declarations: {
    understanding: boolean;
    questions: boolean;
    results: boolean;
    authorization: boolean;
    revocation: boolean;
    alternatives: boolean;
  };
  signatures: {
    patient_name: string;
    professional_name: string;
    patient_sig_data?: string;
    professional_sig_data?: string;
  };
  attachments: any[];
}

interface Props {
  patientId: number;
  recordId: number;
  patient?: any;
}

const API_URL = '/api/records';

export default function ConsentimientosTab({ patientId, recordId, patient }: Props) {
  const [consents, setConsents] = useState<ConsentForm[]>([]);
  const [view, setView] = useState<'list' | 'form' | 'preview'>('list');
  const [loading, setLoading] = useState(false);
  const [currentConsent, setCurrentConsent] = useState<ConsentForm | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const profSigCanvas = useRef<SignatureCanvas>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const filteredTemplates = templates.filter((t: any) => 
    t.procedure_type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    loadConsents();
    // Initialize professional signatures table
    fetch('/api/records?action=initProfessionalSignatures').catch(console.error);
  }, [patientId, recordId]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadProfessionalSignature = async (name: string) => {
    if (!name) return;
    try {
      const res = await fetch(`/api/records?action=getProfessionalSignature&name=${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.signature) {
          // If signature exists, update the current consent
          updateNestedField('signatures', 'professional_sig_data', data.signature);
          setMessage({ type: 'success', text: 'Firma cargada correctamente' });
        }
      }
    } catch (err) {
      console.error('Error loading signature:', err);
      setMessage({ type: 'error', text: 'Error al cargar firma' });
    }
  };

  const saveProfessionalSignature = async () => {
    const name = currentConsent?.signatures?.professional_name;
    const sigData = currentConsent?.signatures?.professional_sig_data;
    
    if (!name || !sigData) {
      setMessage({ type: 'error', text: 'Se requiere nombre y firma para guardar' });
      return;
    }

    try {
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveProfessionalSignature',
          name,
          signature: sigData
        })
      });
      
      if (res.ok) {
        setMessage({ type: 'success', text: 'Firma guardada como predeterminada' });
      }
    } catch (err) {
      console.error('Error saving signature:', err);
      setMessage({ type: 'error', text: 'Error al guardar firma' });
    }
  };

  const clearProfSignature = () => {
    profSigCanvas.current?.clear();
    updateNestedField('signatures', 'professional_sig_data', null);
  };

  const handleProfSignatureEnd = () => {
    if (profSigCanvas.current) {
      const dataUrl = profSigCanvas.current.getTrimmedCanvas().toDataURL('image/png');
      updateNestedField('signatures', 'professional_sig_data', dataUrl);
    }
  };

  const handleResetAndGenerate = async () => {
    if (!currentConsent) return;
    if (!confirm('¿Está seguro de eliminar la firma actual y generar una nueva solicitud? El paciente deberá firmar nuevamente.')) return;

    // Clear signature locally
    const updatedConsent = {
      ...currentConsent,
      signatures: {
        ...currentConsent.signatures,
        patient_sig_data: '',
        patient_name: currentConsent.signatures?.patient_name || '' // Keep name if exists
      }
    };
    setCurrentConsent(updatedConsent);
    
    // Save and generate new link
    setLoading(true);
    try {
      // First save the cleared signature
      await fetch(`${API_URL}?action=saveConsent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConsent)
      });

      // Then generate new token
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generateSigningToken',
          id: currentConsent.id
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}/#${data.url}`;
        setSigningUrl(url);
        setShowQr(true);
        setMessage({ type: 'success', text: 'Nuevo enlace generado' });
      } else {
        throw new Error('Error al generar nuevo enlace');
      }
    } catch (error) {
      console.error('Error resetting signature:', error);
      setMessage({ type: 'error', text: 'Error al restablecer firma' });
    } finally {
      setLoading(false);
    }
  };

  const generateSigningLink = async () => {
    if (!currentConsent?.id) {
      setMessage({ type: 'error', text: 'Guarde el consentimiento antes de generar la firma remota' });
      return;
    }
    
    try {
      setLoading(true);
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generateSigningToken',
          id: currentConsent.id
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}/#${data.url}`;
        setSigningUrl(url);
        setShowQr(true);
        setMessage({ type: 'success', text: 'Enlace de firma generado' });
      } else {
        throw new Error('Error al generar enlace');
      }
    } catch (error) {
      console.error('Error generating signing link:', error);
      setMessage({ type: 'error', text: 'Error al generar enlace de firma' });
    } finally {
      setLoading(false);
    }
  };

  const checkSigningStatus = async () => {
    if (!currentConsent?.id) return;
    
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}?action=getConsent&id=${currentConsent.id}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentConsent(data);
        if (data.signatures?.patient_sig_data) {
          setShowQr(false);
          setMessage({ type: 'success', text: '¡Firma recibida correctamente!' });
        } else {
          setMessage({ type: 'error', text: 'Aún no se ha recibido la firma' });
        }
      }
    } catch (error) {
      console.error('Error checking status:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadConsents = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}?action=listConsents&patient_id=${patientId}&record_id=${recordId}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setConsents(data);
      }
    } catch (error) {
      console.error('Error loading consents:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadTemplate = (index: string) => {
    const template = templates[parseInt(index)];
    if (!template || !currentConsent) return;

    setCurrentConsent({
      ...currentConsent,
      procedure_type: template.procedure_type,
      description: template.description,
      objectives: template.objectives || [],
      risks: template.risks || [],
      benefits: template.benefits || [],
      pre_care: template.pre_care || [],
      post_care: template.post_care || []
    });
    setMessage({ type: 'success', text: 'Plantilla cargada' });
  };

  const calculateAge = (birthDate: string) => {
    if (!birthDate) return 0;
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  const handleNew = () => {
    setCurrentConsent({
      record_id: recordId,
      patient_id: patientId,
      status: 'draft',
      procedure_type: '',
      zone: '',
      sessions: 1,
      objectives: [],
      description: '',
      risks: [],
      benefits: [],
      alternatives: [],
      pre_care: [],
      post_care: [],
      contraindications: [],
      critical_antecedents: {
        allergies: '',
        medications: '',
        pregnancy: false,
        herpes: false,
        others: []
      },
      authorizations: {
        image_use: false,
        photo_video: false
      },
      declarations: {
        understanding: false,
        questions: false,
        results: false,
        authorization: false,
        revocation: false,
        alternatives: false
      },
      signatures: {
        patient_name: patient ? `${patient.first_name} ${patient.last_name}` : '',
        professional_name: 'Dra. Daniela Creamer'
      },
      attachments: []
    });
    setView('form');
    setActiveTab(0);
    setMessage(null);
  };

  const handleEdit = (consent: ConsentForm) => {
    setCurrentConsent(consent);
    setView('form');
    setActiveTab(0);
    setMessage(null);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('¿Está seguro de eliminar este consentimiento?')) return;
    try {
      await fetch(`${API_URL}?action=deleteConsent&id=${id}`, { method: 'POST' });
      loadConsents();
      setMessage({ type: 'success', text: 'Consentimiento eliminado' });
    } catch (error) {
      console.error('Error deleting consent:', error);
      setMessage({ type: 'error', text: 'Error al eliminar' });
    }
  };

  const handleSave = async () => {
    if (!currentConsent) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}?action=saveConsent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentConsent)
      });
      const saved = await res.json();
      if (saved.id) {
        loadConsents();
        setView('list');
        setMessage({ type: 'success', text: 'Consentimiento guardado correctamente' });
      }
    } catch (error) {
      console.error('Error saving consent:', error);
      setMessage({ type: 'error', text: 'Error al guardar el consentimiento' });
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: keyof ConsentForm, value: any) => {
    if (!currentConsent) return;
    setCurrentConsent({ ...currentConsent, [field]: value });
  };

  const updateNestedField = (parent: keyof ConsentForm, child: string, value: any) => {
    if (!currentConsent) return;
    setCurrentConsent({
      ...currentConsent,
      [parent]: {
        ...(currentConsent[parent] as any),
        [child]: value
      }
    });
  };

  const migrateDB = async () => {
    if (!confirm('¿Actualizar estructura de base de datos? Esto agregará las columnas necesarias para la firma remota.')) return;
    try {
      const res = await fetch('/api/records?action=migrateConsents');
      if (res.ok) setMessage({ type: 'success', text: 'Base de datos actualizada correctamente' });
      else throw new Error('Error al actualizar');
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: 'Error de conexión' });
    }
  };

  const renderList = () => (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="w-1 h-6 bg-[#deb887] rounded-full" />
          <h3 className="text-lg font-bold text-gray-800">Historial de Consentimientos</h3>
        </div>
        <div className="flex gap-2">
          <Tooltip content="Actualizar estructura DB">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={migrateDB}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors"
            >
              <RefreshCw size={16} />
              Configurar DB
            </motion.button>
          </Tooltip>
          <Tooltip content="Crear nuevo consentimiento">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleNew}
              className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
            >
              <Plus size={20} />
              Nuevo Consentimiento
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Fecha</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Procedimiento</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Estado</th>
              <th className="px-6 py-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {consents.map((consent, index) => (
              <motion.tr 
                key={consent.id} 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="hover:bg-gray-50 transition-colors"
              >
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {new Date(consent.created_at || '').toLocaleDateString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {consent.procedure_type}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full 
                    ${consent.status === 'finalized' ? 'bg-emerald-100 text-emerald-800' : 
                      consent.status === 'annulled' ? 'bg-red-100 text-red-800' : 
                      'bg-amber-100 text-amber-800'}`}>
                    {consent.status === 'finalized' ? 'Finalizado' : 
                     consent.status === 'annulled' ? 'Anulado' : 'Borrador'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end gap-2">
                    <Tooltip content="Editar">
                      <motion.button 
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleEdit(consent)} 
                        className="text-blue-600 hover:bg-blue-50 p-2 rounded-lg transition-colors"
                      >
                        <Edit size={18} />
                      </motion.button>
                    </Tooltip>
                    <Tooltip content="Eliminar">
                      <motion.button 
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleDelete(consent.id!)} 
                        className="text-red-600 hover:bg-red-50 p-2 rounded-lg transition-colors"
                      >
                        <Trash2 size={18} />
                      </motion.button>
                    </Tooltip>
                  </div>
                </td>
              </motion.tr>
            ))}
            {consents.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-gray-400 flex flex-col items-center gap-2">
                  <FileText className="w-8 h-8 opacity-20" />
                  No hay consentimientos registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </motion.div>
  );

  const renderForm = () => {
    if (!currentConsent) return null;

    const tabs = [
      { id: 0, label: 'Información Básica', icon: FileText },
      { id: 1, label: 'Detalles Médicos', icon: AlertTriangle },
      { id: 2, label: 'Autorizaciones', icon: CheckCircle },
      { id: 3, label: 'Firmas', icon: Edit },
    ];

    return (
      <motion.div 
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="space-y-6"
      >
        <div className="flex justify-between items-center border-b border-gray-100 pb-4">
          <div className="flex items-center gap-4">
            <button onClick={() => setView('list')} className="text-gray-500 hover:text-gray-700 transition-colors">
              &larr; Volver
            </button>
            <h2 className="text-xl font-bold text-gray-800">
              {currentConsent.id ? 'Editar Consentimiento' : 'Nuevo Consentimiento'}
            </h2>
          </div>
          <div className="flex gap-2">
            <Tooltip content="Vista Previa">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setView('preview')}
                className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
              >
                <Eye size={18} />
                Vista Previa
              </motion.button>
            </Tooltip>
            <Tooltip content="Guardar Cambios">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSave}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
              >
                <Save size={18} />
                Guardar
              </motion.button>
            </Tooltip>
          </div>
        </div>

        {/* Template Selector */}
        <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
          <label className="block text-sm font-medium text-blue-900 mb-2">Cargar Plantilla de Consentimiento</label>
          <div className="relative" ref={dropdownRef}>
            <div className="relative">
              <input
                type="text"
                className="w-full p-2.5 pl-10 border border-blue-200 rounded-lg bg-white text-gray-700 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                placeholder="Buscar procedimiento..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setIsDropdownOpen(true);
                }}
                onFocus={() => setIsDropdownOpen(true)}
              />
              <Search className="absolute left-3 top-3 text-gray-400" size={18} />
              {searchTerm && (
                <button 
                  onClick={() => {
                    setSearchTerm('');
                    setIsDropdownOpen(false);
                  }}
                  className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
                >
                  <X size={18} />
                </button>
              )}
            </div>
            
            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-60 overflow-y-auto custom-scrollbar"
                >
                  {filteredTemplates.length > 0 ? (
                    filteredTemplates.map((t: any, i) => (
                      <button
                        key={i}
                        className="w-full text-left px-4 py-3 hover:bg-blue-50 text-gray-700 transition-colors border-b border-gray-50 last:border-0 text-sm"
                        onClick={() => {
                          const originalIndex = templates.indexOf(t);
                          loadTemplate(originalIndex.toString());
                          setSearchTerm(t.procedure_type);
                          setIsDropdownOpen(false);
                        }}
                      >
                        {t.procedure_type}
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-3 text-gray-500 text-sm">No se encontraron resultados</div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Tabs Navigation */}
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-6 py-3 border-b-2 whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? 'border-[#deb887] text-[#deb887] font-bold bg-[#deb887]/5'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <tab.icon size={18} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 min-h-[400px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 0 && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Procedimiento</label>
                      <input
                        type="text"
                        value={currentConsent.procedure_type}
                        onChange={(e) => updateField('procedure_type', e.target.value)}
                        className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all"
                        placeholder="Ej: Toxina Botulínica"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Zona a Tratar</label>
                      <input
                        type="text"
                        value={currentConsent.zone}
                        onChange={(e) => updateField('zone', e.target.value)}
                        className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all"
                        placeholder="Ej: Tercio superior facial"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Número de Sesiones</label>
                      <input
                        type="number"
                        value={currentConsent.sessions}
                        onChange={(e) => updateField('sessions', parseInt(e.target.value))}
                        className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all"
                        min="1"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Descripción del Procedimiento</label>
                    <textarea
                      value={currentConsent.description}
                      onChange={(e) => updateField('description', e.target.value)}
                      rows={4}
                      className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      placeholder="Describa el procedimiento detalladamente..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Objetivos (uno por línea)</label>
                    <textarea
                      value={currentConsent.objectives?.join('\n')}
                      onChange={(e) => updateField('objectives', e.target.value.split('\n'))}
                      rows={4}
                      className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      placeholder="Objetivo 1&#10;Objetivo 2"
                    />
                  </div>
                </div>
              )}

              {activeTab === 1 && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Riesgos (uno por línea)</label>
                      <textarea
                        value={currentConsent.risks?.join('\n')}
                        onChange={(e) => updateField('risks', e.target.value.split('\n'))}
                        rows={4}
                        className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Beneficios (uno por línea)</label>
                      <textarea
                        value={currentConsent.benefits?.join('\n')}
                        onChange={(e) => updateField('benefits', e.target.value.split('\n'))}
                        rows={4}
                        className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cuidados Previos</label>
                      <textarea
                        value={currentConsent.pre_care?.join('\n')}
                        onChange={(e) => updateField('pre_care', e.target.value.split('\n'))}
                        rows={4}
                        className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cuidados Posteriores</label>
                      <textarea
                        value={currentConsent.post_care?.join('\n')}
                        onChange={(e) => updateField('post_care', e.target.value.split('\n'))}
                        rows={4}
                        className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all resize-none"
                      />
                    </div>
                  </div>

                  <div className="border-t border-gray-100 pt-6">
                    <h4 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-amber-500" />
                      Antecedentes Críticos
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Alergias</label>
                        <input
                          type="text"
                          value={currentConsent.critical_antecedents?.allergies}
                          onChange={(e) => updateNestedField('critical_antecedents', 'allergies', e.target.value)}
                          className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Medicación Actual</label>
                        <input
                          type="text"
                          value={currentConsent.critical_antecedents?.medications}
                          onChange={(e) => updateNestedField('critical_antecedents', 'medications', e.target.value)}
                          className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all"
                        />
                      </div>
                      <div className="flex items-center gap-6">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={currentConsent.critical_antecedents?.pregnancy}
                            onChange={(e) => updateNestedField('critical_antecedents', 'pregnancy', e.target.checked)}
                            className="w-4 h-4 rounded text-[#deb887] focus:ring-[#deb887] border-gray-300"
                          />
                          <span className="text-sm text-gray-700">Embarazo / Lactancia</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={currentConsent.critical_antecedents?.herpes}
                            onChange={(e) => updateNestedField('critical_antecedents', 'herpes', e.target.checked)}
                            className="w-4 h-4 rounded text-[#deb887] focus:ring-[#deb887] border-gray-300"
                          />
                          <span className="text-sm text-gray-700">Herpes Recurrente</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 2 && (
                <div className="space-y-6">
                  <div className="bg-gray-50 p-6 rounded-xl border border-gray-100">
                    <h4 className="font-bold text-gray-900 mb-4">Autorizaciones de Imagen</h4>
                    <div className="space-y-4">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={currentConsent.authorizations?.image_use}
                          onChange={(e) => updateNestedField('authorizations', 'image_use', e.target.checked)}
                          className="mt-1 w-4 h-4 rounded text-[#deb887] focus:ring-[#deb887] border-gray-300"
                        />
                        <span className="text-sm text-gray-700 group-hover:text-gray-900 transition-colors">
                          Autorizo el uso de mis imágenes con fines educativos y/o promocionales, entendiendo que se protegerá mi identidad en la medida de lo posible.
                        </span>
                      </label>
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={currentConsent.authorizations?.photo_video}
                          onChange={(e) => updateNestedField('authorizations', 'photo_video', e.target.checked)}
                          className="mt-1 w-4 h-4 rounded text-[#deb887] focus:ring-[#deb887] border-gray-300"
                        />
                        <span className="text-sm text-gray-700 group-hover:text-gray-900 transition-colors">
                          Autorizo la toma de fotografías y/o videos del procedimiento para registro clínico.
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="bg-gray-50 p-6 rounded-xl border border-gray-100">
                    <h4 className="font-bold text-gray-900 mb-4">Declaraciones del Paciente</h4>
                    <div className="space-y-3">
                      {[
                        { key: 'understanding', label: 'He recibido información clara y completa del tratamiento.' },
                        { key: 'questions', label: 'He tenido oportunidad de resolver todas mis dudas.' },
                        { key: 'results', label: 'Entiendo que los resultados pueden variar y no se garantizan resultados específicos.' },
                        { key: 'authorization', label: 'Autorizo voluntariamente la realización del tratamiento.' },
                        { key: 'revocation', label: 'Sé que puedo revocar este consentimiento en cualquier momento antes del procedimiento.' },
                        { key: 'alternatives', label: 'Me han explicado las alternativas de tratamiento, incluyendo la opción de no tratarme.' }
                      ].map((item) => (
                        <label key={item.key} className="flex items-center gap-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={(currentConsent.declarations as any)?.[item.key]}
                            onChange={(e) => updateNestedField('declarations', item.key, e.target.checked)}
                            className="w-4 h-4 rounded text-[#deb887] focus:ring-[#deb887] border-gray-300"
                          />
                          <span className="text-sm text-gray-700 group-hover:text-gray-900 transition-colors">{item.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 3 && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="border border-gray-200 p-6 rounded-xl bg-gray-50/50">
                      <h4 className="font-bold text-gray-900 mb-4">Firma del Paciente</h4>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Completo</label>
                          <input
                            type="text"
                            value={currentConsent.signatures?.patient_name}
                            onChange={(e) => updateNestedField('signatures', 'patient_name', e.target.value)}
                            className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all"
                          />
                        </div>
                        
                        <div className="min-h-[200px] border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center bg-white p-6 transition-all hover:border-[#deb887]/50">
                          {currentConsent.signatures?.patient_sig_data ? (
                            <div className="w-full flex flex-col items-center">
                              <img 
                                src={currentConsent.signatures.patient_sig_data} 
                                alt="Firma Paciente" 
                                className="max-h-32 object-contain mb-4"
                              />
                              <span className="text-xs text-emerald-600 font-medium flex items-center gap-1 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                                <CheckCircle className="w-3 h-3" /> Firmado digitalmente
                              </span>
                              <button 
                                onClick={handleResetAndGenerate}
                                className="mt-4 flex items-center gap-2 px-4 py-2 text-xs text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors font-medium"
                              >
                                <RefreshCw size={12} /> Generar Nueva Solicitud
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-4 w-full">
                              {!showQr ? (
                                <>
                                  <span className="text-gray-400 text-sm">Sin firma registrada</span>
                                  <motion.button
                                    whileHover={{ scale: 1.05 }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={generateSigningLink}
                                    className="flex items-center gap-2 px-6 py-3 bg-[#deb887] text-white rounded-xl hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
                                  >
                                    <QrCode className="w-5 h-5" />
                                    Generar Firma Remota
                                  </motion.button>
                                </>
                              ) : (
                                <motion.div 
                                  initial={{ opacity: 0, scale: 0.9 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  className="flex flex-col items-center gap-4 w-full"
                                >
                                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                                    {signingUrl && <QRCodeSVG value={signingUrl} size={180} />}
                                  </div>
                                  <div className="text-center">
                                    <p className="text-sm font-bold text-gray-800 mb-1">Escanee para firmar</p>
                                    <a href={signingUrl!} target="_blank" rel="noreferrer" className="text-xs text-[#deb887] hover:underline break-all block max-w-[250px]">
                                      {signingUrl}
                                    </a>
                                  </div>
                                  <div className="flex gap-2 w-full">
                                    <button
                                      onClick={checkSigningStatus}
                                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium transition-colors"
                                    >
                                      <RefreshCw className="w-4 h-4" />
                                      Verificar
                                    </button>
                                    <button
                                      onClick={() => setShowQr(false)}
                                      className="px-3 py-2 text-gray-500 hover:text-gray-700 font-medium"
                                    >
                                      Cerrar
                                    </button>
                                  </div>
                                </motion.div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="border border-gray-200 p-6 rounded-xl bg-gray-50/50">
                      <h4 className="font-bold text-gray-900 mb-4">Firma del Profesional</h4>
                      <div className="space-y-4">
                        <div className="flex gap-2 items-end">
                          <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre y Registro</label>
                            <input
                              type="text"
                              value={currentConsent.signatures?.professional_name}
                              onChange={(e) => updateNestedField('signatures', 'professional_name', e.target.value)}
                              className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all"
                              placeholder="Dra. Daniela Creamer"
                            />
                          </div>
                          <Tooltip content="Cargar firma guardada">
                            <button
                              onClick={() => loadProfessionalSignature(currentConsent.signatures?.professional_name || '')}
                              className="px-3 py-2.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                            >
                              <RefreshCw size={20} />
                            </button>
                          </Tooltip>
                        </div>

                        <div className="border-2 border-dashed border-gray-300 rounded-xl bg-white p-6 flex flex-col items-center justify-center min-h-[200px] transition-all hover:border-[#deb887]/50">
                          {currentConsent.signatures?.professional_sig_data ? (
                            <div className="relative w-full flex flex-col items-center">
                              <img 
                                src={currentConsent.signatures.professional_sig_data} 
                                alt="Firma Profesional" 
                                className="max-h-32 object-contain mb-4"
                              />
                              <button 
                                onClick={() => {
                                  clearProfSignature();
                                  setIsSignatureModalOpen(true);
                                }}
                                className="flex items-center gap-2 px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-100 transition-colors font-medium"
                              >
                                <Edit size={14} /> Cambiar firma
                              </button>
                            </div>
                          ) : (
                            <motion.button
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              onClick={() => setIsSignatureModalOpen(true)}
                              className="flex flex-col items-center gap-3 text-gray-400 hover:text-[#deb887] transition-colors w-full py-8 group"
                            >
                              <div className="p-5 bg-gray-50 rounded-full group-hover:bg-[#deb887] group-hover:text-white transition-all shadow-sm">
                                <Edit size={32} />
                              </div>
                              <span className="font-medium text-lg">Haga clic para firmar</span>
                            </motion.button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Signature Modal */}
                  <AnimatePresence>
                    {isSignatureModalOpen && (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                      >
                        <motion.div 
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.9, opacity: 0 }}
                          className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col h-[85vh] overflow-hidden"
                        >
                          <div className="flex justify-between items-center p-4 border-b bg-gray-50">
                            <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                              <Edit className="text-[#deb887]" />
                              Firma del Profesional
                            </h3>
                            <button 
                              onClick={() => setIsSignatureModalOpen(false)}
                              className="text-gray-400 hover:text-gray-600 transition-colors p-1 hover:bg-gray-200 rounded-lg"
                            >
                              <X size={24} />
                            </button>
                          </div>
                          
                          <div className="flex-1 p-6 bg-gray-100 overflow-hidden relative flex flex-col">
                            <div className="flex-1 bg-white shadow-lg rounded-xl border border-gray-200 overflow-hidden relative">
                              <SignatureCanvas 
                                ref={profSigCanvas}
                                canvasProps={{
                                  className: 'w-full h-full cursor-crosshair',
                                  style: { width: '100%', height: '100%' }
                                }}
                                onEnd={handleProfSignatureEnd}
                                backgroundColor="white"
                              />
                              <div className="absolute bottom-4 left-0 right-0 text-center pointer-events-none opacity-30">
                                <span className="text-lg font-medium text-gray-400">Dibuje su firma aquí</span>
                              </div>
                            </div>
                          </div>

                          <div className="p-4 border-t flex justify-between items-center bg-white">
                            <button
                              onClick={() => {
                                profSigCanvas.current?.clear();
                                updateNestedField('signatures', 'professional_sig_data', '');
                              }}
                              className="flex items-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors font-medium"
                            >
                              <Eraser size={20} />
                              Limpiar
                            </button>
                            
                            <div className="flex gap-3">
                              <button
                                onClick={saveProfessionalSignature}
                                className="flex items-center gap-2 px-4 py-2 text-[#deb887] hover:bg-[#fff8f0] rounded-lg font-medium transition-colors border border-[#deb887]"
                              >
                                <Save size={20} />
                                Guardar como predeterminada
                              </button>
                              <button
                                onClick={() => setIsSignatureModalOpen(false)}
                                className="px-8 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] font-medium shadow-lg shadow-[#deb887]/20 transition-all transform hover:scale-105"
                              >
                                Aceptar
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="flex justify-end pt-6 border-t border-gray-100">
                    <div className="flex items-center gap-4 bg-gray-50 p-3 rounded-xl border border-gray-200">
                      <label className="block text-sm font-bold text-gray-700">Estado del Documento:</label>
                      <select
                        value={currentConsent.status}
                        onChange={(e) => updateField('status', e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none bg-white"
                      >
                        <option value="draft">Borrador</option>
                        <option value="finalized">Finalizado</option>
                        <option value="annulled">Anulado</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    );
  };

  const renderPreview = () => {
    if (!currentConsent) return null;
    
    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="space-y-6"
      >
        <style>{`
          @media print {
            @page {
              margin: 0;
              size: auto;
            }
            body * {
              visibility: hidden;
            }
            #printable-consent, #printable-consent * {
              visibility: visible;
            }
            #printable-consent {
              position: absolute;
              left: 0;
              top: 0;
              width: 100%;
              margin: 0;
              padding: 0 !important;
              background: white;
            }
            .no-print {
              display: none !important;
            }
          }
        `}</style>
        <div className="flex justify-between items-center border-b pb-4 no-print">
          <button onClick={() => setView('form')} className="text-gray-500 hover:text-gray-700 transition-colors font-medium">
            &larr; Volver a Edición
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-6 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors shadow-lg font-medium"
          >
            <Printer size={18} />
            Imprimir
          </button>
        </div>

        <div id="printable-consent" className="bg-white p-8 md:p-12 max-w-4xl mx-auto shadow-xl print:shadow-none print:p-0 rounded-xl">
          <table className="w-full">
            <thead className="hidden print:table-header-group"><tr><td className="h-[1.5cm]"></td></tr></thead>
            <tfoot className="hidden print:table-footer-group"><tr><td className="h-[1.5cm]"></td></tr></tfoot>
            <tbody>
              <tr>
                <td className="print:px-[1.5cm] align-top">
                  {/* Header */}
                  <div className="flex flex-col md:flex-row justify-between items-start mb-8 border-b-2 border-[#deb887] pb-6 gap-4 md:gap-0">
                    <div className="flex items-center gap-6">
                      <img src="/images/logo/logo.png" alt="BioSkin Logo" className="h-24 w-auto object-contain" />
                      <div>
                        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">BIOSKIN SALUD Y ESTETICA</h2>
                        <p className="text-base font-bold text-[#deb887] mt-1">DRA. DANIELA CREAMER</p>
                        <p className="text-sm text-gray-500">Cosmiatría y Dermatocosmiatría Clínica</p>
                      </div>
                    </div>
                    <div className="text-right text-sm text-gray-600 space-y-1">
                      <p><strong>Fecha:</strong> {new Date().toLocaleDateString()}</p>
                      <p><strong>Expediente:</strong> #{recordId}</p>
                    </div>
                  </div>

          {/* Patient Info */}
          <div className="bg-gray-50 p-6 rounded-xl mb-10 text-sm border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-4 border-b border-gray-200 pb-2 text-base">INFORMACIÓN DEL PACIENTE</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-8">
              <p><strong className="text-gray-700">Nombre:</strong> {patient?.first_name} {patient?.last_name}</p>
              <p><strong className="text-gray-700">Identificación:</strong> {patient?.rut || 'N/A'}</p>
              <p><strong className="text-gray-700">Edad:</strong> {patient?.birth_date ? calculateAge(patient.birth_date) : 'N/A'} años</p>
              <p><strong className="text-gray-700">Teléfono:</strong> {patient?.phone || 'N/A'}</p>
            </div>
          </div>

          <div className="text-center mb-10">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">CONSENTIMIENTO INFORMADO</h1>
            <h2 className="text-xl text-[#deb887] font-medium uppercase tracking-wide">{currentConsent.procedure_type}</h2>
          </div>

          <div className="space-y-8 text-gray-800 leading-relaxed">
            <section>
              <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">1. DESCRIPCIÓN DEL PROCEDIMIENTO</h3>
              <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                <p className="mb-2"><strong>Zona a tratar:</strong> {currentConsent.zone}</p>
                <p className="mb-2"><strong>Sesiones estimadas:</strong> {currentConsent.sessions}</p>
                <p className="whitespace-pre-wrap mt-2">{currentConsent.description}</p>
              </div>
            </section>

            {currentConsent.objectives?.length > 0 && (
              <section>
                <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">2. OBJETIVOS</h3>
                <ul className="list-disc pl-5 space-y-1 marker:text-[#deb887]">
                  {currentConsent.objectives.map((obj, i) => <li key={i}>{obj}</li>)}
                </ul>
              </section>
            )}

            <section>
              <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">3. RIESGOS Y BENEFICIOS</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-red-50 p-4 rounded-lg border border-red-100">
                  <h4 className="font-bold mb-2 text-red-800 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" /> Riesgos
                  </h4>
                  <ul className="list-disc pl-5 text-sm space-y-1 marker:text-red-400">
                    {currentConsent.risks?.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
                <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-100">
                  <h4 className="font-bold mb-2 text-emerald-800 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4" /> Beneficios
                  </h4>
                  <ul className="list-disc pl-5 text-sm space-y-1 marker:text-emerald-400">
                    {currentConsent.benefits?.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">4. CUIDADOS</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <h4 className="font-bold mb-2 text-gray-800">Previos:</h4>
                  <ul className="list-disc pl-5 text-sm space-y-1 marker:text-[#deb887]">
                    {currentConsent.pre_care?.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold mb-2 text-gray-800">Posteriores:</h4>
                  <ul className="list-disc pl-5 text-sm space-y-1 marker:text-[#deb887]">
                    {currentConsent.post_care?.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">5. ANTECEDENTES CRÍTICOS</h3>
              <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="mb-1"><strong className="text-gray-700">Alergias:</strong> {currentConsent.critical_antecedents?.allergies || 'Niega'}</p>
                  <p><strong className="text-gray-700">Medicación:</strong> {currentConsent.critical_antecedents?.medications || 'Niega'}</p>
                </div>
                <div>
                  <p className="mb-1"><strong className="text-gray-700">Embarazo/Lactancia:</strong> {currentConsent.critical_antecedents?.pregnancy ? 'Sí' : 'No'}</p>
                  <p><strong className="text-gray-700">Herpes Recurrente:</strong> {currentConsent.critical_antecedents?.herpes ? 'Sí' : 'No'}</p>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b-2 border-[#deb887] mb-3 text-lg text-gray-900">6. DECLARACIONES Y AUTORIZACIONES</h3>
              <div className="space-y-3 text-sm bg-gray-50 p-6 rounded-lg border border-gray-100">
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.understanding ? '' : ''}</span>
                  Declaro haber recibido información clara y completa del tratamiento.
                </p>
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.questions ? '' : ''}</span>
                  He tenido oportunidad de resolver todas mis dudas.
                </p>
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.results ? '' : ''}</span>
                  Entiendo que los resultados pueden variar y no se garantizan resultados específicos.
                </p>
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.authorization ? '' : ''}</span>
                  Autorizo voluntariamente la realización del tratamiento.
                </p>
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.revocation ? '' : ''}</span>
                  Sé que puedo revocar este consentimiento en cualquier momento antes del procedimiento.
                </p>
                <p className="flex gap-3">
                  <span className="font-bold text-lg leading-none">{currentConsent.declarations?.alternatives ? '' : ''}</span>
                  Me han explicado las alternativas de tratamiento, incluyendo la opción de no tratarme.
                </p>
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <p className="flex gap-3 mb-2">
                    <span className="font-bold text-lg leading-none">{currentConsent.authorizations?.image_use ? '' : ''}</span>
                    Autorizo el uso de mis imágenes con fines educativos y/o promocionales.
                  </p>
                  <p className="flex gap-3">
                    <span className="font-bold text-lg leading-none">{currentConsent.authorizations?.photo_video ? '' : ''}</span>
                    Autorizo la toma de fotografías y/o videos del procedimiento para registro clínico.
                  </p>
                </div>
              </div>
            </section>

            <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 gap-16 pt-8 page-break-inside-avoid">
              <div className="flex flex-col items-center">
                {currentConsent.signatures?.patient_sig_data && (
                  <img 
                    src={currentConsent.signatures.patient_sig_data} 
                    alt="Firma Paciente" 
                    className="h-24 object-contain mb-2"
                  />
                )}
                <div className="w-full border-t border-gray-400 pt-2 text-center">
                  <p className="font-bold text-gray-900">{currentConsent.signatures?.patient_name}</p>
                  <p className="text-sm text-gray-500 uppercase tracking-wider mt-1">Firma del Paciente</p>
                </div>
              </div>
              
              <div className="flex flex-col items-center">
                {currentConsent.signatures?.professional_sig_data && (
                  <img 
                    src={currentConsent.signatures.professional_sig_data} 
                    alt="Firma Profesional" 
                    className="h-24 object-contain mb-2"
                  />
                )}
                <div className="w-full border-t border-gray-400 pt-2 text-center">
                  <p className="font-bold text-gray-900">{currentConsent.signatures?.professional_name}</p>
                  <p className="text-sm text-gray-500 uppercase tracking-wider mt-1">Firma del Profesional</p>
                </div>
              </div>
            </div>
            
            <div className="text-center text-xs text-gray-400 mt-12 border-t border-gray-100 pt-4">
              Documento generado el {new Date().toLocaleDateString()}  BIOSKIN SALUD Y ESTÉTICA
            </div>
            </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </motion.div>
    );
  };

  return (
    <div className="p-4">
      {view === 'list' && renderList()}
      {view === 'form' && renderForm()}
      {view === 'preview' && renderPreview()}
    </div>
  );
}
