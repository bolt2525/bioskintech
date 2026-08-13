import { useEffect, useState } from 'react';
import {
  Sparkles, Activity, Stethoscope, Smile, ChevronRight,
  FileText, CalendarDays, Box, Package, DollarSign,
  Camera, Shield, Users, CheckCircle, X, MessageCircle,
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
    accent: '#c4a882',
  },
  {
    key: 'odonto',
    icon: Smile,
    label: 'Gestión Odontológica',
    description: 'Fichas dentales, radiografías y planes de tratamiento.',
    href: '#',
    status: 'soon' as const,
    accent: '#93b5c8',
  },
  {
    key: 'medgen',
    icon: Stethoscope,
    label: 'Medicina General',
    description: 'Consultas, recetas digitales y seguimiento de pacientes.',
    href: '#',
    status: 'soon' as const,
    accent: '#96ba9a',
  },
  {
    key: 'otros',
    icon: Activity,
    label: 'Otros Servicios',
    description: 'Más especialidades y servicios BIOSKINTECH próximamente.',
    href: '#',
    status: 'soon' as const,
    accent: '#b5a8c4',
  },
];

const FEATURES = [
  {
    icon: FileText,
    title: 'Fichas Clínicas Digitales',
    subtitle: 'Gestión completa de pacientes',
    description: 'Historial médico con antecedentes, diagnósticos, tratamientos, fotografías clínicas y evolución. Todo centralizado y accesible desde cualquier dispositivo.',
    tags: ['Antecedentes', 'Diagnóstico', 'Evolución', 'Fotos'],
    accent: '#c4a882',
    bg: 'linear-gradient(135deg, #1a1208 0%, #0d0a04 100%)',
  },
  {
    icon: Shield,
    title: 'Consentimientos Digitales',
    subtitle: 'Firma electrónica segura',
    description: 'Consentimientos informados que el paciente firma desde su propio dispositivo con enlace único y seguro. Sin papel, con validez legal.',
    tags: ['Firma digital', 'Sin papel', 'Enlace único', 'Legal'],
    accent: '#93b5c8',
    bg: 'linear-gradient(135deg, #081420 0%, #040c14 100%)',
  },
  {
    icon: CalendarDays,
    title: 'Agenda Inteligente',
    subtitle: 'Sincronización Google Calendar',
    description: 'Gestión de citas con integración bidireccional a Google Calendar. Recordatorios por correo, bloqueo de horarios y configuración de disponibilidad.',
    tags: ['Google Cal', 'Email', 'Recordatorios', 'Bloqueos'],
    accent: '#96ba9a',
    bg: 'linear-gradient(135deg, #0a160c 0%, #050d07 100%)',
  },
  {
    icon: Package,
    title: 'Inventario y Stock',
    subtitle: 'Control de productos y lotes',
    description: 'Gestión de inventario con control por lotes, fechas de vencimiento, alertas automáticas y movimientos vinculados a cada tratamiento aplicado.',
    tags: ['Lotes', 'Vencimientos', 'Alertas', 'Movimientos'],
    accent: '#c4b09a',
    bg: 'linear-gradient(135deg, #1a1008 0%, #0d0a04 100%)',
  },
  {
    icon: DollarSign,
    title: 'Finanzas y Reportes',
    subtitle: 'Control financiero completo',
    description: 'Registro de ingresos y egresos, análisis de rentabilidad por tratamiento, reportes mensuales y exportación de datos financieros de tu clínica.',
    tags: ['Ingresos', 'Egresos', 'Reportes', 'Análisis'],
    accent: '#a0ba98',
    bg: 'linear-gradient(135deg, #0a160a 0%, #050d05 100%)',
  },
  {
    icon: Box,
    title: 'Herramientas 3D Clínicas',
    subtitle: 'DermoAtlas y Mapeo Facial',
    description: 'DermoAtlas 3D para explorar capas anatómicas de la piel, y mapeo facial tridimensional para registrar puntos de inyección, trazar líneas de referencia y capturar el procedimiento desde múltiples ángulos.',
    tags: ['DermoAtlas', 'Mapeo 3D', 'Inyectables', 'Capturas'],
    accent: '#90bab8',
    bg: 'linear-gradient(135deg, #081618 0%, #040c0d 100%)',
  },
  {
    icon: Camera,
    title: 'Galería Clínica',
    subtitle: 'Fotos antes/después + comparación',
    description: 'Galería fotográfica por paciente con categorías (antes, después, diagnóstico, progreso). Modo comparación lado a lado con zoom sincronizado y navegación por línea de tiempo.',
    tags: ['Antes/Después', 'Comparación', 'Zoom', 'Timeline'],
    accent: '#b8a0c4',
    bg: 'linear-gradient(135deg, #100a18 0%, #0a060f 100%)',
  },
  {
    icon: Users,
    title: 'Multi-Clínica y Roles',
    subtitle: 'Escalable y seguro',
    description: 'Arquitectura multi-tenant con roles diferenciados: administrador y colaboradores. Datos completamente aislados entre clínicas.',
    tags: ['Multi-sede', 'Roles', 'Aislamiento', 'Permisos'],
    accent: '#b8a0b8',
    bg: 'linear-gradient(135deg, #150a15 0%, #0d050d 100%)',
  },
];

const GALLERY_ITEMS = [
  { file: 'panelPrincipal.jpg',        label: 'Panel Principal',       grad: 'from-amber-900/50 to-[#070b14]',   icon: Sparkles },
  { file: 'fichaClinica.jpg',          label: 'Ficha Clínica',          grad: 'from-amber-800/40 to-[#070b14]',   icon: FileText },
  { file: 'mapeo3Dfacial.jpg',         label: 'Mapeo 3D Facial',        grad: 'from-cyan-900/50 to-[#070b14]',    icon: Box },
  { file: 'agendamiento.jpg',          label: 'Agendamiento',           grad: 'from-emerald-900/50 to-[#070b14]', icon: CalendarDays },
  { file: 'comparacionFotos.jpg',      label: 'Comparación de Fotos',   grad: 'from-violet-900/50 to-[#070b14]',  icon: Camera },
  { file: 'inventario.jpg',            label: 'Inventario',             grad: 'from-orange-900/50 to-[#070b14]',  icon: Package },
  { file: 'finanzas.jpg',              label: 'Finanzas',               grad: 'from-green-900/50 to-[#070b14]',   icon: DollarSign },
  { file: 'consentimientoInformado.jpg', label: 'Consentimiento Informado', grad: 'from-blue-900/50 to-[#070b14]', icon: Shield },
];

const WA_NUMBER = '593984232889';
const WA_DEMO_LINK = `https://wa.me/${WA_NUMBER}?text=Hola%2C%20quisiera%20solicitar%20una%20demo%20gratuita%20de%20BIOSKINTECH%20%F0%9F%8C%9F`;

function ServiceModal({ mode, onClose }: { mode: 'login' | 'register' | null; onClose: () => void }) {
  if (!mode) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" />
      <div className="relative w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="glass-card rounded-3xl overflow-hidden shadow-2xl">
          <div className="h-0.5 bg-gradient-to-r from-[#c4a882] via-[#d8c4a8] to-[#c4a882]" />
          <div className="p-7">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-white">
                  {mode === 'login' ? 'Acceder al panel' : 'Registrar mi clínica'}
                </h3>
                <p className="text-white/40 text-xs mt-0.5">Selecciona tu especialidad</p>
              </div>
              <button onClick={onClose}
                className="text-white/25 hover:text-white/70 transition-colors mt-0.5">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {MODULES.map(mod => {
                const Icon = mod.icon;
                const active = mod.status === 'active';
                const href = active
                  ? (mode === 'login' ? mod.href : mod.href.replace('/login', '/register'))
                  : '#';
                return (
                  <a
                    key={mod.key}
                    href={href}
                    onClick={active ? undefined : e => e.preventDefault()}
                    className={`relative flex flex-col gap-3 p-4 rounded-2xl border transition-all duration-300 ${
                      active
                        ? 'border-[#c4a882]/25 bg-white/[0.03] hover:bg-white/[0.07] hover:border-[#c4a882]/55 cursor-pointer'
                        : 'border-white/5 bg-white/[0.015] opacity-35 cursor-default'
                    }`}
                  >
                    <span className={`absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                      active ? 'text-green-400 bg-green-400/10' : 'text-white/25 bg-white/5'
                    }`}>
                      {active ? 'Activo' : 'Próximo'}
                    </span>
                    <div style={{ color: mod.accent }}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white leading-tight">{mod.label}</p>
                      <p className="text-[11px] text-white/30 mt-0.5 leading-snug">{mod.description}</p>
                    </div>
                  </a>
                );
              })}
            </div>

            <p className="text-center text-xs text-white/25 mt-5">
              {mode === 'login' ? '¿Sin cuenta? ' : '¿Ya tienes cuenta? '}
              <button
                onClick={() => onClose()}
                className="text-[#c4a882] hover:underline font-medium">
                <a href={mode === 'login' ? '/gestionestetica/admin/register' : '/gestionestetica/admin/login'}>
                  {mode === 'login' ? 'Registrar clínica' : 'Iniciar sesión'}
                </a>
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  const [modalMode, setModalMode] = useState<'login' | 'register' | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="bg-[#070b14] text-white">
      <ServiceModal mode={modalMode} onClose={() => setModalMode(null)} />

      {/* ── Header fijo ─────────────────────────────────────────────── */}
      <header className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'bg-[#070b14]/92 backdrop-blur-md border-b border-[#c4a882]/15 shadow-xl shadow-black/50'
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
              className="text-sm font-semibold bg-[#c4a882] text-black px-5 py-2 rounded-full
                         hover:bg-[#b09878] transition-all shadow-lg shadow-[#c4a882]/20 hover:shadow-[#c4a882]/40">
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
          <div className="inline-flex items-center gap-2 bg-[#c4a882]/10 border border-[#c4a882]/25
                          rounded-full px-4 py-1.5 text-sm text-[#c4a882] font-medium mb-10 backdrop-blur-sm">
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
            <span className="text-[#c4a882] font-semibold">Gestión Clínica Inteligente</span>
          </p>
          <p className="text-white/40 text-sm md:text-base max-w-lg leading-relaxed mb-12">
            Administra fichas de pacientes, agenda, consentimientos digitales,
            inventario y finanzas de tu clínica estética desde un único lugar seguro.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap items-center justify-center gap-4 mb-16">
            <button
              onClick={() => setModalMode('login')}
              className="inline-flex items-center gap-2 bg-[#c4a882] text-black font-bold
                         px-8 py-3.5 rounded-full hover:bg-[#b09878] transition-all
                         hover:shadow-2xl hover:shadow-[#c4a882]/30 hover:-translate-y-0.5 text-sm">
              Acceder al panel <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setModalMode('register')}
              className="inline-flex items-center gap-2 bg-white/5 border border-white/20 text-white
                         font-medium px-8 py-3.5 rounded-full hover:bg-white/10 transition-all
                         text-sm backdrop-blur-sm">
              Registrar mi clínica
            </button>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-8 pt-8 border-t border-white/8">
            {[
              { value: '8+', label: 'Módulos integrados' },
              { value: '100%', label: 'Digital y sin papel' },
              { value: '2FA', label: 'Acceso seguro' },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className="text-2xl font-bold text-[#c4a882]">{s.value}</div>
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
      <section className="bg-[#080e1c] py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[#c4a882] text-xs font-bold uppercase tracking-[0.2em] mb-3">
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
            <p className="text-[#c4a882] text-xs font-bold uppercase tracking-[0.2em] mb-3">
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

      {/* ── Galería circular ──────────────────────────────────────────── */}
      <section className="bg-[#07091a] py-20 overflow-hidden border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6 mb-10">
          <p className="text-[#c4a882] text-xs font-bold uppercase tracking-[0.2em] mb-3">Galería</p>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-2"
            style={{ fontFamily: 'Playfair Display, serif' }}>
            El software en acción
          </h2>
        </div>
        <div className="overflow-hidden">
          <div className="gallery-track">
            {[...GALLERY_ITEMS, ...GALLERY_ITEMS].map((item, idx) => {
              const Icon = item.icon;
              return (
                <div key={`${item.file}-${idx}`} className="gallery-card">
                  <div className={`absolute inset-0 bg-gradient-to-br ${item.grad} flex items-center justify-center`}>
                    <Icon className="w-14 h-14 text-white/10" />
                  </div>
                  <img
                    src={`/images/gallery/${item.file}`}
                    alt={item.label}
                    className="absolute inset-0 w-full h-full object-cover object-top"
                  />
                  {/* Title overlay at bottom */}
                  <div className="absolute bottom-0 inset-x-0 px-4 py-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
                    <p className="text-white text-sm font-semibold leading-tight">{item.label}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Beneficios ────────────────────────────────────────────────── */}
      <section className="bg-[#080e1c] py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-[#c4a882] text-xs font-bold uppercase tracking-[0.2em] mb-3">Plan único</p>
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
                <CheckCircle className="w-4 h-4 text-[#c4a882] flex-shrink-0 mt-0.5" />
                <span className="text-white/55 text-sm">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Demo / Cuenta de prueba ─────────────────────────────────────── */}
      <section className="bg-[#060912] py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-[#90bab8] text-xs font-bold uppercase tracking-[0.2em] mb-3">
            Sin compromiso
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4"
            style={{ fontFamily: 'Playfair Display, serif' }}>
            Solicita una demo gratuita
          </h2>
          <p className="text-white/40 text-sm mb-8 max-w-lg mx-auto leading-relaxed">
            Prueba todas las funcionalidades de BIOSKINTECH sin compromiso.
            Te configuramos un entorno de demo con datos de ejemplo para que explores el sistema a tu ritmo.
          </p>
          <a
            href={WA_DEMO_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 bg-[#25d366] text-white font-bold
                       px-8 py-4 rounded-full hover:bg-[#1eb558] transition-all
                       hover:shadow-2xl hover:shadow-[#25d366]/25 hover:-translate-y-0.5 text-sm">
            <MessageCircle className="w-5 h-5" />
            Solicitar demo por WhatsApp
          </a>
          <p className="text-white/20 text-xs mt-4">
            Respondemos en horario de atención · Sin datos de tarjeta requeridos
          </p>
        </div>
      </section>

      {/* ── CTA final ───────────────────────────────────────────────────── */}
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
            <button
              onClick={() => setModalMode('register')}
              className="inline-flex items-center gap-2 bg-[#c4a882] text-black font-bold
                         px-8 py-4 rounded-full hover:bg-[#b09878] transition-all
                         hover:shadow-2xl hover:shadow-[#c4a882]/30 hover:-translate-y-0.5">
              Registrar mi clínica <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setModalMode('login')}
              className="inline-flex items-center gap-2 bg-white/5 border border-white/20
                         text-white font-medium px-8 py-4 rounded-full hover:bg-white/10 transition-all">
              Ya tengo cuenta
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="bg-[#050810] border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-8 w-auto object-contain opacity-80" />
            <p className="text-xs text-white/25">
              © {new Date().getFullYear()} BIOSKINTECH · Ecuador
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5 text-xs text-white/25">
            <a href="/politica-de-privacidad" className="hover:text-[#c4a882] transition-colors">
              Política de Privacidad
            </a>
            <a href="/condiciones-de-servicio" className="hover:text-[#c4a882] transition-colors">
              Condiciones de Servicio
            </a>
            <a href="/gestionestetica/admin/login" className="hover:text-[#c4a882] transition-colors">
              Acceso Clínicas
            </a>
            <a href="/gestionestetica/admin/register" className="hover:text-[#c4a882] transition-colors">
              Registro
            </a>
          </div>
        </div>
      </footer>

    </div>
  );
}
