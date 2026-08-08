/**
 * @file src/pages/LandingPage.tsx
 * @description Página principal de bioskintechapp.com
 * Punto de entrada global — muestra las líneas de gestión disponibles.
 */

import { Sparkles, Activity, Stethoscope, Smile, ExternalLink } from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';

const MODULES = [
  {
    key: 'estetica',
    icon: Sparkles,
    label: 'Gestión Estética',
    description: 'Panel administrativo para clínicas de medicina estética y cosmética.',
    href: '/gestionestetica/admin/login',
    status: 'active' as const,
    color: 'from-[#deb887] to-[#c9a876]',
    bg: 'bg-[#fdf8f0]',
    border: 'border-[#deb887]/30',
  },
  {
    key: 'odonto',
    icon: Smile,
    label: 'Gestión Odontológica',
    description: 'Próximamente — fichas dentales, radiografías y planes de tratamiento.',
    href: '#',
    status: 'soon' as const,
    color: 'from-blue-400 to-blue-600',
    bg: 'bg-blue-50',
    border: 'border-blue-100',
  },
  {
    key: 'medgen',
    icon: Stethoscope,
    label: 'Medicina General',
    description: 'Próximamente — consultas, recetas y seguimiento de pacientes.',
    href: '#',
    status: 'soon' as const,
    color: 'from-emerald-400 to-emerald-600',
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
  },
  {
    key: 'otros',
    icon: Activity,
    label: 'Otros Servicios',
    description: 'Próximamente — más especialidades y servicios BIOSKINTECH.',
    href: '#',
    status: 'soon' as const,
    color: 'from-purple-400 to-purple-600',
    bg: 'bg-purple-50',
    border: 'border-purple-100',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea]">

      {/* Header */}
      <header className="border-b border-[#deb887]/20 bg-white/70 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-10 w-auto object-contain" />
            <span className="font-bold text-gray-900 tracking-tight hidden sm:inline" style={{ fontFamily: 'Playfair Display, serif' }}>BIOSKINTECH</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-16 text-center">
        <div className="inline-flex items-center gap-2 bg-[#deb887]/10 border border-[#deb887]/30 rounded-full px-4 py-1.5 text-sm text-[#c9a876] font-medium mb-6">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          Plataforma activa
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-3 leading-tight" style={{ fontFamily: 'Playfair Display, serif' }}>
          <span className="text-[#deb887]">BIOSKINTECH</span>
        </h1>
        <p className="text-gray-600 text-xl font-medium mb-4">
          Plataforma de Gestión Clínica Inteligente
        </p>
        <p className="text-gray-500 text-base max-w-2xl mx-auto leading-relaxed">
          <strong>BIOSKINTECH</strong> es un panel de administración web para profesionales de la salud y la estética médica.
          Permite gestionar fichas clínicas de pacientes, agenda de citas, consentimientos informados digitales,
          inventario, finanzas y más — todo desde un entorno seguro y centralizado.
          Elige tu área de práctica para acceder al panel correspondiente.
        </p>
      </section>

      {/* Módulos */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {MODULES.map(mod => {
            const Icon = mod.icon;
            const isActive = mod.status === 'active';
            return (
              <a
                key={mod.key}
                href={mod.href}
                className={`group relative flex flex-col gap-4 p-6 rounded-2xl border-2 ${mod.bg} ${mod.border} transition-all duration-200 ${
                  isActive
                    ? 'hover:shadow-lg hover:shadow-[#deb887]/20 hover:-translate-y-1 cursor-pointer'
                    : 'opacity-70 cursor-default'
                }`}
                onClick={isActive ? undefined : e => e.preventDefault()}
              >
                {/* Badge */}
                {isActive ? (
                  <span className="absolute top-4 right-4 text-[10px] font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Activo</span>
                ) : (
                  <span className="absolute top-4 right-4 text-[10px] font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Próximo</span>
                )}

                {/* Icono */}
                <div className={`w-12 h-12 bg-gradient-to-br ${mod.color} rounded-xl flex items-center justify-center shadow-md`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>

                {/* Texto */}
                <div>
                  <h3 className="text-base font-semibold text-gray-900 mb-1">{mod.label}</h3>
                  <p className="text-sm text-gray-500 leading-relaxed">{mod.description}</p>
                </div>

                {/* Flecha */}
                {isActive && (
                  <div className="flex items-center gap-1 text-sm font-medium text-[#deb887] mt-auto group-hover:gap-2 transition-all">
                    Ingresar <ExternalLink className="w-3.5 h-3.5" />
                  </div>
                )}
              </a>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 bg-white/50">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-gray-400">
            © {new Date().getFullYear()} BIOSKINTECH · Todos los derechos reservados
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 text-sm text-gray-400">
            <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="hover:text-[#deb887] transition-colors">Política de Privacidad</a>
            <a href="/condiciones-de-servicio" target="_blank" rel="noopener noreferrer" className="hover:text-[#deb887] transition-colors">Condiciones de Servicio</a>
            <a href="/gestionestetica/admin/login" className="hover:text-[#deb887] transition-colors">Acceso Clínicas</a>
            <a href="/gestionestetica/admin/register" className="hover:text-[#deb887] transition-colors">Registro</a>
          </div>
        </div>
      </footer>

    </div>
  );
}
