import { useEffect, useRef, useState } from 'react';
import { FileText, Printer } from 'lucide-react';
import { LEGAL_VERSION } from '../legal/LegalLayout';
import PrivacyPolicy from '../../pages/PrivacyPolicy';
import TermsOfService, { PAID_PHOTO_BACKUP_POLICY_VERSION, PaidPhotoBackupPolicyBody } from '../../pages/TermsOfService';

const PLATFORM_PRICE = 245;
const WHATSAPP_PRICE = 100;
const PAYPHONE_SURCHARGE = 14.95;

export const CONTRACT_SUGGESTIONS = {
  supportTerms: 'Soporte de lunes a viernes, 09:00–18:00 (UTC−5), excepto feriados aplicables al Proveedor. Primera respuesta humana: P1 hasta 4 horas hábiles, P2 hasta 8 horas hábiles y P3 hasta 2 días hábiles. Objetivos de restablecimiento o alternativa: P1 1 día hábil y P2 3 días hábiles, con actualización de diagnóstico y nueva estimación si fuera necesario. Los reportes se registran por correo oficial y pueden escalarse por WhatsApp oficial.',
  refundTerms: 'Si el Proveedor termina anticipadamente el servicio por decisión no imputable al Cliente, retira una función principal sin reemplazo equivalente o no subsana un incumplimiento esencial que impida utilizarlo dentro del plazo razonable comunicado por escrito, el Cliente podrá terminar el contrato. Se devolverá la parte de la suscripción anual pagada correspondiente a los días no prestados, conforme al Art. 4 de las Condiciones de Servicio, sin limitar derechos imperativos.',
  aiInstructionTerms: 'Las funciones de inteligencia artificial permanecerán desactivadas para esta clínica. Cualquier habilitación posterior requerirá autorización expresa, documentada y específica del Cliente, identificando función, finalidad, proveedor y datos autorizados. La firma del contrato no constituye esa autorización ni habilita funciones de IA.',
  activationTerms: 'Una vez recibido el contrato aceptado, confirmado el pago y completados los datos de la cuenta, el Proveedor activará el acceso en hasta 1 día hábil. En hasta 3 días hábiles desde la activación enviará una propuesta de reunión de inicio o capacitación sobre los módulos contratados. La fecha de la reunión se acordará entre las partes; las credenciales son personales y no deben compartirse.',
} satisfies Pick<ContractOptions, 'supportTerms' | 'refundTerms' | 'aiInstructionTerms' | 'activationTerms'>;

type PartyType = 'natural' | 'juridica';
type Jurisdiction = 'Cuenca' | 'Quito';
type DocumentMode = 'new-contract' | 'addendum';

interface ClientFormState {
  partyType: PartyType;
  contractReference: string;
  baseContractDate: string;
  name: string;
  taxId: string;
  address: string;
  representative: string;
  representativeId: string;
  representativeRole: string;
  email: string;
  phone: string;
  clinicName: string;
  startDate: string;
  paymentMethod: string;
  otherPaymentMethod: string;
  cardCommission: string;
}

interface ContractOptions {
  jurisdiction: Jurisdiction;
  support: boolean;
  supportTerms: string;
  refund: boolean;
  refundTerms: string;
  incidentNotice: boolean;
  aiInstructions: boolean;
  aiInstructionTerms: string;
  activation: boolean;
  activationTerms: string;
  paidPhotoBackupPolicy: boolean;
}

interface ContractPrices {
  platform: string;
  chatbot: string;
}

const MODULES = [
  { id: 'clinical-records', name: 'Fichas Clínicas', detail: 'Pacientes, antecedentes y tratamientos.' },
  { id: 'inventory', name: 'Inventario', detail: 'Control de stock, lotes y vencimientos.' },
  { id: 'finance', name: 'Finanzas', detail: 'Gestión de ingresos y egresos.' },
  { id: 'system-status', name: 'Estado del Sistema', detail: 'Consulta de suscripción, correo y conectividad.' },
  { id: 'appointments', name: 'Agendamiento', detail: 'Citas, calendario, bloqueos y reservas.' },
  { id: 'database', name: 'Base de Datos', detail: 'Estadísticas, respaldos y exportaciones.' },
  { id: 'clinical-3d', name: 'Mapeo clínico 3D', detail: 'Visor interactivo para registrar marcaciones de examen físico y tratamientos inyectables.' },
  { id: 'dermoatlas', name: 'DermoAtlas 3D', detail: 'Explorador educativo interactivo de anatomía y capas de la piel.' },
] as const;

const initialClient: ClientFormState = {
  partyType: 'natural',
  contractReference: '',
  baseContractDate: '',
  name: '',
  taxId: '',
  address: '',
  representative: '',
  representativeId: '',
  representativeRole: '',
  email: '',
  phone: '',
  clinicName: '',
  startDate: '',
  paymentMethod: '',
  otherPaymentMethod: '',
  cardCommission: '',
};

function parseDateInput(startDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
    ? date
    : null;
}

function annualEndDate(startDate: string): Date | null {
  const start = parseDateInput(startDate);
  if (!start) return null;

  start.setFullYear(start.getFullYear() + 1);
  start.setDate(start.getDate() - 1);
  return start;
}

function formatDate(date: Date | null): string {
  return date ? new Intl.DateTimeFormat('es-EC', { dateStyle: 'long' }).format(date) : 'Pendiente';
}

function formatUsd(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value)
    : '—';
}

export default function ContractGenerator() {
  const formRef = useRef<HTMLFormElement>(null);
  const [client, setClient] = useState(initialClient);
  const [documentMode, setDocumentMode] = useState<DocumentMode>('new-contract');
  const [chatbot, setChatbot] = useState(false);
  const [options, setOptions] = useState<ContractOptions>({
    jurisdiction: 'Cuenca',
    support: false,
    supportTerms: CONTRACT_SUGGESTIONS.supportTerms,
    refund: false,
    refundTerms: CONTRACT_SUGGESTIONS.refundTerms,
    incidentNotice: false,
    aiInstructions: false,
    aiInstructionTerms: CONTRACT_SUGGESTIONS.aiInstructionTerms,
    activation: false,
    activationTerms: CONTRACT_SUGGESTIONS.activationTerms,
    paidPhotoBackupPolicy: false,
  });
  const [prices, setPrices] = useState<ContractPrices>({
    platform: String(PLATFORM_PRICE),
    chatbot: String(WHATSAPP_PRICE),
  });
  const [selectedModules, setSelectedModules] = useState<string[]>(MODULES.map(module => module.id));
  const [moduleError, setModuleError] = useState('');
  const [printError, setPrintError] = useState('');

  const updateClient = (field: keyof ClientFormState, value: string) => {
    setClient(current => ({ ...current, [field]: value }));
  };

  const updateOption = <K extends keyof ContractOptions>(field: K, value: ContractOptions[K]) => {
    setOptions(current => ({ ...current, [field]: value }));
  };

  const updatePrice = (field: keyof ContractPrices, value: string) => {
    setPrices(current => ({ ...current, [field]: value }));
  };

  const toggleModule = (id: string) => {
    setModuleError('');
    setSelectedModules(current => current.includes(id)
      ? current.filter(module => module !== id)
      : [...current, id]);
  };

  const endDate = annualEndDate(client.startDate);
  const startDate = parseDateInput(client.startDate);
  const platformPrice = Number(prices.platform);
  const chatbotPrice = Number(prices.chatbot);
  const commission = client.paymentMethod === 'Tarjeta' && client.cardCommission !== ''
    ? Number(client.cardCommission)
    : 0;
  const total = platformPrice + (chatbot ? chatbotPrice : 0) + commission;
  const includedModules = MODULES.filter(module => selectedModules.includes(module.id));
  const naturalPerson = client.partyType === 'natural';
  const signatory = naturalPerson ? client.name : client.representative;
  const signatoryId = naturalPerson ? client.taxId : client.representativeId;
  const signatoryRole = naturalPerson ? 'Persona natural, por sus propios derechos' : client.representativeRole;
  const hasAnnex = options.jurisdiction === 'Quito'
    || options.support
    || options.refund
    || options.incidentNotice
    || options.aiInstructions
    || options.activation;

  useEffect(() => {
    const clearPrintMode = () => document.body.classList.remove('master-contract-printing');
    window.addEventListener('afterprint', clearPrintMode);
    return () => {
      window.removeEventListener('afterprint', clearPrintMode);
      clearPrintMode();
    };
  }, []);

  const printContract = () => {
    setPrintError('');
    const form = formRef.current;
    if (!form) return;
    const requiredNames = ['contractReference', 'clientName', 'taxId', 'address', 'clinicName', 'email'];
    if (documentMode === 'addendum') requiredNames.push('baseContractDate');
    if (!naturalPerson) requiredNames.push('representative', 'representativeId', 'representativeRole');
    if (options.support) requiredNames.push('supportTerms');
    if (options.refund) requiredNames.push('refundTerms');
    if (options.aiInstructions) requiredNames.push('aiInstructionTerms');
    if (options.activation) requiredNames.push('activationTerms');
    const requiredFields = requiredNames
      .map(name => form.elements.namedItem(name))
      .filter((field): field is HTMLInputElement | HTMLTextAreaElement =>
        field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
    requiredFields.forEach(field => field.setCustomValidity(''));
    const dateInput = form.querySelector<HTMLInputElement>('input[name="startDate"]');
    dateInput?.setCustomValidity('');
    const existingContractDate = form.querySelector<HTMLInputElement>('input[name="baseContractDate"]');
    existingContractDate?.setCustomValidity('');
    const emptyField = requiredFields.find(field => !field.value.trim());
    emptyField?.setCustomValidity('Complete este dato antes de imprimir el contrato.');
    if (documentMode === 'new-contract' && !startDate) dateInput?.setCustomValidity('Ingrese una fecha de inicio válida.');
    if (!options.paidPhotoBackupPolicy) {
      setPrintError(documentMode === 'addendum'
        ? 'Seleccione e incorpore expresamente la versión del anexo que se firmará.'
        : 'Para un contrato nuevo, incorpore y acepte expresamente el anexo contractual vigente.');
      return;
    }
    if (!form.reportValidity()) return;
    if (documentMode === 'new-contract' && !includedModules.length) {
      setModuleError('Seleccione al menos un módulo antes de generar el contrato.');
      return;
    }
    const validPositiveAmount = (value: number) => Number.isFinite(value) && value > 0;
    if (documentMode === 'new-contract' && (!validPositiveAmount(platformPrice)
      || (chatbot && !validPositiveAmount(chatbotPrice))
      || !Number.isFinite(commission)
      || commission < 0
      || !Number.isFinite(total))) {
      setPrintError('Revise los importes: deben ser números finitos y los precios contratados mayores que cero.');
      return;
    }
    if (documentMode === 'new-contract' && (!startDate || !endDate)) return;
    document.body.classList.add('master-contract-printing');
    try {
      window.print();
    } catch (error) {
      document.body.classList.remove('master-contract-printing');
      setPrintError(error instanceof Error ? `No se pudo abrir la impresión: ${error.message}` : 'No se pudo abrir la impresión.');
    }
  };

  return (
    <section className="master-contract-page space-y-6">
      <style>{`
        @media print {
          @page { size: A4; margin: 16mm; }
          body.master-contract-printing * { visibility: hidden !important; }
          body.master-contract-printing .master-contract-preview,
          body.master-contract-printing .master-contract-preview * { visibility: visible !important; }
          body.master-contract-printing .master-contract-preview {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 100% !important;
            max-width: none !important;
            border: 0 !important;
            box-shadow: none !important;
            padding: 0 !important;
            margin: 0 !important;
            color: #111827 !important;
            background: white !important;
          }
          body.master-contract-printing .master-contract-preview * { color: #111827 !important; }
          body.master-contract-printing .contract-print-only { display: block !important; }
          body.master-contract-printing .contract-annex { break-before: page; }
          body.master-contract-printing .legal-print-copy { break-before: page; }
          body.master-contract-printing .legal-print-copy > .mt-6 { display: block !important; }
          body.master-contract-printing .legal-print-copy section {
            break-inside: auto;
            border-color: #d1d5db !important;
            box-shadow: none !important;
          }
          body.master-contract-printing .legal-print-copy section > div:first-child,
          body.master-contract-printing .legal-print-copy h2,
          body.master-contract-printing .legal-print-copy h3,
          body.master-contract-printing .master-contract-preview h3 { break-after: avoid; }
          body.master-contract-printing .legal-print-copy li,
          body.master-contract-printing .legal-print-copy tr,
          body.master-contract-printing .signature-block { break-inside: avoid; }
          body.master-contract-printing .contract-economic-section,
          body.master-contract-printing .contract-party-block,
          body.master-contract-printing .contract-signature-section { break-inside: avoid; }
          body.master-contract-printing .master-contract-preview table { font-size: 9pt !important; }
          body.master-contract-printing .master-contract-preview { overflow-wrap: anywhere; print-color-adjust: exact; }
        }
      `}</style>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900">
            <FileText aria-hidden="true" className="h-5 w-5 text-[#c5a075]" />
            Generador de contrato
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Complete los datos y revise las condiciones particulares antes de imprimir o guardar como PDF.
            Esta pantalla no guarda contratos ni crea un historial.
          </p>
        </div>
        <button
          type="button"
          onClick={printContract}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#a77d50] px-4 py-2 text-sm font-semibold text-white hover:bg-[#89633d] focus:outline-none focus:ring-2 focus:ring-[#a77d50] focus:ring-offset-2"
        >
          <Printer aria-hidden="true" className="h-4 w-4" />
          Imprimir / Guardar como PDF
        </button>
      </header>

      <form ref={formRef} onSubmit={event => event.preventDefault()} className="contract-editor grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.8fr)]">
        <div className="space-y-6">
          <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Documento que se preparará</legend>
            <label className="block text-sm font-medium text-gray-700">
              Tipo de documento
              <select name="documentMode" value={documentMode} onChange={event => setDocumentMode(event.target.value === 'addendum' ? 'addendum' : 'new-contract')} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal">
                <option value="new-contract">Contrato nuevo</option>
                <option value="addendum">Adenda a contrato vigente</option>
              </select>
            </label>
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              {documentMode === 'new-contract'
                ? 'El contrato nuevo incorpora la política prospectiva solo si se selecciona y firma expresamente como anexo separado.'
                : 'La adenda solo añade la política identificada que se seleccione y firmen ambas partes. No reabre, renueva ni reemplaza el contrato vigente ni obliga a otros clientes.'}
            </p>
          </fieldset>

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Datos del cliente y la clínica</legend>
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              Identifique a quien contrata y a la cuenta que usará el servicio. Si contrata una persona natural, puede repetir su nombre como persona que firma y escribir “por sus propios derechos” como calidad.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Tipo de contratante
                <select name="partyType" value={client.partyType} onChange={event => updateClient('partyType', event.target.value === 'juridica' ? 'juridica' : 'natural')} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal">
                  <option value="natural">Persona natural, por sus propios derechos</option>
                  <option value="juridica">Persona jurídica, mediante representante</option>
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                {documentMode === 'addendum' ? 'Referencia del contrato vigente' : 'Referencia de oferta o contrato'} <span aria-hidden="true">*</span>
                <input required name="contractReference" autoComplete="off" placeholder="Ej.: BIOSKIN-2026-001…" value={client.contractReference} onChange={event => updateClient('contractReference', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">{documentMode === 'addendum' ? 'Identificador exacto del contrato que ambas partes modificarán únicamente en el alcance expresado en la adenda.' : 'Identificador único de esta oferta para relacionar contrato, factura y comprobante de pago.'}</span>
              </label>
              {documentMode === 'addendum' && <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Fecha de firma del contrato vigente <span aria-hidden="true">*</span>
                <input required name="baseContractDate" type="date" value={client.baseContractDate} onChange={event => updateClient('baseContractDate', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>}
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Titular del contrato <span aria-hidden="true">*</span>
                <input required name="clientName" autoComplete="organization" value={client.name} onChange={event => updateClient('name', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Razón social de la empresa o nombres completos de la persona natural.</span>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Identificación del titular <span aria-hidden="true">*</span>
                <input required name="taxId" inputMode="numeric" pattern="(?:[0-9]{10}|[0-9]{13})" title="Ingrese una cédula de 10 dígitos o un RUC de 13 dígitos." value={client.taxId} onChange={event => updateClient('taxId', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">RUC de la empresa o cédula de la persona natural.</span>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Nombre de la clínica o cuenta <span aria-hidden="true">*</span>
                <input required name="clinicName" autoComplete="organization" value={client.clinicName} onChange={event => updateClient('clinicName', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Nombre que identifica la cuenta en BIOSKINTECH; puede coincidir con el titular.</span>
              </label>
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Domicilio del titular <span aria-hidden="true">*</span>
                <input required name="address" autoComplete="street-address" value={client.address} onChange={event => updateClient('address', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Dirección declarada para el contrato y las notificaciones formales.</span>
              </label>
              {!naturalPerson && <label className="text-sm font-medium text-gray-700">
                Persona que firma <span aria-hidden="true">*</span>
                <input required name="representative" autoComplete="name" value={client.representative} onChange={event => updateClient('representative', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Quien aceptará o firmará el contrato por el titular.</span>
              </label>}
              {!naturalPerson && <label className="text-sm font-medium text-gray-700">
                Calidad con la que firma <span aria-hidden="true">*</span>
                <input required name="representativeRole" placeholder="Ej.: representante legal…" value={client.representativeRole} onChange={event => updateClient('representativeRole', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Use “representante legal” para una empresa o “por sus propios derechos” para una persona natural.</span>
              </label>}
              {!naturalPerson && <label className="text-sm font-medium text-gray-700">
                Identificación de quien firma <span aria-hidden="true">*</span>
                <input required name="representativeId" inputMode="numeric" pattern="(?:[0-9]{10}|[0-9]{13})" title="Ingrese una cédula de 10 dígitos o un RUC de 13 dígitos." autoComplete="off" value={client.representativeId} onChange={event => updateClient('representativeId', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>}
              <label className="text-sm font-medium text-gray-700">
                Correo de contacto <span aria-hidden="true">*</span>
                <input required name="email" type="email" autoComplete="email" spellCheck={false} value={client.email} onChange={event => updateClient('email', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Teléfono (opcional)
                <input name="phone" type="tel" autoComplete="tel" value={client.phone} onChange={event => updateClient('phone', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>
            </div>
          </fieldset>

          {documentMode === 'new-contract' && <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Vigencia y pago</legend>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Fecha de inicio <span aria-hidden="true">*</span>
                <input required name="startDate" type="date" value={client.startDate} onChange={event => updateClient('startDate', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>
              <div className="text-sm text-gray-700">
                Vigencia
                <p className="mt-1 min-h-11 rounded-lg bg-gray-50 px-3 py-3 text-gray-800" aria-live="polite">
                  {startDate && endDate ? `${formatDate(startDate)} al ${formatDate(endDate)} (1 año)` : 'Se calcula al ingresar la fecha de inicio'}
                </p>
              </div>
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Método de pago <span aria-hidden="true">*</span>
                <select required value={client.paymentMethod} onChange={event => {
                  updateClient('paymentMethod', event.target.value);
                  updateClient('cardCommission', event.target.value === 'Tarjeta' ? String(PAYPHONE_SURCHARGE) : '');
                  if (event.target.value !== 'Otro') updateClient('otherPaymentMethod', '');
                }} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30">
                  <option value="">Seleccione el método de pago</option>
                  <option>Tarjeta</option>
                  <option>Transferencia</option>
                  <option>Efectivo</option>
                  <option>Otro</option>
                </select>
              </label>
              {client.paymentMethod === 'Otro' && (
                <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                  Especifique el método de pago <span aria-hidden="true">*</span>
                  <input required value={client.otherPaymentMethod} onChange={event => updateClient('otherPaymentMethod', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                </label>
              )}
              {client.paymentMethod === 'Tarjeta' && (
                <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                  Recargo de pasarela PayPhone (USD) <span aria-hidden="true">*</span>
                  <input required name="cardCommission" type="number" min="0" step="0.01" inputMode="decimal" value={client.cardCommission} onChange={event => updateClient('cardCommission', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                  <span className="mt-1 block text-xs font-normal text-gray-600">El recargo inicial de USD 14,95 se calculó para cobrar USD 245 con tarjeta. Confirme el importe con PayPhone para cada precio acordado.</span>
                </label>
              )}
            </div>
          </fieldset>}

          {documentMode === 'new-contract' && <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Módulos incluidos</legend>
            <p className="mb-4 mt-2 text-xs text-gray-600">Marque al menos un módulo contratado. Configure los precios anuales según el plan y la oferta aceptada.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {MODULES.map(module => (
                <label key={module.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50">
                  <input type="checkbox" checked={selectedModules.includes(module.id)} onChange={() => toggleModule(module.id)} className="mt-1 h-4 w-4 accent-[#a77d50] focus:ring-[#a77d50]" />
                  <span>
                    <span className="block text-sm font-semibold text-gray-800">{module.name}</span>
                    <span className="mt-0.5 block text-xs text-gray-600">{module.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            {moduleError && <p className="mt-3 text-sm text-red-600" role="alert">{moduleError}</p>}
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-[#c5a075]/50 bg-[#deb887]/10 p-4">
              <input type="checkbox" checked={chatbot} onChange={event => setChatbot(event.target.checked)} className="mt-1 h-4 w-4 accent-[#a77d50] focus:ring-[#a77d50]" />
              <span>
                <span className="block text-sm font-semibold text-gray-800">Chatbot WhatsApp del sistema (opcional)</span>
                <span className="mt-0.5 block text-xs text-gray-700">Solo se incluye si se selecciona. Precio anual configurable.</span>
              </span>
            </label>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Precio anual de plataforma (USD) <span aria-hidden="true">*</span>
                <input required name="platformPrice" type="number" min="0.01" step="0.01" inputMode="decimal" value={prices.platform} onChange={event => updatePrice('platform', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Valor inicial: USD 245, IVA incluido.</span>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Precio anual del chatbot (USD) <span aria-hidden="true">*</span>
                <input required={chatbot} disabled={!chatbot} name="chatbotPrice" type="number" min="0.01" step="0.01" inputMode="decimal" value={prices.chatbot} onChange={event => updatePrice('chatbot', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30 disabled:cursor-not-allowed disabled:bg-gray-100" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Valor inicial opcional: USD 100, IVA incluido.</span>
              </label>
            </div>
          </fieldset>}

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Complementos particulares (independientes y opcionales)</legend>
            <p className="mb-4 text-xs text-gray-600">Las condiciones comunes de soporte, devolución, aviso de incidentes en 24 horas y autorización de IA se mantienen aunque no seleccione complementos. Los textos particulares no eliminan esas garantías.</p>
            <p className="mb-4 text-xs text-gray-600">Al marcar una opción aparece un texto sugerido basado en las condiciones generales. Puede editarlo antes de firmar; solo las opciones marcadas se imprimen en el Anexo B. Los datos del cliente, módulos y precio se configuran en las secciones anteriores.</p>
            <div className="space-y-4">
              <label className="block text-sm font-medium text-gray-700">
                Jurisdicción
                <select name="jurisdiction" value={options.jurisdiction} onChange={event => updateOption('jurisdiction', event.target.value === 'Quito' ? 'Quito' : 'Cuenca')} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
                  <option>Cuenca</option>
                  <option>Quito</option>
                </select>
              </label>
              {([
                ['support', 'Pactar soporte particular'],
                ['refund', 'Pactar devolución particular'],
                ['incidentNotice', 'Reiterar en el anexo el aviso común de incidentes en máximo 24 horas'],
                ['aiInstructions', 'Registrar instrucciones particulares de IA'],
                ['activation', 'Pactar activación particular'],
              ] as const).map(([field, label]) => (
                <label key={field} className="flex items-start gap-3 text-sm text-gray-700">
                  <input type="checkbox" name={field} checked={options[field]} onChange={event => updateOption(field, event.target.checked)} className="mt-1 h-4 w-4 accent-[#a77d50]" />
                  <span>{label}</span>
                </label>
              ))}
              {([
                ['support', 'supportTerms', 'Texto acordado de soporte'],
                ['refund', 'refundTerms', 'Texto acordado de devolución'],
                ['aiInstructions', 'aiInstructionTerms', 'Instrucciones de IA acordadas'],
                ['activation', 'activationTerms', 'Texto acordado de activación'],
              ] as const).map(([enabled, field, label]) => options[enabled] ? (
                <div key={field}>
                  <label className="block text-sm font-medium text-gray-700">
                    {label} <span aria-hidden="true">*</span>
                    <textarea required name={field} rows={5} value={options[field]} onChange={event => updateOption(field, event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                  </label>
                  <button type="button" onClick={() => updateOption(field, CONTRACT_SUGGESTIONS[field])} className="mt-1 min-h-11 text-xs font-medium text-gray-700 underline focus:outline-none focus:ring-2 focus:ring-gold">
                    Restablecer sugerencia de {label.toLowerCase()}
                  </button>
                </div>
              ) : null)}
              <p className="rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-900">Todos los contratos incluyen una entrega anual gratuita bajo solicitud de fotografías y documentos clínicos. Se solicita desde Base de Datos; si el canal del panel no está disponible, BIOSKINTECH la coordina por los canales oficiales. Retención posterior: 30 días. No es una réplica fotográfica automática diaria.</p>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
                <input type="checkbox" name="paidPhotoBackupPolicy" checked={options.paidPhotoBackupPolicy} onChange={event => updateOption('paidPhotoBackupPolicy', event.target.checked)} className="mt-1 h-4 w-4 accent-[#a77d50] focus:ring-[#a77d50]" />
                <span>
                  <span className="block font-semibold">Incorporar y aceptar el anexo {PAID_PHOTO_BACKUP_POLICY_VERSION}</span>
                  <span className="mt-1 block text-xs leading-relaxed">Para emitir el documento debe marcar esta casilla y firmar el anexo. Añade 15 días de acceso normal y 30 días de recuperación restringida después del vencimiento. Los contratos existentes solo lo incorporan mediante adenda firmada.</span>
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        <aside className="contract-editor h-fit rounded-2xl border border-gray-200 bg-white p-5 shadow-sm xl:sticky xl:top-5">
          {documentMode === 'addendum' ? (
            <>
              <h3 className="text-sm font-semibold text-gray-900">Adenda limitada</h3>
              <p className="mt-3 text-sm leading-relaxed text-gray-700">La adenda impresa solo incorpora la versión seleccionada y el contrato vigente que se identifique. No cambia el precio ni las demás cláusulas.</p>
            </>
          ) : <>
          <h3 className="text-sm font-semibold text-gray-900">Resumen económico</h3>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-gray-600">Plataforma (anual, IVA incluido)</dt><dd className="font-medium text-gray-900">{formatUsd(platformPrice)}</dd></div>
            {chatbot && <div className="flex justify-between gap-3"><dt className="text-gray-600">Chatbot WhatsApp (anual, IVA incluido)</dt><dd className="font-medium text-gray-900">{formatUsd(chatbotPrice)}</dd></div>}
            {client.paymentMethod === 'Tarjeta' && <div className="flex justify-between gap-3"><dt className="text-gray-600">Recargo de pasarela PayPhone</dt><dd className="font-medium text-gray-900">{formatUsd(commission)}</dd></div>}
            <div className="flex justify-between gap-3 border-t border-gray-200 pt-3 text-base"><dt className="font-semibold text-gray-900">Total anual</dt><dd className="font-bold text-gray-900">{formatUsd(total)}</dd></div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-gray-600">El precio de la plataforma y el recargo de PayPhone deben coincidir con la oferta y el importe confirmado por la pasarela.</p>
          </>}
          {printError && <p className="mt-3 text-sm text-red-600" role="alert">{printError}</p>}
          <button type="button" onClick={printContract} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#a77d50] px-4 py-2 text-sm font-semibold text-white hover:bg-[#89633d] focus:outline-none focus:ring-2 focus:ring-[#a77d50] focus:ring-offset-2">
            <Printer aria-hidden="true" className="h-4 w-4" /> Imprimir / Guardar como PDF
          </button>
        </aside>
      </form>

      <article className="master-contract-preview mx-auto max-w-4xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
        {documentMode === 'new-contract' ? <>
        <div className="border-b border-gray-200 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">BIOSKINTECH · Condiciones particulares</p>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">Contrato anual de acceso a la plataforma</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">El presente contrato contiene las condiciones particulares del servicio, el Anexo A de Tratamiento de Datos{hasAnnex ? ' y el Anexo B de Condiciones Particulares Seleccionadas' : ''}{options.paidPhotoBackupPolicy ? ` y el Anexo C ${PAID_PHOTO_BACKUP_POLICY_VERSION}` : ''} y las copias íntegras de las Condiciones de Servicio y la Política de Privacidad versión {LEGAL_VERSION}, que forman parte inseparable del acuerdo.</p>
          <p className="mt-2 text-xs font-medium text-gray-700">Referencia: {client.contractReference || '—'} · Domicilio del Proveedor: Cuenca, Ecuador</p>
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">1. Partes y cuenta</h3>
          <div className="mt-3 grid gap-5 text-sm sm:grid-cols-2 sm:divide-x sm:divide-gray-200">
            <div className="contract-party-block">
              <h4 className="border-b border-gray-200 pb-2 font-bold text-gray-900">A. Proveedor</h4>
              <dl className="mt-3 space-y-3">
                <div><dt className="text-gray-500">Nombre</dt><dd className="font-medium text-gray-900">Rafael Israel Larrea Galindo</dd></div>
                <div><dt className="text-gray-500">RUC</dt><dd className="font-medium text-gray-900">0105872600001</dd></div>
                <div><dt className="text-gray-500">Domicilio contractual</dt><dd className="font-medium text-gray-900">Cuenca, Ecuador</dd></div>
                <div><dt className="text-gray-500">Calidad</dt><dd className="font-medium text-gray-900">Persona natural, por sus propios derechos</dd></div>
              </dl>
            </div>
            <div className="contract-party-block sm:pl-5">
              <h4 className="border-b border-gray-200 pb-2 font-bold text-gray-900">B. Cliente y cuenta contratada</h4>
              <dl className="mt-3 space-y-3">
                <div><dt className="text-gray-500">Titular del contrato</dt><dd className="font-medium text-gray-900">{client.name || '—'}</dd></div>
                <div><dt className="text-gray-500">RUC o cédula del titular</dt><dd className="font-medium text-gray-900">{client.taxId || '—'}</dd></div>
                <div><dt className="text-gray-500">Domicilio contractual</dt><dd className="font-medium text-gray-900">{client.address || '—'}</dd></div>
                <div><dt className="text-gray-500">Cuenta habilitada en BIOSKINTECH</dt><dd className="font-medium text-gray-900">{client.clinicName || '—'}</dd></div>
                <div><dt className="text-gray-500">Firmante</dt><dd className="font-medium text-gray-900">{signatory || '—'}</dd></div>
                <div><dt className="text-gray-500">Identificación del firmante</dt><dd className="font-medium text-gray-900">{signatoryId || '—'}</dd></div>
                <div><dt className="text-gray-500">Calidad del firmante</dt><dd className="font-medium text-gray-900">{signatoryRole || '—'}</dd></div>
                <div><dt className="text-gray-500">Contacto</dt><dd className="font-medium text-gray-900">{client.email || '—'}{client.phone ? ` · ${client.phone}` : ''}</dd></div>
              </dl>
            </div>
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">2. Servicio y módulos seleccionados</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Acceso anual a BIOSKINTECH para la clínica o cuenta indicada, con los siguientes módulos descritos para identificar el alcance contratado:</p>
          {includedModules.length ? (
            <ul className="mt-3 space-y-2">
              {includedModules.map(module => <li key={module.id} className="text-sm"><span className="font-semibold text-gray-900">{module.name}:</span> <span className="text-gray-700">{module.detail}</span></li>)}
            </ul>
          ) : <p className="mt-3 text-sm text-gray-700">No se seleccionaron módulos individuales.</p>}
          {chatbot && <p className="mt-3 text-sm text-gray-700"><span className="font-semibold text-gray-900">Chatbot WhatsApp del sistema:</span> servicio opcional contratado durante esta vigencia anual.</p>}
          {!chatbot && <p className="mt-3 text-sm text-gray-700"><strong>Excluido:</strong> chatbot WhatsApp del sistema; no se cobra ese adicional. Las comunicaciones opcionales no se habilitan por la mera firma de este contrato.</p>}
        </section>

        <section className="contract-economic-section mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">3. Precio, vigencia y pago</h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-700">Plataforma, anual, IVA incluido</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(platformPrice)}</dd></div>
            {chatbot && <div className="flex justify-between gap-4"><dt className="text-gray-700">Chatbot WhatsApp del sistema, adicional anual, IVA incluido</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(chatbotPrice)}</dd></div>}
            {client.paymentMethod === 'Tarjeta' && <div className="flex justify-between gap-4"><dt className="text-gray-700">Recargo de pasarela PayPhone</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(commission)}</dd></div>}
            <div className="flex justify-between gap-4 border-t border-gray-200 pt-2"><dt className="font-bold text-gray-900">Total anual</dt><dd className="shrink-0 font-bold text-gray-900">{formatUsd(total)}</dd></div>
          </dl>
          <p className="mt-3 text-sm text-gray-700"><strong>Inicio:</strong> {formatDate(startDate)} · <strong>Fin de vigencia:</strong> {formatDate(endDate)} · un año.</p>
          <p className="mt-2 text-sm text-gray-700"><strong>Método de pago registrado:</strong> {client.paymentMethod === 'Otro' ? client.otherPaymentMethod || 'Otro' : client.paymentMethod || '—'}</p>
          {client.paymentMethod === 'Tarjeta' && <p className="mt-2 text-xs leading-relaxed text-gray-600">El recargo indicado corresponde al uso de la pasarela PayPhone y no modifica el precio contractual de la plataforma.</p>}
        </section>

        <section className="mt-6 border-t border-gray-200 pt-5">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">4. Documentos integrantes y orden de prevalencia</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Forman un único acuerdo esta carátula y sus condiciones particulares, el Anexo A de Tratamiento de Datos{hasAnnex ? ' y el Anexo B de Condiciones Particulares Seleccionadas' : ''}{options.paidPhotoBackupPolicy ? ` y el Anexo C ${PAID_PHOTO_BACKUP_POLICY_VERSION}` : ''}, las Condiciones de Servicio y la Política de Privacidad versión {LEGAL_VERSION}, cuyas copias se adjuntan. Las condiciones particulares prevalecen para identidad, precio, módulos y vigencia; el Anexo A para el encargo de datos. El Anexo C prevalece únicamente en vencimiento, recuperación, entrega fotográfica y límites técnicos de exportación que regula. Los documentos generales rigen las materias restantes. Los complementos del Anexo B no eliminan las garantías comunes de soporte, devolución, aviso de incidentes ni autorización de IA. Siempre prevalece la ley imperativa.</p>
        </section>

        <section className="contract-signature-section mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">5. Licencia, naturaleza y renovación</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">El Proveedor concede al Cliente una licencia de acceso SaaS limitada, no exclusiva, no transferible y vigente únicamente durante el período contratado. No se vende ni transfiere el código fuente, la Plataforma, las marcas, los modelos 3D ni su propiedad intelectual. BIOSKINTECH es una herramienta de gestión, no presta servicios médicos ni sustituye el criterio profesional.</p>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Este contrato termina en la fecha indicada. No existe renovación automática: toda renovación requiere aceptación expresa del Cliente y del precio vigente. El Proveedor emitirá el comprobante tributario que corresponda al pago recibido.</p>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">6. Disponibilidad, soporte y responsabilidad</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Se mantienen las condiciones comunes de soporte y puesta en marcha, devolución proporcional, aviso de incidentes dentro de 24 horas desde su conocimiento y autorización expresa de IA descritas en los documentos adjuntos, sin necesidad de seleccionar complementos. No se pacta un porcentaje de disponibilidad distinto de lo descrito en esos documentos. Puede haber mantenimientos, fallas e indisponibilidad de terceros. Los respaldos reducen riesgos, pero no garantizan recuperación total; el Cliente debe conservar las copias exigidas por la normativa aplicable.</p>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">En la máxima medida permitida por la ley, se excluyen daños indirectos y lucro cesante. La responsabilidad contractual total del Proveedor frente al Cliente no excederá lo efectivamente pagado bajo este contrato durante los 12 meses anteriores al hecho, también para reclamaciones por divulgación no autorizada, vulneración de confidencialidad o protección de datos y pérdida de información imputables al Proveedor, cuando sea legalmente admisible. Ningún límite opera ante dolo, culpa grave o supuestos legalmente indisponibles, ni reduce obligaciones frente a Titulares o autoridades de protección de datos. Se mantienen las obligaciones de confidencialidad, prevención, contención, notificación y subsanación; el límite económico no autoriza divulgar información ni suprime esas obligaciones.</p>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">En ausencia de pacto particular seleccionado en el Anexo B, rige la ley ecuatoriana y serán competentes los jueces de Cuenca, Ecuador, sin alterar competencias legalmente obligatorias.</p>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">7. Aceptación y firma</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Las partes declaran haber verificado su identificación, facultades, alcance, importes y anexos antes de suscribir. El Cliente confirma haber recibido, leído y aceptado los documentos adjuntos versión {LEGAL_VERSION}{options.paidPhotoBackupPolicy ? ` y el Anexo C ${PAID_PHOTO_BACKUP_POLICY_VERSION}` : ''}. La firma manuscrita o electrónica válida de este paquete expresa la aceptación del acuerdo completo.</p>
          <div className="signature-block mt-12 grid gap-10 sm:grid-cols-2">
            <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del cliente · {signatory || 'Nombre'}</div>
            <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del proveedor · Rafael Israel Larrea Galindo</div>
          </div>
          <div className="signature-block mt-8 grid gap-6 text-xs text-gray-600 sm:grid-cols-2">
            <p>Fecha: ____________________<br />Lugar de firma: ____________________</p>
            <p>Fecha: ____________________<br />RUC: 0105872600001</p>
          </div>
        </section>

        {hasAnnex && <section className="contract-annex mt-10">
          <h2 className="text-2xl font-bold text-gray-900">Anexo B · Condiciones particulares seleccionadas</h2>
          <p className="mt-2 text-xs text-gray-600">Vinculado a {client.contractReference || 'la referencia pendiente'}. Solo se incorporan las opciones marcadas para este cliente. Estos complementos no eliminan las garantías comunes de soporte, devolución, aviso de incidentes ni autorización de IA.</p>
          <div className="mt-6 space-y-5 text-sm leading-relaxed text-gray-700">
            {options.support && <section><h3 className="font-bold text-gray-900">B.1. Soporte particular</h3><p className="mt-1 whitespace-pre-wrap">{options.supportTerms}</p></section>}
            {options.refund && <section><h3 className="font-bold text-gray-900">B.2. Devolución particular</h3><p className="mt-1 whitespace-pre-wrap">{options.refundTerms}</p></section>}
            {options.incidentNotice && <section><h3 className="font-bold text-gray-900">B.3. Aviso de incidentes</h3><p className="mt-1">El Proveedor comunicará al Cliente, sin dilación indebida y como máximo dentro de 24 horas corridas desde que tenga conocimiento, una vulneración que afecte sus datos. El aviso inicial incluirá la información disponible y se completará progresivamente. Este plazo no es un compromiso de detección en 24 horas ni de soporte continuo; no sustituye las notificaciones legales del Cliente como Responsable.</p></section>}
            {options.aiInstructions && <section><h3 className="font-bold text-gray-900">B.4. Instrucciones particulares de IA</h3><p className="mt-1 whitespace-pre-wrap">{options.aiInstructionTerms}</p><p className="mt-2">Estas instrucciones no habilitan por sí solas funciones de IA. El Proveedor mantendrá esas funciones desactivadas hasta recibir la autorización expresa correspondiente; el Cliente conservará la base jurídica y las autorizaciones necesarias respecto de los Titulares.</p></section>}
            {options.jurisdiction === 'Quito' && <section><h3 className="font-bold text-gray-900">B.5. Jurisdicción particular</h3><p className="mt-1">Solo para este contrato, se sustituye la ciudad de jurisdicción prevista en la cláusula 6 de la carátula por Quito, Ecuador. Rige la ley ecuatoriana y se respetan las competencias legalmente obligatorias.</p></section>}
            {options.activation && <section><h3 className="font-bold text-gray-900">B.6. Activación particular</h3><p className="mt-1 whitespace-pre-wrap">{options.activationTerms}</p></section>}
          </div>
        </section>}

        {options.paidPhotoBackupPolicy && <section className="contract-annex mt-10 rounded-xl border border-gray-300 p-5">
          <div className="border-b border-gray-300 pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">Anexo C · Política contractual independiente</p>
            <h2 className="mt-2 text-xl font-bold text-gray-900">Vencimiento, recuperación y entregas fotográficas</h2>
            <p className="mt-1 text-xs text-gray-600">Versión {PAID_PHOTO_BACKUP_POLICY_VERSION} · Contrato {client.contractReference || 'pendiente'}</p>
          </div>
          <div className="mt-5 text-sm leading-relaxed text-gray-700"><PaidPhotoBackupPolicyBody /></div>
        </section>}

        <section className="contract-annex mt-10">
          <div className="border-b border-gray-300 pb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">Anexo A · Encargo de tratamiento de datos personales</p>
            <h2 className="mt-2 text-2xl font-bold text-gray-900">Acuerdo entre Responsable y Encargado</h2>
            <p className="mt-1 text-xs text-gray-600">Vinculado a {client.contractReference || 'la referencia pendiente'} · Versión legal {LEGAL_VERSION}</p>
          </div>
          <div className="mt-6 space-y-5 text-sm leading-relaxed text-gray-700">
            <section><h3 className="font-bold text-gray-900">A.1. Partes, objeto y duración</h3><p className="mt-1">El Cliente actúa como Responsable del Tratamiento y encarga al Proveedor, como Encargado, alojar y operar los datos personales necesarios para prestar los módulos seleccionados. El encargo dura durante la vigencia y el período posterior de conservación descrito en la Política adjunta.</p></section>
            <section><h3 className="font-bold text-gray-900">A.2. Naturaleza, finalidad y personas afectadas</h3><p className="mt-1">El tratamiento comprende recogida a través de interfaces, registro, organización, consulta, transmisión técnica, almacenamiento, respaldo, exportación, rectificación y supresión para gestión clínica, agenda, consentimientos, inventario, finanzas, comunicaciones, seguridad y soporte. Puede afectar a pacientes, representantes, personas que reservan, personal y Usuarios del Cliente.</p></section>
            <section><h3 className="font-bold text-gray-900">A.3. Datos tratados</h3><p className="mt-1">Según los módulos usados: identificación y contacto; datos sensibles de salud, fotografías, antecedentes, diagnósticos, tratamientos, recetas y consentimientos; firma digitalizada y evidencia técnica; agenda y comunicaciones; datos económicos de la atención; credenciales protegidas, accesos, dispositivos y auditoría. El detalle vigente consta en el Art. 3 de la Política adjunta.</p></section>
            <section><h3 className="font-bold text-gray-900">A.4. Instrucciones y obligaciones</h3><p className="mt-1">El Proveedor tratará los datos solo para ejecutar este contrato, conforme a la configuración, acciones e instrucciones lícitas documentadas del Cliente; garantizará confidencialidad del personal autorizado; aplicará las medidas descritas en el Art. 10 de la Política; y avisará si una instrucción infringe manifiestamente la normativa. El Cliente determina y acredita finalidades y bases legales, informa a los Titulares, obtiene autorizaciones, configura permisos y cumple los deberes sanitarios y de conservación.</p></section>
            <section><h3 className="font-bold text-gray-900">A.5. Subencargados y transferencias</h3><p className="mt-1">El Cliente autoriza de forma general los proveedores identificados en el Art. 5 de la Política adjunta para las finalidades allí descritas. El Proveedor seguirá siendo responsable de sus obligaciones legales como Encargado, seleccionará proveedores con garantías apropiadas e informará cambios relevantes mediante una nueva versión. El Cliente podrá objetar justificadamente por riesgo de protección de datos; si no existe alternativa razonable, podrá terminar el servicio y exportar sus datos.</p></section>
            <section><h3 className="font-bold text-gray-900">A.6. Seguridad, derechos e incidentes</h3><p className="mt-1">El Proveedor asistirá razonablemente al Cliente para atender derechos, evaluaciones e incidentes según la información disponible. Comunicará al Cliente, sin dilación indebida y dentro de las primeras 24 horas naturales desde que tenga conocimiento de una violación que afecte sus datos, la naturaleza conocida, posibles consecuencias, medidas adoptadas y punto de contacto, completando la información progresivamente. El Cliente decide y realiza las notificaciones que le correspondan como Responsable.</p></section>
            <section><h3 className="font-bold text-gray-900">A.7. Evidencia y auditoría</h3><p className="mt-1">A solicitud razonable, el Proveedor facilitará información disponible para demostrar el cumplimiento de este encargo. Las auditorías deberán proteger la seguridad y confidencialidad de otros clientes, coordinarse con antelación y evitar interferencias desproporcionadas. No se concede acceso a secretos, credenciales ni datos de terceros.</p></section>
            <section><h3 className="font-bold text-gray-900">A.8. Devolución y supresión</h3><p className="mt-1">Durante la suscripción y los 30 días posteriores, el Cliente podrá exportar los formatos disponibles descritos en la Política. Cumplido ese plazo, el Proveedor eliminará o anonimizará los datos activos conforme a sus procedimientos técnicos y obligaciones legales; las copias residuales permanecerán aisladas del uso ordinario hasta vencer sus ciclos de retención. Las fotografías originales no forman parte de las copias automáticas de datos estructurados. La entrega anual autorizada de fotografías y documentos clínicos se rige por los documentos generales; no es una réplica fotográfica periódica. La cuota no consumida del período terminado puede solicitarse por los canales oficiales dentro de los 30 días posteriores, sin ampliar el acceso ordinario a la Plataforma.</p></section>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 contract-print-summary">
          <p><strong>Documentos adjuntos al imprimir:</strong> Condiciones de Servicio y Política de Privacidad y Tratamiento de Datos Personales, versión {LEGAL_VERSION}{options.paidPhotoBackupPolicy ? `; Anexo C ${PAID_PHOTO_BACKUP_POLICY_VERSION}` : ''}.</p>
        </section>
        <div className="contract-print-only hidden">
          <TermsOfService embedded />
          <PrivacyPolicy embedded />
        </div>
        </> : options.paidPhotoBackupPolicy ? (
          <div className="contract-annex">
            <div className="border-b border-gray-300 pb-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">BIOSKINTECH · Adenda de alcance limitado</p>
              <h2 className="mt-2 text-2xl font-bold text-gray-900">Adenda de vencimiento, recuperación y entregas fotográficas</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-700">Se incorpora únicamente la versión {PAID_PHOTO_BACKUP_POLICY_VERSION} al contrato identificado a continuación. Las demás cláusulas, precio, vigencia y derechos del contrato original permanecen sin modificación.</p>
            </div>
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-gray-500">Titular del contrato</dt><dd className="font-medium text-gray-900">{client.name || '—'}</dd></div>
              <div><dt className="text-gray-500">Identificación</dt><dd className="font-medium text-gray-900">{client.taxId || '—'}</dd></div>
              <div><dt className="text-gray-500">Clínica o cuenta</dt><dd className="font-medium text-gray-900">{client.clinicName || '—'}</dd></div>
              <div><dt className="text-gray-500">Correo de contacto</dt><dd className="font-medium text-gray-900">{client.email || '—'}</dd></div>
              <div><dt className="text-gray-500">Referencia del contrato original</dt><dd className="font-medium text-gray-900">{client.contractReference || '—'}</dd></div>
              <div><dt className="text-gray-500">Fecha del contrato original</dt><dd className="font-medium text-gray-900">{formatDate(parseDateInput(client.baseContractDate))}</dd></div>
            </dl>
            <section className="mt-6 rounded-xl border border-gray-300 p-5 text-sm leading-relaxed text-gray-700">
              <h3 className="mb-3 font-bold text-gray-900">Anexo aceptado · {PAID_PHOTO_BACKUP_POLICY_VERSION}</h3>
              <PaidPhotoBackupPolicyBody />
            </section>
            <p className="mt-5 text-sm leading-relaxed text-gray-700">El Cliente declara haber leído y aceptar expresamente el anexo identificado. Esta adenda solo modifica el contrato arriba identificado en la materia descrita; no implica aceptación por otros clientes ni altera contratos distintos.</p>
            <div className="signature-block mt-14 grid gap-10 sm:grid-cols-2">
              <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del cliente · {signatory || 'Nombre'}</div>
              <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del proveedor · Rafael Israel Larrea Galindo</div>
            </div>
            <div className="signature-block mt-8 grid gap-6 text-xs text-gray-600 sm:grid-cols-2">
              <p>Fecha de aceptación: ____________________<br />Lugar: ____________________</p>
              <p>Fecha de aceptación: ____________________<br />RUC: 0105872600001</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900" role="status">
            Para emitir una adenda, incorpore primero la versión contractual propuesta y revise su texto completo.
          </div>
        )}
      </article>
    </section>
  );
}
