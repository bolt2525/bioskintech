/**
 * @file src/pages/AdminRegister.tsx
 * @description Página pública de registro de nuevas clínicas en BIOSKIN.
 *
 * Flujo 1: Código único → valida código → formulario → registro
 * Flujo 2: Pago PayPhone → seleccionar plan → pagar → formulario → registro
 *
 * Post-pago o post-código: formulario con datos personales + datos de clínica.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Lock, Mail, User, Building2, Phone, MapPin,
  KeyRound, CreditCard, Eye, EyeOff, CheckCircle2, ArrowLeft, Globe,
  MessageCircle, ExternalLink, X, ShieldCheck, AtSign, AlertTriangle
} from 'lucide-react';
import AppFooter from '../components/layout/AppFooter';
import BrandLogo from '../components/ui/BrandLogo';

// Contacto de soporte BioskinTech (número en formato internacional sin +)
const BIOSKIN_SUPPORT_WA = '593984232889';
const PAYMENT_LINK = 'https://ppls.me/T2SiYUPiXTvHeMWnDM5iOQ';

const API = '/api/admin-auth';
const PAY_API = '/api/payments';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'method' | 'code' | 'payment' | 'form' | 'done';

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminRegister() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep]               = useState<Step>('method');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  // Código único
  const [code, setCode]               = useState('');
  const [codeValid, setCodeValid]     = useState(false);
  const [planInfo, setPlanInfo]       = useState<{ plan_name: string } | null>(null);

  // Pago
  const [subscriptionId, setSubId]    = useState<number | null>(null);

  // Formulario usuario
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [showPwd, setShowPwd]         = useState(false);
  const [firstName, setFirstName]     = useState('');
  const [lastName, setLastName]       = useState('');
  const [gentilicio, setGentilicio]   = useState('');
  const [profession, setProfession]   = useState('');

  // Formulario clínica
  const [clinicName, setClinicName]   = useState('');
  const [clinicEstablishmentType, setClinicEstablishmentType] = useState('');
  const [clinicPhone, setClinicPhone] = useState('');
  const [clinicAddress, setClinicAddress] = useState('');
  const [clinicCity, setClinicCity]   = useState('');
  const [clinicCountry, setClinicCountry] = useState('Ecuador');
  const [clinicRuc, setClinicRuc]     = useState('');
  const [clinicWebsite, setClinicWebsite] = useState('');
  const [cedulaPro, setCedulaPro]     = useState('');
  const [matriculaSenescyt, setMatriculaSenescyt] = useState('');
  const [especialidad, setEspecialidad] = useState('');
  const [emailTaken, setEmailTaken]   = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);

  // Nombre de usuario
  const [username, setUsername]             = useState('');
  const [usernameSuggested, setUsernameSuggested] = useState(false);
  const [usernameChecking, setUsernameChecking]   = useState(false);
  const [usernameTaken, setUsernameTaken]   = useState(false);

  // Email Gmail de la clínica (para Calendar / correos de citas)
  const [clinicEmail, setClinicEmail]       = useState('');
  const [clinicEmailWarning, setClinicEmailWarning] = useState(false);
  const [clinicEmailTaken, setClinicEmailTaken] = useState(false);
  const [clinicEmailChecking, setClinicEmailChecking] = useState(false);

  // Nombre de clínica — disponibilidad
  const [clinicNameError, setClinicNameError]     = useState('');
  const [clinicNameChecking, setClinicNameChecking] = useState(false);

  // Diálogo de confirmación antes de enviar
  const [showConfirm, setShowConfirm]       = useState(false);

  // Datos del registro exitoso (para la pantalla final)
  const [registeredData, setRegisteredData] = useState<{ clinicName: string; username: string; email: string } | null>(null);

  // Modal WhatsApp
  const [waModal, setWaModal]         = useState(false);
  const [waForm, setWaForm]           = useState({ nombre: '', apellido: '', cedula: '', motivo: 'compra' });
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Invite token desde URL
  const inviteToken  = searchParams.get('invite');
  const paymentParam = searchParams.get('payment');

  // ── Auto-sugerir username cuando nombre completo cambia ──────────────────
  // ponytail: misma lógica que AdminMasterDashboard.generateUsername
  function generateUsername(fullName: string): string {
    const parts = fullName.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0].substring(0, 12);
    const first   = parts[0][0];
    const surname = parts[1];
    const second  = parts.length >= 3 ? parts[2][0] : parts[parts.length - 1][0];
    return `${first}${surname}${second}`.replace(/[^a-z0-9]/g, '');
  }

  // ── Efectos de inicialización ─────────────────────────────────────────────

  useEffect(() => {
    // Si viene de invite link → ir directo al formulario
    if (inviteToken) { setStep('form'); return; }

    // Retorno de PayPhone: adjunta ?payment=confirm&id=X&clientTransactionId=Y
    if (paymentParam === 'confirm') {
      const ppId    = searchParams.get('id');
      const ppTxId  = searchParams.get('clientTransactionId');
      if (ppId && ppTxId) {
        setLoading(true);
        fetch(`${PAY_API}?action=confirmPayment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ppId, clientTransactionId: ppTxId }),
        })
          .then(r => r.json())
          .then(d => {
            if (d.success) { setSubId(d.subscription_id); setStep('form'); }
            else { setError(d.message || 'Pago cancelado o rechazado'); setStep('payment'); }
          })
          .catch(() => { setError('Error al verificar el pago'); setStep('payment'); })
          .finally(() => setLoading(false));
      } else {
        setStep('payment');
      }
    }
    if (paymentParam === 'cancelled') {
      setError('Pago cancelado'); setStep('payment');
    }

    // ponytail: plan único constante — sin fetch necesario
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken, paymentParam]);

  // ── Validar código ────────────────────────────────────────────────────────

  async function handleValidateCode() {
    if (!code.trim()) return;
    setLoading(true); setError('');
    try {
      const r = await fetch(`${API}?action=validateCode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const d = await r.json();
      if (d.valid) {
        setCodeValid(true);
        setPlanInfo(d.code);
        setStep('form');
      } else {
        setError(d.error || 'Código inválido');
      }
    } catch { setError('Error al validar código'); }
    finally { setLoading(false); }
  }

  // ── Iniciar pago PayPhone (sin email previo — PayPhone tiene su propio form)
  async function handleStartPayment() {
    setLoading(true); setError('');
    try {
      const r = await fetch(`${PAY_API}?action=preparePayment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_key: 'plan_lanzamiento' }),
      });
      const d = await r.json();
      if (d.success && d.paymentUrl) {
        setSubId(d.subscription_id);
        window.location.href = d.paymentUrl;
      } else {
        setError(d.error || 'Error al procesar el pago. Intenta de nuevo.');
      }
    } catch { setError('Error al conectar con PayPhone.'); }
    finally { setLoading(false); }
  }

  // ── Verificar disponibilidad de username ──────────────────────────────────
  const handleUsernameBlur = async (val: string) => {
    const u = val.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!u || u.length < 3) return;
    setUsernameChecking(true);
    try {
      const r = await fetch(`${API}?action=checkUsernamePublic&username=${encodeURIComponent(u)}`);
      const d = await r.json();
      setUsernameTaken(!d.available);
    } catch { /* ignore */ }
    finally { setUsernameChecking(false); }
  };

  const handleEmailBlur = async (val: string) => {
    const e = val.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    setEmailChecking(true);
    try {
      const r = await fetch(`/api/admin-auth?action=checkEmail&email=${encodeURIComponent(e)}`);
      const d = await r.json();
      setEmailTaken(!d.available);
    } catch { /* ignore */ }
    finally { setEmailChecking(false); }
  };

  const handleClinicEmailBlur = async (val: string) => {
    const e = val.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    setClinicEmailChecking(true);
    try {
      const r = await fetch(`${API}?action=checkClinicEmail&email=${encodeURIComponent(e)}`);
      const d = await r.json();
      setClinicEmailTaken(!d.available);
    } catch { /* el backend vuelve a validar al registrar */ }
    finally { setClinicEmailChecking(false); }
  };

  const handleClinicNameBlur = async (val: string) => {
    const name = val.trim();
    if (!name || name.length < 2) return;
    setClinicNameChecking(true);
    setClinicNameError('');
    try {
      const r = await fetch(`${API}?action=checkClinicName&name=${encodeURIComponent(name)}`);
      const d = await r.json();
      if (!d.available) setClinicNameError('Ya existe una clínica registrada con ese nombre. Elige otro.');
    } catch { /* ignore — backend valida al registrar */ }
    finally { setClinicNameChecking(false); }
  };

  // ── Enviar formulario de registro ─────────────────────────────────────────

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clinicName.trim()) { setError('El nombre de la clínica es requerido'); return; }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) { setError('La contraseña debe tener al menos una letra y un número'); return; }
    if (emailTaken) { setError('Este email ya está en uso. Usa otro correo.'); return; }
    if (clinicEmailTaken) { setError('Este email ya está vinculado a otra clínica. Usa otro correo.'); return; }
    if (!username.trim() || username.trim().length < 3) { setError('El nombre de usuario debe tener al menos 3 caracteres'); return; }
    if (usernameTaken) { setError('El nombre de usuario ya está en uso. Elige otro.'); return; }
    // Mostrar diálogo de confirmación en vez de enviar directamente
    setShowConfirm(true);
  }

  async function handleConfirmRegister() {
    setShowConfirm(false);
    setLoading(true); setError('');
    try {
      const usernameFinal = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      const body: Record<string, unknown> = {
        email: email.trim().toLowerCase(),
        username: usernameFinal,
        clinic_email: clinicEmail.trim().toLowerCase() || undefined,
        password,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        gentilicio: gentilicio || undefined,
        profession: profession || undefined,
        clinic_name: clinicName.trim(),
        clinic_establishment_type: clinicEstablishmentType || undefined,
        clinic_phone: clinicPhone || undefined,
        clinic_address: clinicAddress || undefined,
        clinic_city: clinicCity || undefined,
        clinic_country: clinicCountry || 'Ecuador',
        clinic_ruc: clinicRuc || undefined,
        clinic_website: clinicWebsite || undefined,
        cedula_profesional: cedulaPro || undefined,
        matricula_senescyt: matriculaSenescyt || undefined,
        especialidad: especialidad || undefined,
      };

      // Fuente de autorización: código, pago o invite
      if (inviteToken) {
        body.token = inviteToken;
        const r = await fetch(`${API}?action=useInvite`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.success) { handlePostRegister(d); return; }
        setError(d.error || 'Error al registrarse con la invitación');
        return;
      }

      if (code.trim() && codeValid) body.code = code.trim();
      else if (subscriptionId) body.subscription_id = subscriptionId;
      else { setError('Se requiere código o pago para registrarse'); setLoading(false); return; }

      const r = await fetch(`${API}?action=register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        handlePostRegister(d);
      } else {
        // Resaltar el campo específico con conflicto
        if (d.field === 'clinic_name') setClinicNameError(d.error || 'Nombre de clínica no disponible');
        if (d.field === 'email') setEmailTaken(true);
        if (d.field === 'clinic_email') setClinicEmailTaken(true);
        if (d.field === 'username') setUsernameTaken(true);
        setError(d.error || 'Error al registrarse');
      }
    } catch { setError('Error de conexión'); }
    finally { setLoading(false); }
  }

  function handlePostRegister(d: { user?: { username?: string; email?: string }; clinic?: { name?: string } }) {
    setRegisteredData({
      clinicName: d.clinic?.name || clinicName,
      username:   d.user?.username || username,
      email:      d.user?.email || email,
    });
    setStep('done');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="gradient-bg min-h-screen flex items-center justify-center px-4 py-8">
      <div className="base" />
      <div className="treatment" />
      <div className="glow" />
      <div className="vignette" />
      <div className="noise" />
      <div className="scanlines" />

      <div className="content w-full flex flex-col items-center">
      <div className="max-w-lg w-full">
        {/* Branding */}
        <div className="text-center mb-6">
          <BrandLogo className="h-24 w-auto object-contain mx-auto" />
          <p className="text-white/40 mt-2 text-sm uppercase tracking-wide">Registro de nueva clínica</p>
        </div>

        <div className="glass-card rounded-2xl overflow-hidden shadow-2xl">
          <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />

          <div className="p-6 space-y-5">

            {/* ── STEP: method ─────────────────────────────────────────── */}
            {step === 'method' && (
              <>
                <div>
                  <h2 className="text-lg font-semibold text-white">¿Cómo deseas registrarte?</h2>
                  <p className="text-white/40 text-sm mt-0.5">Elige tu método de acceso</p>
                </div>

                <div className="grid gap-3">
                  {/* Código único */}
                  <button onClick={() => setStep('code')} className="flex items-center gap-3 p-4 border-2 border-[#deb887]/25 rounded-xl hover:border-[#deb887]/60 hover:bg-white/5 transition-all text-left">
                    <KeyRound className="w-5 h-5 text-[#deb887] flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-white">Tengo un código de acceso</p>
                      <p className="text-xs text-white/40">Ingresa el código que te enviaron</p>
                    </div>
                  </button>

                  {/* PayPhone */}
                  <button onClick={() => setStep('payment')} className="flex items-center gap-3 p-4 border-2 border-blue-500/20 rounded-xl hover:border-blue-500/40 hover:bg-blue-500/5 transition-all text-left">
                    <CreditCard className="w-5 h-5 text-blue-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-white">Contratar suscripción</p>
                      <p className="text-xs text-white/40">Pago con tarjeta de débito/crédito vía PayPhone</p>
                    </div>
                  </button>
                </div>

                <p className="text-center text-xs text-white/35">
                  ¿Ya tienes cuenta?{' '}
                  <button onClick={() => navigate('/admin/login')} className="text-[#deb887] hover:underline font-medium">Inicia sesión</button>
                </p>
              </>
            )}

            {/* ── STEP: code ───────────────────────────────────────────── */}
            {step === 'code' && (
              <>
                <button onClick={() => setStep('method')} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Volver
                </button>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Ingresa tu código</h2>
                  <p className="text-gray-400 text-sm mt-0.5">El código fue enviado por el administrador</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Código de acceso</label>
                  <div className="relative">
                    <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input
                      type="text"
                      value={code}
                      onChange={e => setCode(e.target.value.toUpperCase())}
                      onKeyDown={e => e.key === 'Enter' && handleValidateCode()}
                      placeholder="XXXXXXXXXXXXXX"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm font-mono tracking-widest text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                    />
                  </div>
                </div>
                {error && <p className="text-red-600 text-sm bg-red-50 rounded-xl px-4 py-2">{error}</p>}
                <button onClick={handleValidateCode} disabled={loading || !code.trim()} className="w-full py-2.5 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors">
                  {loading ? 'Validando...' : 'Validar código'}
                </button>
              </>
            )}

            {/* ── STEP: payment ────────────────────────────────────────── */}
            {step === 'payment' && (
              <>
                <button onClick={() => setStep('method')} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Volver
                </button>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Suscripción Anual</h2>
                  <p className="text-gray-400 text-sm mt-0.5">Pago único anual · Plan de Lanzamiento</p>
                </div>

                {/* Plan único BioskinTech */}
                <div className="p-5 rounded-2xl border-2 border-[#deb887] bg-[#fdf8f0]">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="font-bold text-gray-900">Plan Lanzamiento BioskinTech</p>
                      <p className="text-xs text-[#deb887] font-semibold mt-0.5">🎉 Precio especial de lanzamiento</p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      <p className="text-2xl font-black text-[#deb887]">$245</p>
                      <p className="text-xs text-gray-400">IVA incluido / año</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 leading-relaxed mb-3">
                    Fichas Clínicas, Agenda Google Calendar, 3D Injectable Mapping, Inventario, Finanzas, Consentimientos Digitales y Fotos Clínicas.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {['Fichas Clínicas','Agenda Google','3D Mapping','Inventario','Finanzas','Consentimientos','Fotos'].map(f => (
                      <span key={f} className="text-xs bg-[#deb887]/20 text-[#c9a876] px-2 py-0.5 rounded-full font-medium">{f}</span>
                    ))}
                  </div>
                </div>

                {/* Botón PayPhone API directo */}
                <p className="text-xs text-center text-gray-400 -mb-1">
                  Al contratar confirmas que has leído y aceptas nuestras{' '}
                  <a href="/condiciones-de-servicio" target="_blank" rel="noopener noreferrer" className="text-[#deb887] hover:underline font-medium">Condiciones de Servicio</a>
                  {' '}y la{' '}
                  <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="text-[#deb887] hover:underline font-medium">Política de Privacidad</a>.
                </p>
                <button
                  onClick={handleStartPayment}
                  disabled={loading}
                  className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-bold hover:bg-[#c9a876] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#deb887]/30">
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      Procesando...
                    </span>
                  ) : (
                    <><ShieldCheck className="w-4 h-4" /> Pagar con PayPhone</>
                  )}
                </button>

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-red-800">Error al procesar el pago</p>
                        <p className="text-xs text-red-600 mt-0.5">{error}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <a
                        href={PAYMENT_LINK}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 py-2 bg-white border border-red-200 text-red-700 rounded-lg text-xs font-medium hover:bg-red-50 transition-colors flex items-center justify-center gap-1.5">
                        <ExternalLink className="w-3.5 h-3.5" /> Pagar por enlace directo
                      </a>
                      <button
                        type="button"
                        onClick={() => setWaModal(true)}
                        className="flex-1 py-2 bg-green-500 text-white rounded-lg text-xs font-semibold hover:bg-green-600 transition-colors flex items-center justify-center gap-1.5">
                        <MessageCircle className="w-3.5 h-3.5" /> Contactar por WhatsApp
                      </button>
                    </div>
                  </div>
                )}

                {/* Contactar por WhatsApp */}
                {!error && (
                  <div className="border-t border-gray-100 pt-4">
                    <button
                      type="button"
                      onClick={() => setWaModal(true)}
                      className="w-full py-2.5 border-2 border-green-400 text-green-700 rounded-xl text-sm font-semibold hover:bg-green-50 transition-colors flex items-center justify-center gap-2">
                      <MessageCircle className="w-4 h-4" />
                      ¿Preguntas? Contactar por WhatsApp
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ── STEP: form (datos personales + clínica) ──────────────── */}
            {(step === 'form' || step === 'clinic') && (
              <form onSubmit={handleRegisterSubmit} className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Datos de registro</h2>
                  {planInfo && <p className="text-xs text-[#deb887] mt-0.5">Plan: <strong>{planInfo.plan_name}</strong></p>}
                  {inviteToken && <p className="text-xs text-green-600 mt-0.5">Registrándote con enlace de invitación</p>}
                </div>

                {/* ── Datos de la Clínica ── */}
                <div className="pt-2 border-t border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-[#deb887]" /> Datos de la Clínica
                  </h3>
                </div>

                {/* Nombre clínica */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre de la clínica *</label>
                  <div className="relative">
                    <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type="text" value={clinicName}
                      onChange={e => { setClinicName(e.target.value); setClinicNameError(''); }}
                      onBlur={e => handleClinicNameBlur(e.target.value)}
                      placeholder="Mi Clínica Estética"
                      className={`w-full pl-10 pr-4 py-2.5 border rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all ${clinicNameError ? 'border-red-400 bg-red-50' : 'border-gray-200'}`} />
                  </div>
                  {clinicNameChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
                  {clinicNameError && <p className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3 flex-shrink-0" />{clinicNameError}</p>}
                  {!clinicNameError && !clinicNameChecking && clinicName.trim().length >= 2 && <p className="text-xs text-emerald-600 mt-1">✓ Nombre disponible</p>}
                </div>

                {/* Tipo de establecimiento */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Tipo de establecimiento</label>
                  <select value={clinicEstablishmentType} onChange={e => setClinicEstablishmentType(e.target.value)}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all bg-white">
                    <option value="">Seleccionar tipo...</option>
                    <option>Clínica</option>
                    <option>Clínica Estética</option>
                    <option>Centro Estético</option>
                    <option>Centro de Medicina Estética</option>
                    <option>Consultorio Médico</option>
                    <option>Consultorio Estético</option>
                    <option>Spa Médico</option>
                    <option>Spa</option>
                    <option>Centro de Bienestar</option>
                    <option>Centro de Dermatología</option>
                    <option>Centro de Salud</option>
                    <option>Centro de Nutrición</option>
                    <option>Consultorio Odontológico</option>
                  </select>
                </div>

                {/* RUC */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">RUC / NIT</label>
                  <input type="text" value={clinicRuc} onChange={e => setClinicRuc(e.target.value)} placeholder="0912345678001" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Teléfono */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Teléfono</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                      <input type="tel" value={clinicPhone} onChange={e => setClinicPhone(e.target.value)} placeholder="+593 99..." className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    </div>
                  </div>
                  {/* Ciudad */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Ciudad</label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                      <input type="text" value={clinicCity} onChange={e => setClinicCity(e.target.value)} placeholder="Quito" className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    </div>
                  </div>
                </div>

                {/* Dirección */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Dirección</label>
                  <div className="relative">
                    <MapPin className="absolute left-3.5 top-3 text-gray-300 w-4 h-4" />
                    <textarea value={clinicAddress} onChange={e => setClinicAddress(e.target.value)} placeholder="Calle, número, sector..." rows={2} className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all resize-none" />
                  </div>
                </div>

                {/* Sitio web */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Sitio web</label>
                  <div className="relative">
                    <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input type="url" value={clinicWebsite} onChange={e => setClinicWebsite(e.target.value)}
                      placeholder="https://miclinica.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                </div>

                {/* Gmail de la clínica */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Gmail de la clínica
                    <span className="ml-1.5 text-xs font-normal text-[#c9a876]">(recomendado)</span>
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input
                      type="email"
                      value={clinicEmail}
                      onChange={e => {
                        setClinicEmail(e.target.value);
                        setClinicEmailTaken(false);
                        const v = e.target.value.trim().toLowerCase();
                        setClinicEmailWarning(!!v && !v.endsWith('@gmail.com') && !v.endsWith('.google.com'));
                      }}
                      onBlur={e => handleClinicEmailBlur(e.target.value)}
                      placeholder="miclinica@gmail.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Este Gmail se usará para Google Calendar y enviar correos de citas automáticos</p>
                  {clinicEmailWarning && (
                    <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Para usar Calendar y correos, se recomienda una cuenta de Gmail (@gmail.com)
                    </p>
                  )}
                  {clinicEmailChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
                  {clinicEmailTaken && <p className="text-xs text-red-500 mt-1">Este email ya está vinculado a otra clínica. Usa otro correo.</p>}
                </div>

                {/* ── Datos del Usuario ── */}
                <div className="pt-2 border-t border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <User className="w-4 h-4 text-[#deb887]" /> Datos del Usuario
                  </h3>
                </div>

                {/* Gentilicio */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Título / Gentilicio</label>
                  <select value={gentilicio} onChange={e => setGentilicio(e.target.value)} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all bg-white">
                    <option value="">Sin título</option>
                    <option>Dr.</option><option>Dra.</option>
                    <option>Md.</option>
                    <option>Odont.</option>
                    <option>Lcdo.</option><option>Lcda.</option>
                    <option>Lic.</option>
                    <option>Enf.</option>
                    <option>Psic.</option>
                    <option>Nut.</option>
                    <option>Bioquím.</option>
                    <option>Farm.</option>
                    <option>Ing.</option>
                    <option>Mg.</option><option>Mgtr.</option>
                    <option>Ph.D.</option>
                    <option>Cosm.</option>
                    <option>Cosmiatra</option>
                    <option>Esteticista</option>
                    <option>Sr.</option><option>Sra.</option>
                  </select>
                </div>

                {/* Nombre y apellido */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombres *</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                      <input required type="text" value={firstName}
                        onChange={e => {
                          setFirstName(e.target.value);
                          if (!usernameSuggested || !username) {
                            const suggested = generateUsername(`${e.target.value} ${lastName}`);
                            if (suggested) { setUsername(suggested); setUsernameTaken(false); }
                          }
                        }}
                        placeholder="Ana María" className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Apellidos *</label>
                    <input required type="text" value={lastName}
                      onChange={e => {
                        setLastName(e.target.value);
                        if (!usernameSuggested || !username) {
                          const suggested = generateUsername(`${firstName} ${e.target.value}`);
                          if (suggested) { setUsername(suggested); setUsernameTaken(false); }
                        }
                      }}
                      placeholder="García López" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                </div>

                {/* Profesión */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Profesión</label>
                  <input type="text" value={profession} onChange={e => setProfession(e.target.value)} placeholder="Médico Estético, Cosmiatra, etc." className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                </div>

                {/* Especialidad */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Especialidad</label>
                  <input type="text" value={especialidad} onChange={e => setEspecialidad(e.target.value)}
                    placeholder="Medicina Estética, Dermatología..."
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                </div>

                {/* Cédula e identidad + Matrícula SENESCYT */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Cédula / RUC</label>
                    <input type="text" value={cedulaPro} onChange={e => setCedulaPro(e.target.value)}
                      placeholder="Ej: 0987654321"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Matrícula SENESCYT</label>
                    <input type="text" value={matriculaSenescyt} onChange={e => setMatriculaSenescyt(e.target.value)}
                      placeholder="Ej: 1020-12-86012345"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                </div>

                {/* Email de login */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico de acceso *</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type="email" value={email}
                      onChange={e => { setEmail(e.target.value); setEmailTaken(false); }}
                      onBlur={e => handleEmailBlur(e.target.value)}
                      placeholder="tu@correo.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">⚠️ Recuerda este correo — lo usarás para ingresar a BioSkinTech. Puede ser el mismo Gmail de la clínica u otro.</p>
                  {emailChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
                  {emailTaken && <p className="text-xs text-red-500 mt-1">Este email ya está vinculado a otro usuario. Usa otro correo.</p>}
                </div>

                {/* Nombre de usuario */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre de usuario *</label>
                  <div className="relative">
                    <AtSign className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input
                      type="text"
                      value={username}
                      onChange={e => {
                        const v = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
                        setUsername(v);
                        setUsernameSuggested(true);
                        setUsernameTaken(false);
                      }}
                      onBlur={e => handleUsernameBlur(e.target.value)}
                      placeholder="usuario_clinica"
                      minLength={3}
                      maxLength={20}
                      required
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 font-mono placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">También puedes ingresar con este nombre de usuario. Solo letras, números y guión bajo.</p>
                  {usernameChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
                  {usernameTaken && <p className="text-xs text-red-500 mt-1">Este nombre de usuario ya está en uso. Elige otro.</p>}
                  {!usernameTaken && username.length >= 3 && !usernameChecking && (
                    <p className="text-xs text-emerald-600 mt-1">✓ Disponible</p>
                  )}
                </div>

                {/* Contraseña */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña *</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres, letras y números" className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    <button type="button" onClick={() => setShowPwd(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                      {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && <p className="text-red-600 text-sm bg-red-50 rounded-xl px-4 py-2.5">{error}</p>}

                {/* Aceptación obligatoria de Términos */}
                <label className="flex items-start gap-3 p-3 rounded-xl border border-[#deb887]/20 bg-[#fdf8f0] cursor-pointer hover:bg-[#fdf0e0] transition-colors">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={e => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 w-4 h-4 text-[#deb887] rounded focus:ring-[#deb887] flex-shrink-0"
                  />
                  <span className="text-xs text-gray-600 leading-relaxed">
                    He leído y acepto las{' '}
                    <a href="/condiciones-de-servicio" target="_blank" rel="noopener noreferrer" className="text-[#deb887] font-semibold hover:underline">Condiciones de Servicio</a>
                    {' '}y la{' '}
                    <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="text-[#deb887] font-semibold hover:underline">Política de Privacidad</a>
                    {' '}de BioSkinTech. <span className="text-red-500">(Obligatorio)</span>
                  </span>
                </label>

                <button type="submit" disabled={loading || usernameTaken || emailTaken || clinicEmailTaken || !!clinicNameError || clinicNameChecking || !acceptedTerms} className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors shadow-md shadow-[#deb887]/30">
                  {loading ? 'Guardando...' : 'Guardar y crear clínica →'}
                </button>

                <p className="text-center text-xs text-gray-400">
                  ¿Ya tienes cuenta?{' '}
                  <button type="button" onClick={() => navigate('/admin/login')} className="text-[#deb887] hover:underline font-medium">Inicia sesión</button>
                </p>
              </form>
            )}

            {/* ── STEP: done ───────────────────────────────────────────── */}
            {step === 'done' && (
              <div className="py-6 space-y-5">
                <div className="text-center">
                  <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
                  <h2 className="text-xl font-bold text-gray-900">¡Clínica creada exitosamente!</h2>
                  <p className="text-gray-500 text-sm mt-1">Se ha enviado un correo de bienvenida con tus datos de acceso.</p>
                </div>

                {registeredData && (
                  <div className="bg-[#fdf8f0] border border-[#deb887]/40 rounded-xl p-4 space-y-2 text-sm">
                    <p className="font-semibold text-gray-700 flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-[#deb887]" /> {registeredData.clinicName}
                    </p>
                    <p className="text-gray-600">
                      <span className="font-medium">Usuario:</span> <span className="font-mono">{registeredData.username}</span>
                    </p>
                    <p className="text-gray-600">
                      <span className="font-medium">Email de login:</span> {registeredData.email}
                    </p>
                  </div>
                )}

                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 space-y-1">
                  <p className="font-semibold">📧 Próximo paso recomendado</p>
                  <p>Revisa tu correo (incluyendo Spam) para el link de conexión de tu Gmail con Google Calendar y correos automáticos.</p>
                </div>

                <button
                  onClick={() => navigate('/admin/login')}
                  className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] transition-colors shadow-md shadow-[#deb887]/30">
                  Ir al login →
                </button>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ── Modal de confirmación ──────────────────────────────────────────── */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full">
            <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887] rounded-t-2xl" />
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-gray-900">Confirmar registro</h3>
                <button onClick={() => setShowConfirm(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm text-gray-700">
                <p><span className="font-medium text-gray-500">Clínica:</span> {clinicName}</p>
                {clinicEmail && <p><span className="font-medium text-gray-500">Gmail clínica:</span> {clinicEmail}</p>}
                <p><span className="font-medium text-gray-500">Nombre:</span> {firstName} {lastName}</p>
                <p><span className="font-medium text-gray-500">Usuario:</span> <span className="font-mono">{username}</span></p>
                <p><span className="font-medium text-gray-500">Email login:</span> {email}</p>
              </div>

              <p className="text-xs text-gray-400">Verifica que los datos sean correctos antes de crear tu cuenta.</p>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Editar
                </button>
                <button
                  onClick={handleConfirmRegister}
                  disabled={loading}
                  className="flex-1 py-2.5 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors">
                  {loading ? 'Creando...' : 'Confirmar y crear'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal WhatsApp ─────────────────────────────────────────────────── */}
      {waModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full">
            <div className="h-1 bg-gradient-to-r from-green-400 to-green-600 rounded-t-2xl" />
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="w-5 h-5 text-green-600" />
                  <h3 className="font-bold text-gray-900">Contactar por WhatsApp</h3>
                </div>
                <button onClick={() => setWaModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <p className="text-xs text-gray-500">
                Déjanos tus datos y un asesor te atenderá directamente por WhatsApp.
              </p>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
                    <input
                      type="text" value={waForm.nombre}
                      onChange={e => setWaForm(f => ({ ...f, nombre: e.target.value }))}
                      placeholder="Ana" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-300 focus:border-green-400 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Apellido *</label>
                    <input
                      type="text" value={waForm.apellido}
                      onChange={e => setWaForm(f => ({ ...f, apellido: e.target.value }))}
                      placeholder="García" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-300 focus:border-green-400 outline-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Cédula / RUC *</label>
                  <input
                    type="text" value={waForm.cedula}
                    onChange={e => setWaForm(f => ({ ...f, cedula: e.target.value }))}
                    placeholder="0912345678 / 0912345678001"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-300 focus:border-green-400 outline-none" />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Motivo</label>
                  <select
                    value={waForm.motivo}
                    onChange={e => setWaForm(f => ({ ...f, motivo: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-300 focus:border-green-400 outline-none bg-white">
                    <option value="compra">Validar comprobante de pago</option>
                    <option value="consulta">Consulta sobre el plan</option>
                    <option value="soporte">Soporte técnico</option>
                    <option value="otro">Otro</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button onClick={() => setWaModal(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
                <button
                  disabled={!waForm.nombre.trim() || !waForm.apellido.trim() || !waForm.cedula.trim()}
                  onClick={() => {
                    const motivoLabel: Record<string, string> = {
                      compra: 'Validación de comprobante de pago - Suscripción Anual BioskinTech',
                      consulta: 'Consulta sobre el Plan de Suscripción Anual',
                      soporte: 'Soporte técnico / consulta directa',
                      otro: 'Consulta general',
                    };
                    const msg = [
                      `*Hola, me contacto desde el portal BioskinTech.*`,
                      ``,
                      `*Nombre:* ${waForm.nombre.trim()} ${waForm.apellido.trim()}`,
                      `*Cédula/RUC:* ${waForm.cedula.trim()}`,
                      `*Motivo:* ${motivoLabel[waForm.motivo] || waForm.motivo}`,
                      ``,
                      waForm.motivo === 'compra'
                        ? `Adjunto el comprobante de pago para validación de mi suscripción anual.`
                        : `Quedo atento/a a su respuesta.`,
                    ].join('\n');
                    window.open(`https://wa.me/${BIOSKIN_SUPPORT_WA}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener,noreferrer');
                    setWaModal(false);
                  }}
                  className="flex-1 py-2 bg-green-500 text-white rounded-lg text-sm font-semibold hover:bg-green-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                  <MessageCircle className="w-4 h-4" /> Abrir WhatsApp
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <AppFooter theme="dark" />
    </div>
    </div>
  );
}
