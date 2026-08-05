/**
 * @file src/pages/AdminRegister.tsx
 * @description Página pública de registro de nuevas clínicas en BIOSKIN.
 *
 * Flujo 1: Código único → valida código → formulario → registro
 * Flujo 2: Pago PayPhone → seleccionar plan → pagar → formulario → registro
 * Extra: Login/registro con Google OAuth
 *
 * Post-pago o post-código: formulario con datos personales + datos de clínica.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  Sparkles, Lock, Mail, User, Building2, Phone, MapPin,
  KeyRound, CreditCard, Eye, EyeOff, CheckCircle2, ArrowLeft, Globe,
  MessageCircle, ExternalLink, X, ShieldCheck
} from 'lucide-react';

// Contacto de soporte BioskinTech (número en formato internacional sin +)
const BIOSKIN_SUPPORT_WA = '593984232889';
const PAYMENT_LINK = 'https://ppls.me/U4vULogX4u2gZ8h1TKtWQ';

const API = '/api/admin-auth';
const PAY_API = '/api/payments';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'method' | 'code' | 'payment' | 'form' | 'clinic' | 'done';

interface GoogleData {
  email: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  google_id?: string;
}

interface PlanInfo { name: string; amount_cents: number; description: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminRegister() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();

  const [step, setStep]               = useState<Step>('method');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');

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
  const [clinicPhone, setClinicPhone] = useState('');
  const [clinicAddress, setClinicAddress] = useState('');
  const [clinicCity, setClinicCity]   = useState('');
  const [clinicCountry, setClinicCountry] = useState('Ecuador');
  const [clinicRuc, setClinicRuc]     = useState('');
  const [clinicWebsite, setClinicWebsite] = useState('');
  const [cedulaPro, setCedulaPro]     = useState('');
  const [especialidad, setEspecialidad] = useState('');
  const [emailTaken, setEmailTaken]   = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);

  // Google data prellenada
  const [googleData, setGoogleData]   = useState<GoogleData | null>(null);

  // Enlace de pago
  const [linkOpened, setLinkOpened]   = useState(false);

  // Modal WhatsApp
  const [waModal, setWaModal]         = useState(false);
  const [waForm, setWaForm]           = useState({ nombre: '', apellido: '', cedula: '', motivo: 'compra' });

  // Invite token desde URL
  const inviteToken  = searchParams.get('invite');
  const paymentParam = searchParams.get('payment');
  const googleParam  = searchParams.get('googleData');

  // ── Efectos de inicialización ─────────────────────────────────────────────

  useEffect(() => {
    // Si viene de invite link → ir directo al formulario
    if (inviteToken) { setStep('form'); return; }

    // Si viene con datos de Google (post-OAuth)
    if (googleParam) {
      try {
        const gd: GoogleData = JSON.parse(decodeURIComponent(googleParam));
        setGoogleData(gd);
        setEmail(gd.email || '');
        setFirstName(gd.given_name || '');
        setLastName(gd.family_name || '');
        setStep('form');
      } catch { /* ignorar */ }
    }

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

    // Cargar planes de suscripción
    // ponytail: plan único constante — sin fetch necesario
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken, googleParam, paymentParam]);

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

  // ── Iniciar pago PayPhone ─────────────────────────────────────────────────

  async function handleStartPayment() {
    if (!email.trim()) { setError('Ingresa tu correo electrónico para continuar'); return; }
    setLoading(true); setError('');
    try {
      const r = await fetch(`${PAY_API}?action=preparePayment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_key: 'plan_lanzamiento', email: email.trim() }),
      });
      const d = await r.json();
      if (d.success && d.paymentUrl) {
        setSubId(d.subscription_id);
        window.location.href = d.paymentUrl;
      } else {
        setError(d.error || 'Error al procesar el pago. Verifica tus datos e intenta de nuevo.');
      }
    } catch { setError('Error al conectar con PayPhone. Intenta de nuevo.'); }
    finally { setLoading(false); }
  }

  // ── Login con Google ──────────────────────────────────────────────────────

  async function handleGoogleAuth() {
    setLoading(true); setError('');
    try {
      const r = await fetch(`${API}?action=googleAuthUrl&purpose=register`);
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else setError(d.error || 'Error al conectar con Google');
    } catch { setError('Error al iniciar sesión con Google'); }
    finally { setLoading(false); }
  }

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

  // ── Enviar formulario de registro ─────────────────────────────────────────

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clinicName.trim()) { setError('El nombre de la clínica es requerido'); return; }
    if (!googleData && password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (emailTaken) { setError('Este email ya está en uso. Usa otro correo.'); return; }

    setLoading(true); setError('');
    try {
      const body: Record<string, unknown> = {
        email: email.trim().toLowerCase(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        gentilicio: gentilicio || undefined,
        profession: profession || undefined,
        clinic_name: clinicName.trim(),
        clinic_phone: clinicPhone || undefined,
        clinic_address: clinicAddress || undefined,
        clinic_city: clinicCity || undefined,
        clinic_country: clinicCountry || 'Ecuador',
        clinic_ruc: clinicRuc || undefined,
        clinic_website: clinicWebsite || undefined,
        cedula_profesional: cedulaPro || undefined,
        especialidad: especialidad || undefined,
      };

      // Fuente de autorización: código, pago o invite
      if (inviteToken) {
        body.token = inviteToken;
        if (!googleData) body.password = password;
        const action = 'useInvite';
        const r = await fetch(`${API}?action=${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.success) { await handlePostRegister(d); return; }
        setError(d.error || 'Error al registrarse con la invitación');
        return;
      }

      if (!googleData) body.password = password;
      if (code.trim() && codeValid) body.code = code.trim();
      else if (subscriptionId) body.subscription_id = subscriptionId;
      else if (!googleData) { setError('Se requiere código o pago para registrarse'); setLoading(false); return; }

      const r = await fetch(`${API}?action=register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        await handlePostRegister(d);
      } else {
        setError(d.error || 'Error al registrarse');
      }
    } catch { setError('Error de conexión'); }
    finally { setLoading(false); }
  }

  async function handlePostRegister(d: { sessionToken: string; user?: Record<string, unknown> }) {
    // Guardar sesión directamente sin pasar por el login flow
    localStorage.setItem('bioskin_session_token', d.sessionToken);
    setSuccess('¡Registro exitoso! Redirigiendo...');
    setStep('done');
    setTimeout(() => {
      navigate('/admin');
    }, 1500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea] flex items-center justify-center px-4 py-8 relative overflow-hidden">
      {/* Blobs decorativos */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-48 -right-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-48 -left-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-lg w-full">
        {/* Branding */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-[#deb887] rounded-2xl shadow-lg shadow-[#deb887]/30 mb-3">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight" style={{ fontFamily: 'Playfair Display, serif' }}>BIOSKIN</h1>
          <p className="text-gray-400 mt-1 text-sm uppercase tracking-wide">Registro de nueva clínica</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-[#deb887]/20 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />

          <div className="p-6 space-y-5">

            {/* ── STEP: method ─────────────────────────────────────────── */}
            {step === 'method' && (
              <>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">¿Cómo deseas registrarte?</h2>
                  <p className="text-gray-400 text-sm mt-0.5">Elige tu método de acceso</p>
                </div>

                <div className="grid gap-3">
                  {/* Código único */}
                  <button onClick={() => setStep('code')} className="flex items-center gap-3 p-4 border-2 border-[#deb887]/40 rounded-xl hover:border-[#deb887] hover:bg-[#fdf8f0] transition-all text-left">
                    <KeyRound className="w-5 h-5 text-[#deb887] flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Tengo un código de acceso</p>
                      <p className="text-xs text-gray-400">Ingresa el código que te enviaron</p>
                    </div>
                  </button>

                  {/* PayPhone */}
                  <button onClick={() => setStep('payment')} className="flex items-center gap-3 p-4 border-2 border-blue-100 rounded-xl hover:border-blue-300 hover:bg-blue-50/50 transition-all text-left">
                    <CreditCard className="w-5 h-5 text-blue-500 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Contratar suscripción</p>
                      <p className="text-xs text-gray-400">Pago con tarjeta de débito/crédito vía PayPhone</p>
                    </div>
                  </button>

                  {/* Google */}
                  <button onClick={handleGoogleAuth} disabled={loading} className="flex items-center justify-center gap-3 p-3 border-2 border-gray-200 rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all disabled:opacity-60">
                    <svg className="w-5 h-5" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.1 0 5.9 1.1 8 2.9l5.9-5.9C34.3 3.2 29.4 1 24 1 14.7 1 6.8 6.7 3.4 14.9l6.9 5.3C12 14.5 17.5 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7C35.8 32.5 32.3 35.5 28 36.9v5.6h7.9c4.6-4.2 7.3-10.5 7.3-18z"/><path fill="#FBBC05" d="M10.3 28.5A14.7 14.7 0 0 1 9.5 24c0-1.6.3-3.1.8-4.5L3.4 14.2A23.8 23.8 0 0 0 1 24c0 3.8.9 7.4 2.4 10.6l6.9-5.6z"/><path fill="#34A853" d="M24 47c6.4 0 11.8-2.1 15.7-5.7l-7.9-5.6c-2.1 1.4-4.8 2.2-7.8 2.2-6.3 0-11.6-4.2-13.5-9.8l-6.9 5.3C6.8 41.3 14.7 47 24 47z"/></svg>
                    <span className="text-sm font-medium text-gray-700">Continuar con Google</span>
                  </button>
                </div>

                <p className="text-center text-xs text-gray-400">
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
                <button onClick={() => { setStep('method'); setLinkOpened(false); }} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors">
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
                      <p className="text-2xl font-black text-[#deb887]">$264.50</p>
                      <p className="text-xs text-gray-400">$230 + IVA 15% / año</p>
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

                {/* Botón enlace de pago */}
                {!linkOpened ? (
                  <button
                    onClick={() => { window.open(PAYMENT_LINK, '_blank', 'noopener,noreferrer'); setLinkOpened(true); }}
                    className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-bold hover:bg-[#c9a876] transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#deb887]/30">
                    <ShieldCheck className="w-4 h-4" /> Pagar con enlace seguro PayPhone
                    <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                  </button>
                ) : (
                  <div className="rounded-xl border border-green-200 bg-green-50 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <ShieldCheck className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-green-800">Redirigido a página segura de PayPhone</p>
                        <p className="text-xs text-green-600 mt-0.5">
                          El pago se procesa directamente en la plataforma certificada de PayPhone. Una vez completado,
                          envía tu comprobante para activar tu cuenta.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => window.open(PAYMENT_LINK, '_blank', 'noopener,noreferrer')}
                      className="w-full py-2 border border-green-300 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100 transition-colors flex items-center justify-center gap-1.5">
                      <ExternalLink className="w-3.5 h-3.5" /> Volver a abrir enlace de pago
                    </button>
                  </div>
                )}

                {/* Contactar por WhatsApp */}
                <div className="border-t border-gray-100 pt-4 space-y-2">
                  <p className="text-xs text-gray-500 text-center">
                    {linkOpened
                      ? '¿Ya hiciste el pago? Envía tu comprobante para validación, o contáctanos si necesitas ayuda.'
                      : '¿Prefieres consultar antes de pagar?'}
                  </p>
                  <button
                    onClick={() => setWaModal(true)}
                    className="w-full py-2.5 border-2 border-green-400 text-green-700 rounded-xl text-sm font-semibold hover:bg-green-50 transition-colors flex items-center justify-center gap-2">
                    <MessageCircle className="w-4 h-4" />
                    {linkOpened ? 'Enviar comprobante / Contactar soporte' : 'Contactar por WhatsApp'}
                  </button>
                </div>

                <button onClick={handleStartPayment} disabled={loading || !email.trim()}
                  className="w-full py-2.5 border-2 border-blue-400 text-blue-700 rounded-xl text-sm font-semibold hover:bg-blue-50 transition-colors flex items-center justify-center gap-2 opacity-70">
                  <CreditCard className="w-4 h-4" /> Pago alternativo: PayPhone (integración directa)
                </button>

                {error && <p className="text-red-600 text-sm bg-red-50 rounded-xl px-4 py-2.5">{error}</p>}
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
                    <input required type="text" value={clinicName} onChange={e => setClinicName(e.target.value)} placeholder="Mi Clínica Estética" className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
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
                    <option>Dr.</option>
                    <option>Dra.</option>
                    <option>Lcda.</option>
                    <option>Lcdo.</option>
                    <option>Ing.</option>
                    <option>Mg.</option>
                    <option>Cosmiatra</option>
                    <option>Esteticista</option>
                  </select>
                </div>

                {/* Nombre y apellido */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombres *</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                      <input required type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Ana María" className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Apellidos *</label>
                    <input required type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="García López" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
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

                {/* Cédula profesional */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Cédula profesional / Matrícula</label>
                  <input type="text" value={cedulaPro} onChange={e => setCedulaPro(e.target.value)}
                    placeholder="MP-12345 / 01-0123456"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico *</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type="email" value={email}
                      onChange={e => { setEmail(e.target.value); setEmailTaken(false); }}
                      onBlur={e => handleEmailBlur(e.target.value)}
                      disabled={!!googleData?.email} placeholder="tu@correo.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all disabled:bg-gray-50 disabled:text-gray-500" />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Este correo será tu usuario de acceso</p>
                  {emailChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
                  {emailTaken && <p className="text-xs text-red-500 mt-1">Este email ya está vinculado a otro usuario. Usa otro correo.</p>}
                </div>

                {/* Contraseña (solo si no es Google) */}
                {!googleData && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña *</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                      <input required type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                      <button type="button" onClick={() => setShowPwd(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                        {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                {error && <p className="text-red-600 text-sm bg-red-50 rounded-xl px-4 py-2.5">{error}</p>}

                <button type="submit" disabled={loading} className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors shadow-md shadow-[#deb887]/30">
                  {loading ? 'Registrando...' : 'Crear cuenta y clínica'}
                </button>

                <p className="text-center text-xs text-gray-400">
                  ¿Ya tienes cuenta?{' '}
                  <button type="button" onClick={() => navigate('/admin/login')} className="text-[#deb887] hover:underline font-medium">Inicia sesión</button>
                </p>
              </form>
            )}

            {/* ── STEP: done ───────────────────────────────────────────── */}
            {step === 'done' && (
              <div className="py-8 text-center space-y-4">
                <CheckCircle2 className="w-14 h-14 text-green-500 mx-auto" />
                <h2 className="text-xl font-bold text-gray-900">¡Registro exitoso!</h2>
                <p className="text-gray-500 text-sm">Tu clínica ha sido creada. Redirigiendo al panel...</p>
              </div>
            )}

          </div>
        </div>
      </div>

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
                {linkOpened
                  ? 'Completa tus datos y te contactaremos para validar tu pago o resolver tus dudas.'
                  : 'Déjanos tus datos y un asesor te atenderá directamente por WhatsApp.'}
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
    </div>
  );
}
