import { useEffect, useRef, useState } from 'react';
import { FileText, Printer } from 'lucide-react';
import { LEGAL_VERSION } from '../legal/LegalLayout';
import PrivacyPolicy from '../../pages/PrivacyPolicy';
import TermsOfService from '../../pages/TermsOfService';

const PLATFORM_PRICE = 245;
const WHATSAPP_PRICE = 100;
const PAYPHONE_SURCHARGE = 14.95;

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

const initialClient = {
  contractReference: '',
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
  return new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value);
}

export default function ContractGenerator() {
  const formRef = useRef<HTMLFormElement>(null);
  const [client, setClient] = useState(initialClient);
  const [chatbot, setChatbot] = useState(false);
  const [selectedModules, setSelectedModules] = useState<string[]>(MODULES.map(module => module.id));
  const [moduleError, setModuleError] = useState('');

  const updateClient = (field: keyof typeof initialClient, value: string) => {
    setClient(current => ({ ...current, [field]: value }));
  };

  const toggleModule = (id: string) => {
    setModuleError('');
    setSelectedModules(current => current.includes(id)
      ? current.filter(module => module !== id)
      : [...current, id]);
  };

  const endDate = annualEndDate(client.startDate);
  const startDate = parseDateInput(client.startDate);
  const commission = client.paymentMethod === 'Tarjeta' && client.cardCommission !== ''
    ? Number(client.cardCommission)
    : 0;
  const total = PLATFORM_PRICE + (chatbot ? WHATSAPP_PRICE : 0) + commission;
  const includedModules = MODULES.filter(module => selectedModules.includes(module.id));

  useEffect(() => {
    const clearPrintMode = () => document.body.classList.remove('master-contract-printing');
    window.addEventListener('afterprint', clearPrintMode);
    return () => {
      window.removeEventListener('afterprint', clearPrintMode);
      clearPrintMode();
    };
  }, []);

  const printContract = () => {
    if (!formRef.current?.reportValidity()) return;
    if (!includedModules.length) {
      setModuleError('Seleccione al menos un módulo antes de generar el contrato.');
      return;
    }
    document.body.classList.add('master-contract-printing');
    try {
      window.print();
    } catch {
      document.body.classList.remove('master-contract-printing');
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
            <legend className="px-1 text-sm font-semibold text-gray-900">Datos del cliente y la clínica</legend>
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              Identifique a quien contrata y a la cuenta que usará el servicio. Si contrata una persona natural, puede repetir su nombre como persona que firma y escribir “por sus propios derechos” como calidad.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">
                Referencia de oferta o contrato <span aria-hidden="true">*</span>
                <input required name="contractReference" autoComplete="off" placeholder="Ej.: BIOSKIN-2026-001…" value={client.contractReference} onChange={event => updateClient('contractReference', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Identificador único de esta oferta para relacionar contrato, factura y comprobante de pago.</span>
              </label>
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
              <label className="text-sm font-medium text-gray-700">
                Persona que firma <span aria-hidden="true">*</span>
                <input required name="representative" autoComplete="name" value={client.representative} onChange={event => updateClient('representative', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Quien aceptará o firmará el contrato por el titular.</span>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Calidad con la que firma <span aria-hidden="true">*</span>
                <input required name="representativeRole" placeholder="Ej.: representante legal…" value={client.representativeRole} onChange={event => updateClient('representativeRole', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                <span className="mt-1 block text-xs font-normal text-gray-600">Use “representante legal” para una empresa o “por sus propios derechos” para una persona natural.</span>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Identificación de quien firma <span aria-hidden="true">*</span>
                <input required name="representativeId" inputMode="numeric" pattern="(?:[0-9]{10}|[0-9]{13})" title="Ingrese una cédula de 10 dígitos o un RUC de 13 dígitos." autoComplete="off" value={client.representativeId} onChange={event => updateClient('representativeId', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
              </label>
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

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Vigencia y pago</legend>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Fecha de inicio <span aria-hidden="true">*</span>
                <input required type="date" value={client.startDate} onChange={event => updateClient('startDate', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
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
                  <input required type="number" min="0" step="0.01" inputMode="decimal" value={client.cardCommission} onChange={event => updateClient('cardCommission', event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-[#a77d50] focus:outline-none focus:ring-2 focus:ring-[#a77d50]/30" />
                  <span className="mt-1 block text-xs font-normal text-gray-600">El valor configurado para cobrar USD 245 con tarjeta es USD 14,95. Modifíquelo solo si PayPhone confirma otro importe.</span>
                </label>
              )}
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-gray-900">Módulos incluidos</legend>
            <p className="mb-4 mt-2 text-xs text-gray-600">Marque los módulos acordados. El precio base anual de la plataforma permanece en USD 245 aunque desmarque módulos.</p>
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
                <span className="mt-0.5 block text-xs text-gray-700">Adicional anual: USD 100, IVA incluido.</span>
              </span>
            </label>
          </fieldset>
        </div>

        <aside className="contract-editor h-fit rounded-2xl border border-gray-200 bg-white p-5 shadow-sm xl:sticky xl:top-5">
          <h3 className="text-sm font-semibold text-gray-900">Resumen económico</h3>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-gray-600">Plataforma (anual, IVA incluido)</dt><dd className="font-medium text-gray-900">{formatUsd(PLATFORM_PRICE)}</dd></div>
            {chatbot && <div className="flex justify-between gap-3"><dt className="text-gray-600">Chatbot WhatsApp (anual, IVA incluido)</dt><dd className="font-medium text-gray-900">{formatUsd(WHATSAPP_PRICE)}</dd></div>}
            {client.paymentMethod === 'Tarjeta' && <div className="flex justify-between gap-3"><dt className="text-gray-600">Recargo de pasarela PayPhone</dt><dd className="font-medium text-gray-900">{formatUsd(commission)}</dd></div>}
            <div className="flex justify-between gap-3 border-t border-gray-200 pt-3 text-base"><dt className="font-semibold text-gray-900">Total anual</dt><dd className="font-bold text-gray-900">{formatUsd(total)}</dd></div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-gray-600">La plataforma cuesta USD 245 con IVA incluido. Al pagarla mediante PayPhone se agrega el recargo indicado por la pasarela.</p>
          <button type="button" onClick={printContract} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#a77d50] px-4 py-2 text-sm font-semibold text-white hover:bg-[#89633d] focus:outline-none focus:ring-2 focus:ring-[#a77d50] focus:ring-offset-2">
            <Printer aria-hidden="true" className="h-4 w-4" /> Imprimir / Guardar como PDF
          </button>
        </aside>
      </form>

      <article className="master-contract-preview mx-auto max-w-4xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
        <div className="border-b border-gray-200 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">BIOSKINTECH · Condiciones particulares</p>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">Contrato anual de acceso a la plataforma</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">El presente contrato contiene las condiciones particulares del servicio, el Anexo A de Tratamiento de Datos y las copias íntegras de las Condiciones de Servicio y la Política de Privacidad versión {LEGAL_VERSION}, que forman parte inseparable del acuerdo.</p>
          <p className="mt-2 text-xs font-medium text-gray-700">Referencia: {client.contractReference || '—'} · Lugar de celebración: Cuenca, Ecuador</p>
        </div>

        <section className="contract-economic-section mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">1. Partes y cuenta</h3>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">Proveedor</dt><dd className="font-medium text-gray-900">Rafael Israel Larrea Galindo</dd></div>
            <div><dt className="text-gray-500">RUC del proveedor</dt><dd className="font-medium text-gray-900">0105872600001</dd></div>
            <div><dt className="text-gray-500">Domicilio del proveedor</dt><dd className="font-medium text-gray-900">Cuenca, Ecuador</dd></div>
            <div><dt className="text-gray-500">Cliente</dt><dd className="font-medium text-gray-900">{client.name || '—'}</dd></div>
            <div><dt className="text-gray-500">RUC o cédula</dt><dd className="font-medium text-gray-900">{client.taxId || '—'}</dd></div>
            <div><dt className="text-gray-500">Clínica o cuenta</dt><dd className="font-medium text-gray-900">{client.clinicName || '—'}</dd></div>
            <div><dt className="text-gray-500">Domicilio del cliente</dt><dd className="font-medium text-gray-900">{client.address || '—'}</dd></div>
            <div><dt className="text-gray-500">Persona que suscribe / calidad</dt><dd className="font-medium text-gray-900">{client.representative || '—'}{client.representativeRole ? ` · ${client.representativeRole}` : ''}</dd></div>
            <div><dt className="text-gray-500">Identificación de quien suscribe</dt><dd className="font-medium text-gray-900">{client.representativeId || '—'}</dd></div>
            <div><dt className="text-gray-500">Correo</dt><dd className="font-medium text-gray-900">{client.email || '—'}</dd></div>
            {client.phone && <div><dt className="text-gray-500">Teléfono</dt><dd className="font-medium text-gray-900">{client.phone}</dd></div>}
          </dl>
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
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">3. Precio, vigencia y pago</h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-700">Plataforma, anual, IVA incluido</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(PLATFORM_PRICE)}</dd></div>
            {chatbot && <div className="flex justify-between gap-4"><dt className="text-gray-700">Chatbot WhatsApp del sistema, adicional anual, IVA incluido</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(WHATSAPP_PRICE)}</dd></div>}
            {client.paymentMethod === 'Tarjeta' && <div className="flex justify-between gap-4"><dt className="text-gray-700">Recargo de pasarela PayPhone</dt><dd className="shrink-0 font-medium text-gray-900">{formatUsd(commission)}</dd></div>}
            <div className="flex justify-between gap-4 border-t border-gray-200 pt-2"><dt className="font-bold text-gray-900">Total anual</dt><dd className="shrink-0 font-bold text-gray-900">{formatUsd(total)}</dd></div>
          </dl>
          <p className="mt-3 text-sm text-gray-700"><strong>Inicio:</strong> {formatDate(startDate)} · <strong>Fin de vigencia:</strong> {formatDate(endDate)} · un año.</p>
          <p className="mt-2 text-sm text-gray-700"><strong>Método de pago registrado:</strong> {client.paymentMethod === 'Otro' ? client.otherPaymentMethod || 'Otro' : client.paymentMethod || '—'}</p>
          {client.paymentMethod === 'Tarjeta' && <p className="mt-2 text-xs leading-relaxed text-gray-600">El precio contractual de la plataforma es USD 245 con IVA incluido. El recargo mostrado corresponde al uso de la pasarela PayPhone y eleva el cobro de la plataforma a USD 259,95 cuando su importe es USD 14,95.</p>}
        </section>

        <section className="mt-6 border-t border-gray-200 pt-5">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">4. Documentos integrantes y orden de prevalencia</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Forman un único acuerdo esta carátula y sus condiciones particulares, el Anexo A de Tratamiento de Datos, las Condiciones de Servicio y la Política de Privacidad versión {LEGAL_VERSION}, cuyas copias se adjuntan. En caso de contradicción, prevalecen: (i) estas condiciones particulares para identidad, precio, módulos y vigencia; (ii) el Anexo A para el tratamiento de datos por cuenta del Cliente; y (iii) las Condiciones de Servicio y la Política de Privacidad para sus respectivas materias. Siempre prevalece la ley imperativa.</p>
        </section>

        <section className="contract-signature-section mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">5. Licencia, naturaleza y renovación</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">El Proveedor concede al Cliente una licencia de acceso SaaS limitada, no exclusiva, no transferible y vigente únicamente durante el período contratado. No se vende ni transfiere el código fuente, la Plataforma, las marcas, los modelos 3D ni su propiedad intelectual. BIOSKINTECH es una herramienta de gestión, no presta servicios médicos ni sustituye el criterio profesional.</p>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Este contrato termina en la fecha indicada. No existe renovación automática: toda renovación requiere aceptación expresa del Cliente y del precio vigente. El Proveedor emitirá el comprobante tributario que corresponda al pago recibido.</p>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">6. Disponibilidad, soporte y responsabilidad</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">No se pacta un porcentaje de disponibilidad, tiempo de respuesta o recuperación distinto de lo descrito en los documentos adjuntos. Puede haber mantenimientos, fallas e indisponibilidad de terceros. Los respaldos reducen riesgos, pero no garantizan recuperación total; el Cliente debe conservar las copias exigidas por la normativa aplicable.</p>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">En la máxima medida permitida por la ley, se excluyen daños indirectos y lucro cesante. La responsabilidad contractual total del Proveedor frente al Cliente no excederá lo efectivamente pagado bajo este contrato durante los 12 meses anteriores al hecho. Este límite no opera en supuestos que legalmente no puedan limitarse y no reduce obligaciones frente a Titulares o autoridades de protección de datos.</p>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-800">7. Aceptación y firma</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">Las partes declaran haber verificado su identificación, facultades, alcance, importes y anexos antes de suscribir. El Cliente confirma haber recibido, leído y aceptado los documentos adjuntos versión {LEGAL_VERSION}. La firma manuscrita o electrónica válida de este paquete expresa la aceptación del acuerdo completo.</p>
          <div className="signature-block mt-12 grid gap-10 sm:grid-cols-2">
            <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del cliente · {client.representative || 'Nombre'}</div>
            <div className="border-t border-gray-400 pt-2 text-sm text-gray-700">Firma del proveedor · Rafael Israel Larrea Galindo</div>
          </div>
          <div className="signature-block mt-8 grid gap-6 text-xs text-gray-600 sm:grid-cols-2">
            <p>Fecha: ____________________<br />Lugar: Cuenca, Ecuador</p>
            <p>Fecha: ____________________<br />RUC: 0105872600001</p>
          </div>
        </section>

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
            <section><h3 className="font-bold text-gray-900">A.6. Seguridad, derechos e incidentes</h3><p className="mt-1">El Proveedor asistirá razonablemente al Cliente para atender derechos, evaluaciones e incidentes según la información disponible. Comunicará al Cliente, sin dilación indebida desde que tenga conocimiento de una violación que afecte sus datos, la naturaleza conocida, posibles consecuencias, medidas adoptadas y punto de contacto, completando la información progresivamente. El Cliente decide y realiza las notificaciones que le correspondan como Responsable.</p></section>
            <section><h3 className="font-bold text-gray-900">A.7. Evidencia y auditoría</h3><p className="mt-1">A solicitud razonable, el Proveedor facilitará información disponible para demostrar el cumplimiento de este encargo. Las auditorías deberán proteger la seguridad y confidencialidad de otros clientes, coordinarse con antelación y evitar interferencias desproporcionadas. No se concede acceso a secretos, credenciales ni datos de terceros.</p></section>
            <section><h3 className="font-bold text-gray-900">A.8. Devolución y supresión</h3><p className="mt-1">Durante la suscripción y los 30 días posteriores, el Cliente podrá exportar los formatos disponibles descritos en la Política. Cumplido ese plazo, el Proveedor eliminará o anonimizará los datos activos conforme a sus procedimientos técnicos y obligaciones legales; las copias residuales permanecerán aisladas del uso ordinario hasta vencer sus ciclos de retención. Las fotografías y limitaciones de exportación se rigen por los Arts. 11 a 13 de los documentos adjuntos.</p></section>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 contract-print-summary">
          <p><strong>Documentos adjuntos al imprimir:</strong> Condiciones de Servicio y Política de Privacidad y Tratamiento de Datos Personales, versión {LEGAL_VERSION}.</p>
        </section>
        <div className="contract-print-only hidden">
          <TermsOfService embedded />
          <PrivacyPolicy embedded />
        </div>
      </article>
    </section>
  );
}
