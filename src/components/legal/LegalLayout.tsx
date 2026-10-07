import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import BrandLogo from '../ui/BrandLogo';

export const LEGAL_CONTACT_EMAIL = 'soporte-tecnico@bioskintechapp.com';
export const LEGAL_WHATSAPP = '+593 984 232 889';
// Debe coincidir con LEGAL_VERSION de api/admin-auth.js; cambiarla obliga a todos los usuarios a re-aceptar.
export const LEGAL_VERSION = '2026-10-06-r2';
export const LEGAL_UPDATED_LABEL = '6 de octubre de 2026';

export function LegalSection({ number, title, icon, children }: { number: number; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gold/15 overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-[#fdf8f0] to-white">
        <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center flex-shrink-0 text-white">{icon}</div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-bold text-gold uppercase tracking-wider">Art. {number}</span>
          <h2 className="font-semibold text-gray-800 text-sm sm:text-base">{title}</h2>
        </div>
      </div>
      <div className="px-6 py-5 text-sm text-gray-700 leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export function LegalShell({ title, icon, intro, children, footer, embedded = false }: { title: string; icon: ReactNode; intro: ReactNode; children: ReactNode; footer: ReactNode; embedded?: boolean }) {
  if (embedded) {
    return (
      <section className="legal-print-copy">
        <header className="border-b border-gray-300 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8b6945]">BIOSKINTECH · Documento integrante</p>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">{title}</h2>
          <p className="mt-1 text-xs text-gray-600">Versión {LEGAL_VERSION} · Vigente desde el {LEGAL_UPDATED_LABEL}</p>
          <div className="mt-4 space-y-3 text-sm leading-relaxed text-gray-700">{intro}</div>
        </header>
        <div className="mt-6 space-y-5">{children}</div>
        <footer className="mt-6 border-t border-gray-300 pt-4 text-xs text-gray-600">{footer}</footer>
      </section>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea]">
      <header className="sticky top-0 bg-white/90 backdrop-blur border-b border-gold/20 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
          <button onClick={() => window.history.back()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gold transition-colors font-medium">
            <ArrowLeft className="w-4 h-4" /><span className="hidden sm:inline">Volver</span>
          </button>
          <div className="flex items-center gap-3 flex-1"><BrandLogo className="h-10 w-auto object-contain" compact /></div>
          <span className="text-xs text-gray-400 hidden sm:block">Versión {LEGAL_VERSION}</span>
        </div>
      </header>
      <main className="relative max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-5 pb-16">
        <div className="bg-white rounded-2xl shadow-sm border border-gold/20 p-6 sm:p-8">
          <div className="flex items-start gap-4 mb-5">
            <div className="w-14 h-14 bg-gold rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md text-white">{icon}</div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900" style={{ fontFamily: 'Playfair Display, serif' }}>{title}</h1>
              <p className="text-gray-400 text-xs sm:text-sm mt-1.5">Plataforma BIOSKINTECH · Versión {LEGAL_VERSION} · Vigente desde el {LEGAL_UPDATED_LABEL}</p>
            </div>
          </div>
          <div className="text-gray-600 leading-relaxed text-sm sm:text-base space-y-3">{intro}</div>
        </div>
        {children}
        <div className="text-center text-xs text-gray-400 pt-4 space-y-1">
          <p>BioSkinTech © {new Date().getFullYear()} · Ecuador</p>
          {footer}
        </div>
      </main>
    </div>
  );
}

export const Mail = () => <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="text-gold-dark font-semibold hover:underline">{LEGAL_CONTACT_EMAIL}</a>;

export function ContactChannels() {
  return (
    <ul className="list-disc list-inside space-y-1 pl-1">
      <li>Correo de soporte: <Mail /></li>
      <li>WhatsApp oficial: <a href={`https://wa.me/${LEGAL_WHATSAPP.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="text-gold-dark font-semibold hover:underline">{LEGAL_WHATSAPP}</a></li>
      <li>Sitio web: <a href="https://bioskintechapp.com" className="text-gold-dark font-semibold hover:underline">bioskintechapp.com</a> y avisos dentro del panel</li>
    </ul>
  );
}

export function Note({ tone = 'gold', children }: { tone?: 'gold' | 'amber' | 'blue' | 'green' | 'red'; children: ReactNode }) {
  const styles = {
    gold: 'bg-[#fdf8f0] border-gold/25 text-gray-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    red: 'bg-red-50 border-red-200 text-red-800',
  }[tone];
  return <div className={`rounded-xl border p-3 text-xs leading-relaxed ${styles}`}>{children}</div>;
}
