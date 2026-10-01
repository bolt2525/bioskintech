import React, { useState, useEffect, useRef } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileText, Plus, Trash2, Edit, Eye, Save, Printer, 
  CheckCircle, XCircle, AlertTriangle,
  RefreshCw, QrCode, Eraser, X, Search, Check, AlertCircle, History
} from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import { QRCodeSVG } from 'qrcode.react';
import SignatureCanvas from 'react-signature-canvas';
import { normalizeSignature, normalizeSignatureDataUrl, isNormalizedSignature, NORMALIZED_SIGNATURE_HEIGHT_PX, SIGNATURE_PEN } from '../../../../../utils/signatureImage';
import ConsentDocumentSections from '../ConsentDocumentSections';
import { Tooltip } from '../../../../ui/Tooltip';
import { useClinicSettings } from '../../../../../hooks/useClinicSettings';
import { useAuth } from '../../../../../context/AuthContext';
import { useMasterView } from '../../../../../context/MasterViewContext';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';
import { Dialog } from '../../../../ui/Dialog';

interface ConsentTemplate {
  id?: number | string;
  name?: string;
  procedure_type?: string;
  description?: string;
  objectives?: string[];
  risks?: string[];
  benefits?: string[];
  alternatives?: string[];
  pre_care?: string[];
  post_care?: string[];
  contraindications?: string[];
  [key: string]: unknown;
}

// Fallback local templates (sólo si la clínica no tiene asignadas desde DB)
const localTemplatesGlob = import.meta.glob('/src/data/consent-templates/*.json', { eager: true });
const localTemplates = Object.values(localTemplatesGlob).map(mod => {
  const templateModule = mod as { default?: ConsentTemplate };
  return templateModule.default || templateModule as ConsentTemplate;
});

interface ConsentPatient {
  first_name?: string;
  last_name?: string;
  birth_date?: string;
  email?: string;
  phone?: string;
  identification_type?: string;
  identification_number?: string;
  [key: string]: unknown;
}

interface ConsentForm {
  id?: number;
  record_id: number;
  patient_id: number;
  consultation_id?: number;
  status: 'draft' | 'finalized' | 'signed' | 'annulled';
  signing_status?: string;
  signing_hash?: string;
  annulled_at?: string | null;
  annulled_by_user_id?: number | null;
  annulled_by_name?: string | null;
  annulment_reason?: string | null;
  replaces_consent_id?: number | null;
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
    privacy_policy?: boolean;
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
    patient_signed_at?: string;
    professional_sig_data?: string;
    signature_method?: string;
    witness_user_id?: number | null;
    witness_name?: string;
    sig_scale?: 'sm' | 'md' | 'lg' | 'xl';
    patient_sig_size?: number;
    professional_sig_size?: number;
  };
  attachments: unknown[];
}

interface Props {
  patientId: number;
  recordId: number;
  patient?: ConsentPatient;
  consultationId?: number;
  consultations?: ConsultationRef[];
  initialConsents?: ConsentForm[];
}

const API_URL = '/api/records';
const isSignedConsent = (consent: ConsentForm) =>
  consent.status === 'signed' || consent.status === 'finalized' || consent.signing_status === 'signed' ||
  Boolean(consent.signatures?.patient_sig_data || consent.signatures?.patient_signed_at);
const isAnnulledConsent = (consent: ConsentForm) => consent.status === 'annulled' || Boolean(consent.annulled_at);
const hasProfessionalSignature = (consent?: ConsentForm | null) =>
  Boolean(consent?.signatures?.professional_name?.trim() &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(consent.signatures.professional_sig_data || ''));

export default function ConsentimientosTab({ patientId, recordId, patient, consultationId, consultations = [], initialConsents = [] }: Props) {
  const { settings: clinic } = useClinicSettings();
  const { user } = useAuth();
  const { clinicId: masterViewClinicId } = useMasterView();
  // Use masterViewClinicId when master_admin is viewing a specific clinic
  const effectiveClinicId = user?.clinic_id || (masterViewClinicId ? String(masterViewClinicId) : null);
  const clinicDisplayName = clinic.general.name || user?.clinic_name || 'Clínica';
  const professionalName = [user?.gentilicio, user?.full_name].filter(Boolean).join(' ');
  const [consents, setConsents] = useState<ConsentForm[]>(initialConsents);
  const [dbTemplates, setDbTemplates] = useState<ConsentTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [view, setView] = useState<'list' | 'form' | 'preview'>('list');
  const [isPaperConsent, setIsPaperConsent] = useState(false);
  const [annulTarget, setAnnulTarget] = useState<ConsentForm | null>(null);
  const [annulReason, setAnnulReason] = useState('');
  const [createReplacementOnAnnul, setCreateReplacementOnAnnul] = useState(false);
  const [annulling, setAnnulling] = useState(false);
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
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const currentConsents = consents.filter(c => Number(c.consultation_id) === Number(consultationId));
  const otherConsentCount = consents.filter(c => Number(c.consultation_id) !== Number(consultationId)).length;

  // Combina plantillas de DB (por clínica) con fallback a locales
  const templates = dbTemplates.length > 0 ? dbTemplates : localTemplates;
  const filteredTemplates = templates.filter(t =>
    (t.procedure_type || t.name || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Carga plantillas de consentimiento desde la DB para esta clínica
  const loadDbTemplates = async () => {
    setTemplatesLoading(true);
    try {
      // Server derives clinic from session for regular users; pass clinicId for master admin context
      const params = effectiveClinicId ? `&clinicId=${effectiveClinicId}` : '';
      const res = await recordsFetch(
        `/api/admin-auth?action=getClinicConsentTemplates${params}`
      );
      if (res.ok) {
        const data = await res.json();
        // Only update if results arrived — never clear with empty to avoid stale-wipe bug
        if (Array.isArray(data.templates) && data.templates.length > 0) {
          setDbTemplates(data.templates);
        }
      } else {
        const text = await res.text().catch(() => '');
        console.error('[ConsentimientosTab] getClinicConsentTemplates failed:', res.status, text);
      }
    } catch (err) {
      console.error('[ConsentimientosTab] getClinicConsentTemplates error:', err);
    } finally {
      setTemplatesLoading(false);
    }
  };

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

  // Templates reload only when clinic context changes — recordId changes must NOT re-fetch templates
  useEffect(() => {
    loadDbTemplates();
  }, [effectiveClinicId]);

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadProfessionalSignature = async (name: string) => {
    if (!name) return;
    try {
      const res = await recordsFetch(`/api/records?action=getProfessionalSignature&name=${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.signature) {
          // If signature exists, update the current consent
          updateNestedField('signatures', 'professional_sig_data', await normalizeSignatureDataUrl(data.signature));
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
      const res = await recordsFetch('/api/records', {
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
      const dataUrl = normalizeSignature(profSigCanvas.current.getCanvas());
      updateNestedField('signatures', 'professional_sig_data', dataUrl);
    }
  };

  const handleResetAndGenerate = async () => {
    if (!currentConsent) return;
    if (!confirm('¿Está seguro de eliminar la firma actual y generar una nueva solicitud? El paciente deberá firmar nuevamente.')) return;

    const newSignatures = { ...currentConsent.signatures };
    delete newSignatures.patient_sig_data;
    delete newSignatures.patient_signed_at;
    delete newSignatures.signature_method;
    delete newSignatures.witness_user_id;
    delete newSignatures.witness_name;
    const updatedConsent = {
      ...currentConsent,
      status: 'draft' as const,
      declarations: {
        understanding: false,
        questions: false,
        results: false,
        authorization: false,
        revocation: false,
        alternatives: false,
      },
      authorizations: { image_use: false, photo_video: false },
      signatures: { ...newSignatures, patient_name: currentConsent.signatures?.patient_name || '' }
    };
    delete updatedConsent.id;
    setLoading(true);
    try {
      const saved = await recordsFetch(`${API_URL}?action=saveConsent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConsent),
      });
      if (!saved.ok) throw new Error('No se pudo crear un nuevo consentimiento');
      const newConsent = await saved.json();
      setCurrentConsent(newConsent);
      if (!patient?.email?.trim()) {
        setView('form');
        setMessage({ type: 'success', text: 'Nuevo consentimiento creado. El paciente no tiene correo: use “Firma presencial en papel” para imprimir el formato.' });
        await loadConsents();
        return;
      }

      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generateSigningToken',
          id: newConsent.id,
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.url}`;
        setSigningUrl(url);
        setShowQr(true);
        setMessage({ type: 'success', text: `Código enviado desde ${data.senderType === 'oauth' ? 'Gmail conectado' : 'Gmail de respaldo'}: ${data.senderEmail}.` });
      } else {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error || 'Error al generar nuevo enlace');
      }
    } catch (error) {
      console.error('Error resetting signature:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al restablecer firma' });
    } finally {
      setLoading(false);
    }
  };

  const generateSigningLink = async () => {
    if (!currentConsent) return;
    if (!hasProfessionalSignature(currentConsent)) {
      setMessage({ type: 'error', text: 'Antes de solicitar la firma del paciente, cargue una firma profesional guardada o firme como profesional.' });
      setActiveTab(3);
      return;
    }
    if (!patient?.email?.trim()) {
      setMessage({ type: 'error', text: 'Este paciente no tiene correo registrado. Use “Firma presencial en papel”.' });
      return;
    }
    
    try {
      setLoading(true);
      const savedConsent = await persistConsentDraft(currentConsent);
      setCurrentConsent(savedConsent);
      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generateSigningToken',
          id: savedConsent.id
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.url}`;
        setSigningUrl(url);
        setShowQr(true);
        setMessage({ type: 'success', text: `Código enviado desde ${data.senderType === 'oauth' ? 'Gmail conectado' : 'Gmail de respaldo'}: ${data.senderEmail}.` });
      } else {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error || 'Error al generar enlace');
      }
    } catch (error) {
      console.error('Error generating signing link:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al generar enlace de firma' });
    } finally {
      setLoading(false);
    }
  };

  const checkSigningStatus = async () => {
    if (!currentConsent?.id) return;
    
    try {
      setLoading(true);
      const res = await recordsFetch(`${API_URL}?action=getConsent&id=${currentConsent.id}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentConsent(data);
        if (data.signatures?.patient_sig_data) {
          setShowQr(false);
          setView('preview');
          loadConsents(); // refresh list so signed state reflects in the list
          setMessage({ type: 'success', text: 'Firma verificada. El consentimiento ya quedó guardado; no necesita volver a guardarlo.' });
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

  const persistConsentDraft = async (consent: ConsentForm) => {
    const res = await recordsFetch(`${API_URL}?action=saveConsent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...consent, ...(consultationId ? { consultation_id: consultationId } : {}) }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || 'Guarde el consentimiento antes de firmar.');
    }
    return await res.json() as ConsentForm;
  };

  const preparePaperConsent = async () => {
    if (!currentConsent || isSignedConsent(currentConsent)) return;
    try {
      setLoading(true);
      const saved = await persistConsentDraft(currentConsent);
      setCurrentConsent(saved);
      setIsPaperConsent(true);
      setView('preview');
      setMessage({ type: 'success', text: 'Formato listo para imprimir. Marque las casillas y recoja ambas firmas con esfero; el consentimiento sigue como borrador hasta registrar el documento firmado.' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo preparar el formato para imprimir.' });
    } finally {
      setLoading(false);
    }
  };

  const loadConsents = async () => {
    setLoading(true);
    try {
      const res = await recordsFetch(`${API_URL}?action=listConsents&patient_id=${patientId}&record_id=${recordId}`);
      if (!res.ok) throw new Error('Error al cargar consentimientos');
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
      procedure_type: template.procedure_type || template.name || '',
      description: template.description || '',
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
    setIsPaperConsent(false);
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
        professional_name: professionalName || '',
        sig_scale: 'md',
      },
      attachments: []
    });
    setView('form');
    setActiveTab(0);
    setMessage(null);
  };

  const handleEdit = (consent: ConsentForm) => {
    setCurrentConsent(consent);
    setIsPaperConsent(false);
    // Finalized consents are immutable — open in preview only
    setView(isSignedConsent(consent) || isAnnulledConsent(consent) ? 'preview' : 'form');
    setActiveTab(0);
    setMessage(null);
  };

  const handleAnnul = async () => {
    if (!annulTarget?.id || annulling) return;
    setAnnulling(true);
    try {
      const res = await recordsFetch(`${API_URL}?action=annulConsent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: annulTarget.id, reason: annulReason.trim(), createReplacement: createReplacementOnAnnul }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'No se pudo anular el consentimiento.');
      setAnnulTarget(null);
      setAnnulReason('');
      setCreateReplacementOnAnnul(false);
      await loadConsents();
      setMessage({ type: 'success', text: result.message });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo anular el consentimiento.' });
    } finally {
      setAnnulling(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('¿Está seguro de eliminar este consentimiento?')) return;
    try {
      await recordsFetch(`${API_URL}?action=deleteConsent&id=${id}`, { method: 'POST' });
      loadConsents();
      setMessage({ type: 'success', text: 'Consentimiento eliminado' });
    } catch (error) {
      console.error('Error deleting consent:', error);
      setMessage({ type: 'error', text: 'Error al eliminar' });
    }
  };

  // Signature size helpers — component scope, not inside handleSave
  const patientSigSize  = currentConsent?.signatures?.patient_sig_size  ?? 80;
  const profSigSize     = currentConsent?.signatures?.professional_sig_size ?? 120;
  // Las firmas normalizadas tienen tamaño fijo; el control manual solo aplica a firmas antiguas.
  const sigHeight = (dataUrl: string | undefined, legacyPx: number) =>
    ({ height: `${isNormalizedSignature(dataUrl) ? NORMALIZED_SIGNATURE_HEIGHT_PX : legacyPx}px` });
  const hasLegacySignature = [currentConsent?.signatures?.patient_sig_data, currentConsent?.signatures?.professional_sig_data]
    .some(sig => sig && !isNormalizedSignature(sig));

  const sigSizeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSigSizeChange = (field: 'patient_sig_size' | 'professional_sig_size', px: number) => {
    if (!currentConsent) return;
    const updated = { ...currentConsent, signatures: { ...currentConsent.signatures, [field]: px } };
    setCurrentConsent(updated);
    if (!updated.id) return;
    // Guarda una sola vez al soltar el control, no en cada paso del deslizador.
    if (sigSizeSaveTimer.current) clearTimeout(sigSizeSaveTimer.current);
    sigSizeSaveTimer.current = setTimeout(() => {
      recordsFetch(`${API_URL}?action=saveConsent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updated, ...(consultationId ? { consultation_id: consultationId } : {}) })
      }).catch(() => { /* el tamaño queda en pantalla aunque falle el guardado */ });
    }, 600);
  };

  const handleSave = async () => {
    if (!currentConsent) return;
    if (isSignedConsent(currentConsent)) {
      setView('preview');
      setMessage({ type: 'success', text: 'Este consentimiento ya fue firmado y guardado. No necesita volver a guardarlo.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await recordsFetch(`${API_URL}?action=saveConsent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...currentConsent, ...(consultationId ? { consultation_id: consultationId } : {}) })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al guardar');
      }
      const saved = await res.json();
      if (saved.id) {
        setCurrentConsent(prev => prev ? { ...prev, id: saved.id } : prev);
        await loadConsents();
        setView('list');
        setMessage({ type: 'success', text: 'Consentimiento guardado correctamente' });
      }
    } catch (error) {
      console.error('Error saving consent:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al guardar el consentimiento' });
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: keyof ConsentForm, value: unknown) => {
    if (!currentConsent) return;
    setCurrentConsent({ ...currentConsent, [field]: value } as ConsentForm);
  };

  const updateNestedField = (parent: 'critical_antecedents' | 'authorizations' | 'declarations' | 'signatures', child: string, value: unknown) => {
    if (!currentConsent) return;
    setCurrentConsent({
      ...currentConsent,
      [parent]: {
        ...(currentConsent[parent] as object),
        [child]: value
      }
    } as ConsentForm);
  };

  const migrateDB = async () => {
    if (!confirm('¿Actualizar estructura de base de datos? Esto agregará las columnas necesarias para la firma remota.')) return;
    try {
      const res = await recordsFetch('/api/records?action=migrateConsents');
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1 h-6 bg-[#deb887] rounded-full" />
          <h3 className="text-lg font-bold text-gray-800">Historial de Consentimientos</h3>
          {otherConsentCount > 0 && (
            <button onClick={() => setCrossHistOpen(true)} title={`Ver ${otherConsentCount} consentimiento(s) de otras consultas`} className="ml-2 p-1 hover:bg-[#deb887]/10 rounded-lg relative">
              <History className="w-4 h-4 text-[#b8944d]" />
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#b8944d] text-white text-[8px] rounded-full flex items-center justify-center font-bold">{otherConsentCount > 9 ? '9+' : otherConsentCount}</span>
            </button>
          )}
          <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 ml-1">{currentConsents.length}</span>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          <Tooltip content="Actualizar estructura DB">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={migrateDB}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors"
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
              className="flex items-center justify-center gap-2 px-3 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 text-sm font-medium"
            >
              <Plus size={20} />
              Nuevo Consentimiento
            </motion.button>
          </Tooltip>
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {currentConsents.map((consent, index) => (
          <motion.article
            key={consent.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className="rounded-lg border border-gray-100 bg-white p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-500">
                  {new Date(consent.created_at || '').toLocaleDateString()}
                </p>
                <h4 className="mt-1 text-sm font-semibold leading-5 text-gray-900">{consent.procedure_type}</h4>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                isAnnulledConsent(consent) ? 'bg-red-100 text-red-800' :
                isSignedConsent(consent) ? 'bg-emerald-100 text-emerald-800' :
                'bg-amber-100 text-amber-800'
              }`}>
                {isAnnulledConsent(consent) ? 'Anulado' : isSignedConsent(consent) ? 'Firmado' : 'Borrador'}
              </span>
            </div>
            {consent.replaces_consent_id && <p className="mt-2 text-xs text-gray-500">Reemplaza #{consent.replaces_consent_id}</p>}
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
              {isSignedConsent(consent) || isAnnulledConsent(consent) ? (
                <>
                  <button type="button" onClick={() => handleEdit(consent)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">
                    <Eye size={18} /> Ver
                  </button>
                  {!isAnnulledConsent(consent) && (
                    <button type="button" onClick={() => { setAnnulTarget(consent); setAnnulReason(''); setCreateReplacementOnAnnul(false); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50">
                      <XCircle size={18} /> Anular
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button type="button" onClick={() => handleEdit(consent)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-blue-700 hover:bg-blue-50">
                    <Edit size={18} /> Editar
                  </button>
                  <button type="button" onClick={() => handleDelete(consent.id!)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50">
                    <Trash2 size={18} /> Eliminar
                  </button>
                </>
              )}
            </div>
          </motion.article>
        ))}
        {loading && consents.length === 0 && <p className="py-10 text-center text-sm text-gray-400">Cargando consentimientos...</p>}
        {!loading && consents.length === 0 && <p className="py-10 text-center text-sm text-gray-400">No hay consentimientos registrados</p>}
      </div>

      <div className="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden md:block">
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
            {currentConsents.map((consent, index) => (
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
                    ${isAnnulledConsent(consent) ? 'bg-red-100 text-red-800' :
                      isSignedConsent(consent) ? 'bg-emerald-100 text-emerald-800' :
                      'bg-amber-100 text-amber-800'}`}>
                    {isAnnulledConsent(consent) ? 'Anulado' : isSignedConsent(consent) ? 'Firmado' : 'Borrador'}
                  </span>
                  {consent.replaces_consent_id && <span className="block text-xs text-gray-500 mt-1">Reemplaza #{consent.replaces_consent_id}</span>}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end gap-2">
                    {isSignedConsent(consent) || isAnnulledConsent(consent) ? (
                      <>
                      <Tooltip content="Vista Previa">
                        <motion.button
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          onClick={() => handleEdit(consent)}
                          className="text-emerald-600 hover:bg-emerald-50 p-2 rounded-lg transition-colors"
                        >
                          <Eye size={18} />
                        </motion.button>
                      </Tooltip>
                      {!isAnnulledConsent(consent) && (
                        <Tooltip content="Anular consentimiento">
                          <button type="button" onClick={() => { setAnnulTarget(consent); setAnnulReason(''); setCreateReplacementOnAnnul(false); }} className="text-red-700 hover:bg-red-50 p-2 rounded-lg" aria-label="Anular consentimiento">
                            <XCircle size={18} />
                          </button>
                        </Tooltip>
                      )}
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </td>
              </motion.tr>
            ))}
            {loading && consents.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-gray-400">Cargando consentimientos...</td>
              </tr>
            )}
            {!loading && consents.length === 0 && (
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
            <button
              type="button"
              onClick={preparePaperConsent}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 font-medium"
            >
              <Printer size={18} /> Imprimir para firma en papel
            </button>
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
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-blue-900">Cargar Plantilla de Consentimiento</label>
            <button
              onClick={loadDbTemplates}
              disabled={templatesLoading}
              title={dbTemplates.length > 0 ? `${dbTemplates.length} plantillas cargadas` : 'Cargar plantillas desde base de datos'}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors px-2 py-1 rounded-lg hover:bg-blue-100"
            >
              <RefreshCw size={13} className={templatesLoading ? 'animate-spin' : ''} />
              {dbTemplates.length > 0 ? `${dbTemplates.length} plantillas` : 'Recargar'}
            </button>
          </div>
          <div className="relative" ref={dropdownRef}>
            <div className="relative">
              <input
                id="consent-template-search"
                name="consent-template-search"
                type="text"
                aria-label="Buscar plantilla de consentimiento"
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
                    filteredTemplates.map((t, i) => (
                      <button
                        key={i}
                        className="w-full text-left px-4 py-3 hover:bg-blue-50 text-gray-700 transition-colors border-b border-gray-50 last:border-0 text-sm"
                        onClick={() => {
                          const originalIndex = templates.indexOf(t);
                          loadTemplate(originalIndex.toString());
                          setSearchTerm(t.procedure_type || t.name || '');
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
        <div className="admin-tabs w-full" role="group" aria-label="Secciones del consentimiento">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              id={`consent-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              aria-controls="consent-tabpanel"
              className="admin-tab admin-focus-ring"
            >
              <tab.icon size={18} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div id="consent-tabpanel" role="region" aria-labelledby={`consent-tab-${activeTab}`} className="admin-surface min-h-[400px] p-4 sm:p-6">
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
                      <label htmlFor="consent-procedure-type" className="block text-sm font-medium text-gray-700 mb-1">Tipo de Procedimiento<FieldHelp text={HELP.consent.procedure_type} /></label>
                      <input
                        id="consent-procedure-type"
                        name="consent-procedure-type"
                        type="text"
                        value={currentConsent.procedure_type}
                        onChange={(e) => updateField('procedure_type', e.target.value)}
                        className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all"
                        placeholder="Ej: Toxina Botulínica"
                      />
                    </div>
                    <div>
                      <label htmlFor="consent-zone" className="block text-sm font-medium text-gray-700 mb-1">Zona a Tratar<FieldHelp text={HELP.consent.zone} /></label>
                      <input
                        id="consent-zone"
                        name="consent-zone"
                        type="text"
                        value={currentConsent.zone}
                        onChange={(e) => updateField('zone', e.target.value)}
                        className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all"
                        placeholder="Ej: Tercio superior facial"
                      />
                    </div>
                    <div>
                      <label htmlFor="consent-sessions" className="block text-sm font-medium text-gray-700 mb-1">Número de Sesiones<FieldHelp text={HELP.consent.sessions} /></label>
                      <input
                        id="consent-sessions"
                        name="consent-sessions"
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
                        <label htmlFor="consent-allergies" className="block text-sm font-medium text-gray-700 mb-1">Alergias</label>
                        <input
                          id="consent-allergies"
                          name="consent-allergies"
                          type="text"
                          onChange={(e) => updateNestedField('critical_antecedents', 'allergies', e.target.value)}
                          className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all"
                        />
                      </div>
                      <div>
                        <label htmlFor="consent-medications" className="block text-sm font-medium text-gray-700 mb-1">Medicación Actual</label>
                        <input
                          id="consent-medications"
                          name="consent-medications"
                          type="text"
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
                            checked={(currentConsent.declarations as Record<string, boolean>)[item.key]}
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
                                <div className="flex flex-col items-center gap-3">
                                  <span className="text-gray-400 text-sm">Sin firma registrada</span>
                                  {!hasProfessionalSignature(currentConsent) && <p role="status" className="max-w-md text-center text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">Para la firma electrónica remota primero cargue o registre la firma digital del profesional. Para firma en papel, use “Imprimir para firma en papel”.</p>}
                                  <div className="flex flex-col sm:flex-row gap-2 w-full">
                                    <button
                                      type="button"
                                      onClick={generateSigningLink}
                                      disabled={!patient?.email?.trim() || !hasProfessionalSignature(currentConsent) || loading}
                                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                                    >
                                      <QrCode className="w-5 h-5" /> Firma remota por correo
                                    </button>
                                    <button
                                      type="button"
                                      onClick={preparePaperConsent}
                                      disabled={loading}
                                      className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border border-[#b8944d] text-[#725b2d] rounded-lg hover:bg-amber-50 disabled:opacity-50 font-medium"
                                    >
                                      <Printer className="w-5 h-5" /> Firma presencial en papel
                                    </button>
                                  </div>
                                  {!patient?.email?.trim() && <p className="max-w-sm text-center text-xs text-gray-500">Sin correo registrado: el paciente puede revisar y firmar aquí con apoyo del profesional.</p>}
                                </div>
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
                              placeholder="Nombre del profesional"
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
                      <Dialog open onClose={() => setIsSignatureModalOpen(false)} labelledBy="professional-signature-title">
                        <motion.div 
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.9, opacity: 0 }}
                          className="flex h-[min(85dvh,52rem)] w-[min(64rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
                        >
                          <div className="flex justify-between items-center p-4 border-b bg-gray-50">
                            <h3 id="professional-signature-title" className="text-xl font-bold text-gray-800 flex items-center gap-2">
                              <Edit className="text-[#deb887]" />
                              Firma del Profesional
                            </h3>
                            <button 
                              onClick={() => setIsSignatureModalOpen(false)}
                              className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
                              aria-label="Cerrar firma profesional"
                            >
                              <X size={24} />
                            </button>
                          </div>
                          
                          <div className="flex-1 p-6 bg-gray-100 overflow-hidden relative flex flex-col">
                            <div className="flex-1 bg-white shadow-lg rounded-xl border border-gray-200 overflow-hidden relative">
                              <SignatureCanvas 
                                {...SIGNATURE_PEN}
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
                      </Dialog>
                    )}
                  </AnimatePresence>

                  {/* Signature print size sliders — solo para firmas anteriores a la normalización */}
                  {!hasLegacySignature ? (
                    <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                      Las firmas se normalizan automáticamente: se toma solo el trazo, se ajusta a un tamaño uniforme y se apoya sobre la línea de firma del documento.
                    </p>
                  ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
                    <p className="text-sm font-semibold text-amber-800">Tamaño de firma en impresión (firmas anteriores)</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <span className="text-xs text-amber-700 font-medium mb-1 block">Firma del Paciente</span>
                        <input type="range" min={80} max={300} step={4} value={patientSigSize}
                          onChange={e => handleSigSizeChange('patient_sig_size', Number(e.target.value))}
                          className="w-full h-2 rounded-full accent-[#deb887] cursor-pointer"
                        />
                        {currentConsent.signatures?.patient_sig_data && (
                          <div className="mt-2 flex justify-center border border-dashed border-amber-200 rounded-lg p-2 bg-white">
                            <img src={currentConsent.signatures.patient_sig_data} alt="preview"
                              style={sigHeight(currentConsent.signatures.patient_sig_data, patientSigSize)} className="object-contain" />
                          </div>
                        )}
                      </div>
                      <div>
                        <span className="text-xs text-amber-700 font-medium mb-1 block">Firma del Profesional</span>
                        <input type="range" min={80} max={300} step={4} value={profSigSize}
                          onChange={e => handleSigSizeChange('professional_sig_size', Number(e.target.value))}
                          className="w-full h-2 rounded-full accent-[#deb887] cursor-pointer"
                        />
                        {currentConsent.signatures?.professional_sig_data && (
                          <div className="mt-2 flex justify-center border border-dashed border-amber-200 rounded-lg p-2 bg-white">
                            <img src={currentConsent.signatures.professional_sig_data} alt="preview"
                              style={sigHeight(currentConsent.signatures.professional_sig_data, profSigSize)} className="object-contain" />
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-amber-600">{!currentConsent.id ? '⚠ Se guarda con el botón Guardar' : '✓ Se guarda automáticamente al mover el control'}</p>
                  </div>
                  )}

                  <div className="flex justify-end pt-6 border-t border-gray-100">
                    <div className="flex items-center gap-4 bg-gray-50 p-3 rounded-xl border border-gray-200">
                      <label className="block text-sm font-bold text-gray-700">Estado del Documento:</label>
                      <select
                        value={currentConsent.status}
                        onChange={(e) => updateField('status', e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none bg-white"
                      >
                        <option value="draft">Borrador</option>
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
        {isPaperConsent && (
          <div className="no-print p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
            Formato para firma manuscrita. Imprima el documento; el paciente y el profesional completan las casillas y firman con esfero. Este borrador aún no queda registrado como firmado.
          </div>
        )}
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
          <button onClick={() => {
            if (isPaperConsent) setIsPaperConsent(false);
            setView(currentConsent && (isSignedConsent(currentConsent) || isAnnulledConsent(currentConsent)) ? 'list' : 'form');
          }} className="text-gray-500 hover:text-gray-700 transition-colors font-medium">
            &larr; {isPaperConsent ? 'Volver al borrador' : currentConsent && (isSignedConsent(currentConsent) || isAnnulledConsent(currentConsent)) ? 'Volver a Consentimientos' : 'Volver a Edición'}
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-6 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors shadow-lg font-medium"
          >
            <Printer size={18} />
            {isPaperConsent ? 'Imprimir formato sin firmas' : 'Imprimir'}
          </button>
        </div>

        <div id="printable-consent" className="bg-white p-6 md:p-8 max-w-4xl mx-auto shadow-xl print:shadow-none print:p-0 rounded-xl">
          {isAnnulledConsent(currentConsent) && (
            <div className="p-4 bg-red-50 border-2 border-red-700 text-red-900 text-sm print:break-inside-avoid">
              <strong>CONSENTIMIENTO ANULADO</strong>
              <p>Fecha: {currentConsent.annulled_at ? new Date(currentConsent.annulled_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }) : 'No registrada'} · Responsable: {currentConsent.annulled_by_name || 'No registrado'}</p>
              <p className="whitespace-pre-wrap">Motivo: {currentConsent.annulment_reason || 'No registrado'}</p>
            </div>
          )}
          <table className="w-full">
            <thead className="hidden print:table-header-group"><tr><td className="h-[1cm]"></td></tr></thead>
            <tfoot className="hidden print:table-footer-group"><tr><td className="h-[1cm]"></td></tr></tfoot>
            <tbody>
              <tr>
                <td className="print:px-[1.2cm] align-top">
                  {/* Header */}
                  <div className="flex flex-col md:flex-row justify-between items-start mb-8 border-b-2 border-[#deb887] pb-6 gap-4 md:gap-0">
                    <div className="flex items-start gap-5">
                      <img src={clinic.general.logo_url || '/images/logo/logo.png'} alt="Logo" className="h-24 w-auto object-contain flex-shrink-0" onError={e => (e.currentTarget.style.display = 'none')} />
                      <div>
                        {clinic.general.establishment_type && (
                          <p className="text-xs font-semibold text-[#deb887] uppercase tracking-widest mb-0.5">{clinic.general.establishment_type}</p>
                        )}
                        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">{clinicDisplayName.toUpperCase()}</h2>
                        {clinic.general.tagline && (
                          <p className="text-sm text-gray-500 mt-0.5">{clinic.general.tagline}</p>
                        )}
                        <div className="mt-1.5 text-xs text-gray-500 space-y-0.5">
                          {(clinic.general.address || clinic.general.city) && (
                            <p>{[clinic.general.address, clinic.general.city].filter(Boolean).join(' \u2014 ')}</p>
                          )}
                          {clinic.general.phone && <p>Tel: {clinic.general.phone}</p>}
                          {clinic.general.tax_id && <p>RUC/NIF: {clinic.general.tax_id}</p>}
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-sm text-gray-600 space-y-0.5 flex-shrink-0">
                      <p><strong>Fecha:</strong> {new Date().toLocaleDateString('es-EC')}</p>
                      <p><strong>Expediente:</strong> #{recordId}</p>
                      {(currentConsent?.signatures?.professional_name || professionalName) && (
                        <div className="mt-3 pt-3 border-t border-gray-200">
                          <p className="font-semibold text-gray-800">{(currentConsent?.signatures?.professional_name || professionalName).toUpperCase()}</p>
                          {user?.especialidad && <p className="text-xs text-[#deb887]">{user.especialidad}</p>}
                          {user?.profession && !user?.especialidad && <p className="text-xs text-gray-500">{user.profession}</p>}
                          {user?.cedula_profesional && <p className="text-xs text-gray-500">Céd. Prof.: {user.cedula_profesional}</p>}
                          {user?.matricula_senescyt && <p className="text-xs text-gray-500">Mat. SENESCYT: {user.matricula_senescyt}</p>}
                        </div>
                      )}
                    </div>
                  </div>

          {/* Patient Info */}
          <div className="bg-gray-50 p-3 rounded-lg mb-5 text-xs border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-2 border-b border-gray-200 pb-1.5 text-xs uppercase tracking-wide">Información del Paciente</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-8">
              <p><strong className="text-gray-700">Nombre:</strong> {patient?.first_name} {patient?.last_name}</p>
              <p><strong className="text-gray-700">{patient?.identification_type === 'ruc' ? 'RUC' : patient?.identification_type === 'cedula' ? 'Cédula' : 'Identificación'}:</strong> {patient?.identification_number || 'N/A'}</p>
              <p><strong className="text-gray-700">Edad:</strong> {patient?.birth_date ? calculateAge(patient.birth_date) : 'N/A'} años</p>
              <p><strong className="text-gray-700">Teléfono:</strong> {patient?.phone || 'N/A'}</p>
            </div>
          </div>

          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">CONSENTIMIENTO INFORMADO</h1>
            <h2 className="text-sm text-[#deb887] font-medium uppercase tracking-wide">{currentConsent.procedure_type}</h2>
          </div>

          <div className="space-y-5 text-gray-800 leading-snug text-xs">
            <section>
              <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">1. DESCRIPCIÓN DEL PROCEDIMIENTO</h3>
              <div className="bg-gray-50 p-3 rounded border border-gray-100">
                <p className="mb-1"><strong>Zona a tratar:</strong> {currentConsent.zone}</p>
                <p className="mb-1"><strong>Sesiones estimadas:</strong> {currentConsent.sessions}</p>
                <p className="whitespace-pre-wrap mt-1">{currentConsent.description}</p>
              </div>
            </section>

            {currentConsent.objectives?.length > 0 && (
              <section>
                <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">2. OBJETIVOS</h3>
                <ul className="list-disc pl-4 space-y-0.5 marker:text-[#deb887]">
                  {currentConsent.objectives.map((obj, i) => <li key={i}>{obj}</li>)}
                </ul>
              </section>
            )}

            <section>
              <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">3. RIESGOS Y BENEFICIOS</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-red-50 p-3 rounded border border-red-100">
                  <h4 className="font-bold mb-1.5 text-red-800 flex items-center gap-1.5 text-xs">
                    <AlertTriangle className="w-3.5 h-3.5" /> Riesgos
                  </h4>
                  <ul className="list-disc pl-4 space-y-0.5 marker:text-red-400">
                    {currentConsent.risks?.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
                <div className="bg-emerald-50 p-3 rounded border border-emerald-100">
                  <h4 className="font-bold mb-1.5 text-emerald-800 flex items-center gap-1.5 text-xs">
                    <CheckCircle className="w-3.5 h-3.5" /> Beneficios
                  </h4>
                  <ul className="list-disc pl-4 space-y-0.5 marker:text-emerald-400">
                    {currentConsent.benefits?.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">4. CUIDADOS</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-bold mb-1 text-gray-800 text-xs">Previos:</h4>
                  <ul className="list-disc pl-4 space-y-0.5 marker:text-[#deb887]">
                    {currentConsent.pre_care?.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold mb-1 text-gray-800 text-xs">Posteriores:</h4>
                  <ul className="list-disc pl-4 space-y-0.5 marker:text-[#deb887]">
                    {currentConsent.post_care?.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">5. ANTECEDENTES CRÍTICOS</h3>
              <div className="bg-gray-50 p-3 rounded border border-gray-100 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="mb-0.5"><strong className="text-gray-700">Alergias:</strong> {currentConsent.critical_antecedents?.allergies || 'Niega'}</p>
                  <p><strong className="text-gray-700">Medicación:</strong> {currentConsent.critical_antecedents?.medications || 'Niega'}</p>
                </div>
                <div>
                  <p className="mb-0.5"><strong className="text-gray-700">Embarazo/Lactancia:</strong> {currentConsent.critical_antecedents?.pregnancy ? 'Sí' : 'No'}</p>
                  <p><strong className="text-gray-700">Herpes Recurrente:</strong> {currentConsent.critical_antecedents?.herpes ? 'Sí' : 'No'}</p>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-bold border-b border-[#deb887] mb-2 text-sm text-gray-900 pb-1">6. DECLARACIONES Y AUTORIZACIONES</h3>
              <div className="bg-gray-50 p-4 rounded border border-gray-100">
                <ConsentDocumentSections
                  consent={currentConsent}
                  showClinicalDetails={false}
                  showAcceptanceState={!isPaperConsent}
                  blankAcceptanceState={isPaperConsent}
                />
              </div>
            </section>

            {isPaperConsent ? (
              <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-12 pt-6 page-break-inside-avoid">
                <div className="pt-16 text-center">
                  <div className="border-t border-gray-700 pt-2">
                    <p className="font-semibold text-gray-900">Firma manuscrita del paciente</p>
                    <p className="mt-1 text-xs text-gray-600">Nombre: {patient?.first_name} {patient?.last_name}</p>
                    <p className="text-xs text-gray-600">Cédula/RUC: {patient?.identification_number || '________________________'}</p>
                    <p className="mt-1 text-xs text-gray-600">Fecha: ____________________</p>
                  </div>
                </div>
                <div className="pt-16 text-center">
                  <div className="border-t border-gray-700 pt-2">
                    <p className="font-semibold text-gray-900">Firma manuscrita del profesional</p>
                    <p className="mt-1 text-xs text-gray-600">Nombre: __________________________</p>
                    <p className="text-xs text-gray-600">Cédula profesional: __________________</p>
                    <p className="mt-1 text-xs text-gray-600">Fecha: ____________________</p>
                  </div>
                </div>
              </div>
            ) : <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-10 pt-5 page-break-inside-avoid">
              <div className="flex flex-col items-center">
                {currentConsent.signatures?.patient_sig_data && (
                  <img 
                    src={currentConsent.signatures.patient_sig_data} 
                    alt="Firma Paciente" 
                    style={sigHeight(currentConsent.signatures.patient_sig_data, patientSigSize)}
                    className="object-contain mb-2"
                  />
                )}
                <div className="w-full border-t border-gray-400 pt-2 text-center">
                  <p className="font-bold text-gray-900 text-sm">{currentConsent.signatures?.patient_name}</p>
                  <p className="text-xs text-gray-500 uppercase tracking-wider mt-0.5">Firma del Paciente</p>
                  {currentConsent.signatures?.patient_signed_at && <p className="text-xs text-gray-500 mt-1">Firmado: {new Date(currentConsent.signatures.patient_signed_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</p>}
                  {currentConsent.signatures?.signature_method === 'in_person_assisted' && <p className="text-xs text-gray-500">Firma presencial asistida por {currentConsent.signatures.witness_name || 'personal autorizado'}</p>}
                  {currentConsent.signing_hash && <p className="mt-1 text-[10px] text-gray-400 break-all">Huella SHA-256: {currentConsent.signing_hash}</p>}
                </div>
              </div>
              
              <div className="flex flex-col items-center">
                {currentConsent.signatures?.professional_sig_data && (
                  <img 
                    src={currentConsent.signatures.professional_sig_data} 
                    alt="Firma Profesional" 
                    style={sigHeight(currentConsent.signatures.professional_sig_data, profSigSize)}
                    className="object-contain mb-2"
                  />
                )}
                <div className="w-full border-t border-gray-400 pt-2 text-center">
                  <p className="font-bold text-gray-900">{professionalName || currentConsent.signatures?.professional_name}</p>
                  {user?.especialidad && <p className="text-xs text-[#deb887] mt-0.5">{user.especialidad}</p>}
                  {user?.cedula_profesional && <p className="text-xs text-gray-500">Céd. Prof.: {user.cedula_profesional}</p>}
                  <p className="text-sm text-gray-500 uppercase tracking-wider mt-1">Firma del Profesional</p>
                </div>
              </div>
            </div>}
            
            <div className="text-center text-xs text-gray-400 mt-12 border-t border-gray-100 pt-4 space-y-0.5">
              <p className="font-medium text-gray-500">{clinicDisplayName}{clinic.general.city ? ` — ${clinic.general.city}` : ''}{clinic.general.phone ? ` — Tel: ${clinic.general.phone}` : ''}</p>
              <p>Documento generado el {new Date().toLocaleDateString('es-EC')}</p>
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
      <AnimatePresence>
        {message && (
          <motion.div
            ref={messageRef}
            role={message.type === 'error' ? 'alert' : 'status'}
            aria-live={message.type === 'error' ? 'assertive' : 'polite'}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`mb-4 p-4 rounded-xl flex items-center gap-3 shadow-sm ${message.type === 'success'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
              : 'bg-red-50 text-red-700 border border-red-100'}`}
          >
            <div className={`p-1.5 rounded-full ${message.type === 'success' ? 'bg-emerald-100' : 'bg-red-100'}`}>
              {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            </div>
            <span className="font-medium text-sm">{message.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
      {view === 'list' && renderList()}
      {view === 'form' && renderForm()}
      {view === 'preview' && renderPreview()}
      {annulTarget && (
        <Dialog open onClose={() => setAnnulTarget(null)} labelledBy="annul-consent-title" describedBy="annul-consent-description" className="no-print">
          <section className="w-[min(32rem,calc(100vw-2rem))] space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h2 id="annul-consent-title" className="text-lg font-bold text-gray-900">Anular consentimiento #{annulTarget.id}</h2>
            <p id="annul-consent-description" className="text-sm text-gray-700">La anulación conserva las firmas y la evidencia original. El documento dejará de estar vigente; no podrá volver a editarse ni firmarse.</p>
            <label className="block text-sm font-medium text-gray-800" htmlFor="annul-consent-reason">Motivo de anulación (obligatorio)</label>
            <textarea id="annul-consent-reason" value={annulReason} onChange={event => setAnnulReason(event.target.value)} maxLength={500} rows={3} className="w-full border border-gray-300 rounded-md p-2 text-sm" placeholder="Describa el motivo de anulación" />
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" checked={createReplacementOnAnnul} onChange={event => setCreateReplacementOnAnnul(event.target.checked)} className="mt-1" />
              Crear un borrador de reemplazo vinculado, sin firmas ni autorizaciones previas
            </label>
            <div className="flex justify-end gap-3">
              <button type="button" disabled={annulling} onClick={() => setAnnulTarget(null)} className="px-4 py-2 border border-gray-300 rounded-md">Volver</button>
              <button type="button" disabled={annulling || annulReason.trim().length < 8} onClick={handleAnnul} className="px-4 py-2 bg-red-700 text-white rounded-md disabled:opacity-50">{annulling ? 'Anulando...' : 'Confirmar anulación'}</button>
            </div>
          </section>
        </Dialog>
      )}
      <CrossConsultHistoryModal
        isOpen={crossHistOpen}
        onClose={() => setCrossHistOpen(false)}
        tabLabel="Consentimientos"
        consultations={consultations}
        items={consents}
        currentConsultationId={consultationId}
        renderItem={c => (
          <div>
            <p className="font-medium text-gray-800">{c.procedure_type || c.form_type || 'Consentimiento'}</p>
            <p className="text-gray-400">{c.zone ? `${c.zone} — ` : ''}{c.status === 'signed' ? 'Firmado' : c.status === 'annulled' ? 'Anulado' : 'Borrador'}{c.created_at ? ` — ${new Date(c.created_at).toLocaleDateString('es-EC')}` : ''}</p>
          </div>
        )}
        renderDetail={c => (
          <>
            {c.procedure_type && <div><span className="text-gray-400">Procedimiento:</span> <span className="font-medium">{c.procedure_type}</span></div>}
            {c.zone && <div><span className="text-gray-400">Zona:</span> {c.zone}</div>}
            {c.sessions > 0 && <div><span className="text-gray-400">Sesiones:</span> {c.sessions}</div>}
            <div><span className="text-gray-400">Estado:</span> {c.status === 'signed' ? 'Finalizado' : c.status === 'annulled' ? 'Anulado' : 'Borrador'}</div>
            {c.created_at && <div><span className="text-gray-400">Fecha:</span> {new Date(c.created_at).toLocaleDateString('es-EC')}</div>}
          </>
        )}
      />
    </div>
  );
}
