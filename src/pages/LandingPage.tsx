import { useEffect, useState } from 'react';
import {
  Sparkles, Activity, Stethoscope, Smile, ChevronRight,
  FileText, CalendarDays, Brain, Package, DollarSign,
  MessageSquare, Shield, Users, CheckCircle,
} from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';

const MODULES = [
  {
    key: 'estetica',
    icon: Sparkles,
    label: 'Gestión Estética',
    description: 'Panel completo para clínicas de medicina estética y cosmética.',
    href: '/gestionestetica/admin/login',
    status: 'active' as const,
    accent: '#deb887',
  },
  {
    key: 'odonto',
    icon: Smile,
    label: 'Gestión Odontológica',
    description: 'Fichas dentales, radiografías y planes de tratamiento.',
    href: '#',
    status: 'soon' as const,
    accent: '#60a5fa',
  },
  {
    key: 'medgen',
    icon: Stethoscope,
    label: 'Medicina General',
    description: 'Consultas, recetas digitales y seguimiento de pacientes.',
    href: '#',
    status: 'soon' as const,
    accent: '#34d399',
  },
  {
    key: 'otros',
    icon: Activity,
    label: 'Otros Servicios',
    description: 'Más especialidades y servicios BIOSKINTECH próximamente.',
    href: '#',
    status: 'soon' as const,
    accent: '#a78bfa',
  },
];

const FEATURES = [
  {
    icon: FileText,
    title: 'Fichas Clínicas Digitales',
    subtitle: 'Gestión completa de pacientes',
    description: 'Historial médico con antecedentes, diagnósticos, tratamientos, fotografías clínicas y evolución. Todo centralizado y accesible desde cualquier dispositivo.',
    tags: ['Antecedentes', 'Diagnóstico', 'Evolución', 'Fotos'],
    accent: '#deb887',
    bg: 'linear-gradient(135deg, #1e1500 0%, #0f0a00 100%)',
  },
  {
    icon: Shield,
    title: 'Consentimientos Digitales',
    subtitle: 'Firma electrónica segura',
    description: 'Consentimientos informados que el paciente firma desde su propio dispositivo con enlace único y seguro. Sin papel, con validez legal.',
    tags: ['Firma digital', 'Sin papel', 'Enlace único', 'Legal'],
    accent: '#60a5fa',
    bg: 'linear-gradient(135deg, #001829 0%, #000f1a 100%)',
  },
  {
    icon: CalendarDays,
    title: 'Agenda Inteligente',
    subtitle: 'Sincronización Google Calendar',
    description: 'Gestión de citas con integración bidireccional a Google Calendar. Recordatorios automáticos vía WhatsApp, bloqueo de horarios y agenda diaria para el staff.',
    tags: ['Google Cal', 'WhatsApp', 'Recordatorios', 'Bloqueos'],
    accent: '#34d399',
    bg: 'linear-gradient(135deg, #001a0f 0%, #000f07 100%)',
  },
  {
    icon: Brain,
    title: 'Inteligencia Artificial',
    subtitle: 'Asistente Gema IA',
    description: 'Diagnóstico asistido por IA, generación automática de protocolos de tratamiento personalizados y asistente virtual Gema integrado en cada ficha clínica.',
    tags: ['Diagnóstico IA', 'Protocolos', 'GPT-4', 'Gemini'],
    accent: '#c084fc',
    bg: 'linear-gradient(135deg, #1a0029 0%, #0e001a 100%)',
  },
  {
    icon: Package,
    title: 'Inventario y Stock',
    subtitle: 'Control de productos y lotes',
    description: 'Gestión de inventario con control por lotes, fechas de vencimiento, alertas automáticas y movimientos vinculados a cada tratamiento aplicado.',
    tags: ['Lotes', 'Vencimientos', 'Alertas', 'Movimientos'],
    accent: '#fb923c',
    bg: 'linear-gradient(135deg, #1a0e00 0%, #0f0800 100%)',
  },
  {
    icon: DollarSign,
    title: 'Finanzas y Reportes',
    subtitle: 'Control financiero completo',
    description: 'Registro de ingresos y egresos, análisis de rentabilidad por tratamiento, reportes mensuales y exportación de datos financieros de tu clínica.',
    tags: ['Ingresos', 'Egresos', 'Reportes', 'Análisis'],
    accent: '#4ade80',
    bg: 'linear-gradient(135deg, #001a00 0%, #000f00 100%)',
  },
  {
    icon: MessageSquare,
    title: 'Bot WhatsApp Interno',
    subtitle: 'Tu equipo siempre informado',
    description: 'Bot de WhatsApp para el staff: agenda diaria automática, notificaciones de nuevas citas y recordatorios internos. Comunicación centralizada sin esfuerzo.',
    tags: ['WhatsApp', 'Agenda staff', 'Alertas', 'Automático'],
    accent: '#2dd4bf',
    bg: 'linear-gradient(135deg, #001a18 0%, #000f0d 100%)',
  },
  {
    icon: Users,
    title: 'Multi-Clínica y Roles',
    subtitle: 'Escalable y seguro',
    description: 'Arquitectura multi-tenant con roles diferenciados: administrador y colaboradores. Datos completamente aislados entre clínicas con cifrado PBKDF2.',
    tags: ['Multi-sede', 'Roles', 'Aislamiento', 'Cifrado'],
    accent: '#f472b6',
    bg: 'linear-gradient(135deg, #1a0016 0%, #0f000e 100%)',
  },
];

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="bg-black text-white">

      {/* ── Header fijo ─────────────────────────────────────────────── */}
      <header className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'bg-black/85 backdrop-blur-md border-b border-[#deb887]/15 shadow-xl shadow-black/50'
          : 'bg-transparent'
      }`}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-9 w-auto object-contain" />
            <span className="font-bold text-white/90 tracking-tight hidden sm:inline text-sm"
              style={{ fontFamily: 'Playfair Display, serif' }}>
              BIOSKINTECH
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a href="/gestionestetica/admin/register"
              className="hidden sm:inline text-sm text-white/50 hover:text-white/80 transition-colors">
              Registrarse
            </a>
            <a href="/gestionestetica/admin/login"
              className="text-sm font-semibold bg-[#deb887] text-black px-5 py-2 rounded-full
                         hover:bg-[#c9a876] transition-all shadow-lg shadow-[#deb887]/20 hover:shadow-[#deb887]/40">
              Ingresar
            </a>
          </div>
        </div>
      </header>

      {/* ── Hero — gradient-bg ───────────────────────────────────────── */}
      <section className="gradient-bg min-h-screen flex flex-col">
        <div className="base" />
        <div className="treatment" />
        <div className="glow" />
        <div className="particles" />
        <div className="vignette" />
        <div className="noise" />
        <div className="scanlines" />

        <div className="content flex-1 flex flex-col items-center justify-center px-6 pt-32 pb-20 text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-[#deb887]/10 border border-[#deb887]/25
                          rounded-full px-4 py-1.5 text-sm text-[#deb887] font-medium mb-10 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
            Plataforma activa · Gestión Estética disponible ahora
          </div>

          {/* Título enmascarado con logo */}
          <h1 className="text-logo-mask text-6xl sm:text-7xl md:text-8xl lg:text-[7rem]
                         font-black mb-6 leading-none tracking-tighter select-none">
            BIOSKINTECH
          </h1>

          <p className="text-white/65 text-lg md:text-xl font-light mb-3 max-w-xl">
            Plataforma de{' '}
            <span className="text-[#deb887] font-semibold">Gestión Clínica Inteligente</span>
          </p>
          <p className="text-white/40 text-sm md:text-base max-w-lg leading-relaxed mb-12">
            Administra fichas de pacientes, agenda, consentimientos digitales,
            inventario y finanzas de tu clínica estética desde un único lugar seguro.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap items-center justify-center gap-4 mb-16">
            <a href="/gestionestetica/admin/login"
              className="inline-flex items-center gap-2 bg-[#deb887] text-black font-bold
                         px-8 py-3.5 rounded-full hover:bg-[#c9a876] transition-all
                         hover:shadow-2xl hover:shadow-[#deb887]/30 hover:-translate-y-0.5 text-sm">
              Acceder al panel <ChevronRight className="w-4 h-4" />
            </a>
            <a href="/gestionestetica/admin/register"
              className="inline-flex items-center gap-2 bg-white/5 border border-white/20 text-white
                         font-medium px-8 py-3.5 rounded-full hover:bg-white/10 transition-all
                         text-sm backdrop-blur-sm">
              Registrar mi clínica
            </a>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-8 pt-8 border-t border-white/8">
            {[
              { value: '8+', label: 'Módulos integrados' },
              { value: '100%', label: 'Digital y sin papel' },
              { value: 'IA', label: 'Diagnóstico asistido' },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className="text-2xl font-bold text-[#deb887]">{s.value}</div>
                <div className="text-xs text-white/35 mt-0.5 whitespace-nowrap">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="content flex justify-center pb-10 animate-bounce">
          <div className="w-5 h-9 border-2 border-white/15 rounded-full flex justify-center pt-1.5">
            <div className="w-1 h-2 bg-white/30 rounded-full" />
          </div>
        </div>
      </section>

      {/* ── Especialidades / módulos de acceso ──────────────────────── */}
      <section className="bg-[#080807] py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[#deb887] text-xs font-bold uppercase tracking-[0.2em] mb-3">
              Especialidades
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4"
              style={{ fontFamily: 'Playfair Display, serif' }}>
              Elige tu área de práctica
            </h2>
            <p className="text-white/35 text-sm max-w-md mx-auto">
              Una plataforma modular para distintas especialidades de la salud y la estética médica.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {MODULES.map(mod => {
              const Icon = mod.icon;
              const active = mod.status === 'active';
              return (
                <a
                  key={mod.key}
                  href={mod.href}
                  onClick={active ? undefined : e => e.preventDefault()}
                  className={`group relative flex flex-col gap-4 p-6 rounded-2xl border
                              bg-white/[0.025] transition-all duration-300 ${
                    active
                      ? 'border-[#deb887]/25 hover:border-[#deb887]/55 hover:bg-white/[0.05] hover:-translate-y-1.5 cursor-pointer'
                      : 'border-white/5 opacity-40 cursor-default'
                  }`}
                >
                  {/* Status badge */}
                  <span className={`absolute top-4 right-4 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                    active
                      ? 'text-green-400 bg-green-400/10 border border-green-400/20'
                      : 'text-white/25 bg-white/5'
                  }`}>
                    {active ? 'Activo' : 'Próximo'}
                  </span>

                  {/* Arrow on hover */}
                  {active && (
                    <div className="absolute top-4 left-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      <ChevronRight className="w-3.5 h-3.5" style={{ color: mod.accent }} />
                    </div>
                  )}

                  {/* Icon */}
                  <div className="mt-3" style={{ color: mod.accent }}>
                    <Icon className="w-7 h-7" />
                  </div>

                  {/* Text */}
                  <div>
                    <h3 className="text-sm font-bold text-white mb-1.5">{mod.label}</h3>
                    <p className="text-xs text-white/35 leading-relaxed">{mod.description}</p>
                  </div>

                  {active && (
                    <div className="flex items-center gap-1 text-xs font-semibold mt-auto
                                    group-hover:gap-2 transition-all duration-200"
                      style={{ color: mod.accent }}>
                      Ingresar
                      <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Rejilla cromática — módulos en detalle ──────────────────── */}
      <section className="bg-[#050504] py-20 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[#deb887] text-xs font-bold uppercase tracking-[0.2em] mb-3">
              Todo en uno
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4"
              style={{ fontFamily: 'Playfair Display, serif' }}>
              ¿Por qué suscribirte a BIOSKINTECH?
            </h2>
            <p className="text-white/35 text-sm max-w-lg mx-auto">
              Pasa el cursor sobre cada módulo y descubre cómo transforma la gestión de tu clínica.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FEATURES.map(feat => {
              const Icon = feat.icon;
              return (
                <div
                  key={feat.title}
                  className="chromatic-card group relative rounded-2xl overflow-hidden"
                  style={{ background: feat.bg }}
                >
                  {/* Top glow on hover */}
                  <div
                    className="absolute top-0 inset-x-0 h-28 opacity-0 group-hover:opacity-100
                                transition-opacity duration-500 pointer-events-none"
                    style={{ background: `radial-gradient(ellipse at 50% 0%, ${feat.accent}28, transparent 70%)` }}
                  />
                  {/* Colored border on hover */}
                  <div
                    className="absolute inset-0 rounded-2xl border border-transparent
                                group-hover:border-current transition-colors duration-500 pointer-events-none"
                    style={{ color: `${feat.accent}55` }}
                  />

                  <div className="relative p-6 flex flex-col min-h-[13rem]">
                    {/* Icon */}
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4
                                    bg-white/5 group-hover:bg-white/8 transition-colors"
                      style={{ color: feat.accent }}>
                      <Icon className="w-5 h-5" />
                    </div>

                    <h3 className="text-sm font-bold text-white mb-1">{feat.title}</h3>
                    <p className="text-[11px] font-medium mb-3" style={{ color: `${feat.accent}99` }}>
                      {feat.subtitle}
                    </p>

                    {/* Description visible on hover */}
                    <p className="text-xs text-white/55 leading-relaxed mb-4
                                  opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex-1">
                      {feat.description}
                    </p>

                    <div className="flex flex-wrap gap-1.5 mt-auto">
                      {feat.tags.map(tag => (
                        <span key={tag}
                          className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
                          style={{ borderColor: `${feat.accent}25`, color: `${feat.accent}70` }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Beneficios ───────────────────────────────────────────────── */}
      <section className="bg-[#080807] py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-[#deb887] text-xs font-bold uppercase tracking-[0.2em] mb-3">Plan único</p>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4"
            style={{ fontFamily: 'Playfair Display, serif' }}>
            Un solo plan. Todo incluido.
          </h2>
          <p className="text-white/40 text-sm mb-12 max-w-lg mx-auto">
            Sin costos ocultos, sin módulos adicionales de pago. Una suscripción anual con acceso a todas las funcionalidades activas.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            {[
              'Todos los módulos activos incluidos',
              'Soporte técnico prioritario incluido',
              'Actualizaciones y nuevas funciones automáticas',
            ].map(b => (
              <div key={b} className="flex items-start gap-3 text-left p-4
                                      bg-white/[0.02] border border-white/5 rounded-xl">
                <CheckCircle className="w-4 h-4 text-[#deb887] flex-shrink-0 mt-0.5" />
                <span className="text-white/55 text-sm">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA final — gradient-bg ──────────────────────────────────── */}
      <section className="gradient-bg py-24 px-6">
        <div className="base" />
        <div className="glow" />
        <div className="vignette" />
        <div className="scanlines" />
        <div className="content text-center max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-black text-white mb-4 leading-tight"
            style={{ fontFamily: 'Playfair Display, serif' }}>
            Lleva tu clínica al siguiente nivel
          </h2>
          <p className="text-white/45 text-base mb-10">
            Gestión profesional, digital y centralizada para tu práctica estética.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <a href="/gestionestetica/admin/register"
              className="inline-flex items-center gap-2 bg-[#deb887] text-black font-bold
                         px-8 py-4 rounded-full hover:bg-[#c9a876] transition-all
                         hover:shadow-2xl hover:shadow-[#deb887]/30 hover:-translate-y-0.5">
              Registrar mi clínica <ChevronRight className="w-4 h-4" />
            </a>
            <a href="/gestionestetica/admin/login"
              className="inline-flex items-center gap-2 bg-white/5 border border-white/20
                         text-white font-medium px-8 py-4 rounded-full hover:bg-white/10 transition-all">
              Ya tengo cuenta
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="bg-black border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-8 w-auto object-contain opacity-80" />
            <p className="text-xs text-white/25">
              © {new Date().getFullYear()} BIOSKINTECH · RUC 0105872600001 · Ecuador
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5 text-xs text-white/25">
            <a href="/politica-de-privacidad" className="hover:text-[#deb887] transition-colors">
              Política de Privacidad
            </a>
            <a href="/condiciones-de-servicio" className="hover:text-[#deb887] transition-colors">
              Condiciones de Servicio
            </a>
            <a href="/gestionestetica/admin/login" className="hover:text-[#deb887] transition-colors">
              Acceso Clínicas
            </a>
            <a href="/gestionestetica/admin/register" className="hover:text-[#deb887] transition-colors">
              Registro
            </a>
          </div>
        </div>
      </footer>

    </div>
  );
}
