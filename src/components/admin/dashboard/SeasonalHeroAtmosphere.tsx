/**
 * @file src/components/admin/dashboard/SeasonalHeroAtmosphere.tsx
 * @description Capa de ambientación estacional ultra sutil para tarjetas "hero" (reutilizable).
 *
 * Uso: el contenedor padre debe ser `relative overflow-hidden` y su contenido `relative z-10`.
 *   <section className="relative isolate overflow-hidden"> <SeasonalHeroAtmosphere /> ... </section>
 *
 * La variante visual se define por evento en `seasonalEvents.ts` (campo `atmosphere`):
 *  - 'cobweb-spider': telarañas finas en las esquinas.
 *  - 'snow': copos diminutos cayendo lentamente.
 *  - 'stardust': destellos dorados que titilan.
 * La mascota clicable + criatura invocada se configuran con `heroInteraction` (ver SeasonalHeroInteraction.tsx
 * y docs/SEASONAL_EVENTS.md); el nombre del usuario debe llevar `data-hero-name` para ser el destino del vuelo.
 * Solo anima transform/opacity y respeta `prefers-reduced-motion`.
 */

import { useMemo } from 'react';
import SeasonalHeroInteraction from './SeasonalHeroInteraction';
import { motion, useReducedMotion } from 'framer-motion';
import {
  getActiveSeasonalEvent,
  type SeasonalAtmosphereConfig,
  type SeasonalEventConfig,
} from './seasonalEvents';

interface SeasonalHeroAtmosphereProps {
  /** Evento a representar; si se omite se usa el evento activo por fecha */
  event?: SeasonalEventConfig | null;
  className?: string;
}

/* ───────────────────────── Telaraña ───────────────────────── */

const WEB_SIZE = 120;
const WEB_RADIALS = 6; // 0°..90° en pasos de 18°
const WEB_RINGS = [22, 44, 66, 88, 110];

const polar = (r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return [r * Math.cos(rad), r * Math.sin(rad)] as const;
};

/** Geometría de una telaraña de esquina (origen en 0,0). Calculada una sola vez. */
const WEB_PATHS = (() => {
  const step = 90 / (WEB_RADIALS - 1);
  const spokes = Array.from({ length: WEB_RADIALS }, (_, i) => {
    const [x, y] = polar(WEB_SIZE - 2, i * step);
    return `M0 0L${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join('');
  const rings = WEB_RINGS.map(r => {
    let d = '';
    for (let i = 0; i < WEB_RADIALS - 1; i++) {
      const [x1, y1] = polar(r, i * step);
      const [x2, y2] = polar(r, (i + 1) * step);
      const [cx, cy] = polar(r * 0.86, i * step + step / 2); // comba hacia el centro
      d += `${i === 0 ? `M${x1.toFixed(1)} ${y1.toFixed(1)}` : ''}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    return d;
  });
  return { spokes, rings };
})();

function CornerWeb({ color, className }: { color: string; className: string }) {
  return (
    <svg
      viewBox={`0 0 ${WEB_SIZE} ${WEB_SIZE}`}
      className={`pointer-events-none absolute ${className}`}
      fill="none"
      stroke={color}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={WEB_PATHS.spokes} strokeWidth="0.7" />
      {WEB_PATHS.rings.map((d, i) => (
        <path key={i} d={d} strokeWidth="0.6" />
      ))}
    </svg>
  );
}

/* ───────────────────────── Partículas ───────────────────────── */

// Posiciones deterministas (evita saltos entre renders)
const PARTICLES = [
  { x: 8, y: 14, s: 3, d: 0 },
  { x: 22, y: 62, s: 2, d: 1.4 },
  { x: 38, y: 26, s: 2.5, d: 2.6 },
  { x: 55, y: 74, s: 2, d: 0.8 },
  { x: 68, y: 18, s: 3, d: 3.2 },
  { x: 80, y: 56, s: 2, d: 1.9 },
  { x: 91, y: 30, s: 2.5, d: 2.2 },
  { x: 96, y: 78, s: 2, d: 0.4 },
];

function Snow({ color, reduced }: { color: string; reduced: boolean }) {
  return (
    <>
      {PARTICLES.map((p, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full"
          style={{ left: `${p.x}%`, top: -6, width: p.s, height: p.s, background: color, opacity: 0.35 }}
          animate={reduced ? undefined : { y: [0, 150], x: [0, i % 2 ? 8 : -8], opacity: [0, 0.4, 0] }}
          transition={{ duration: 9 + (i % 3) * 2, delay: p.d, repeat: Infinity, ease: 'linear' }}
        />
      ))}
    </>
  );
}

function Stardust({ color, reduced }: { color: string; reduced: boolean }) {
  return (
    <>
      {PARTICLES.map((p, i) => (
        <motion.svg
          key={i}
          viewBox="0 0 10 10"
          className="absolute"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.s * 3.2, height: p.s * 3.2, opacity: 0.25 }}
          animate={reduced ? undefined : { opacity: [0.05, 0.45, 0.05], scale: [0.7, 1, 0.7] }}
          transition={{ duration: 4 + (i % 3), delay: p.d, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden="true"
        >
          <path d="M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z" fill={color} />
        </motion.svg>
      ))}
    </>
  );
}

/* ───────────────────────── Componente ───────────────────────── */

function renderVariant({ variant, color }: SeasonalAtmosphereConfig, reduced: boolean) {
  switch (variant) {
    case 'cobweb-spider':
      return (
        <>
          <CornerWeb color={color} className="right-0 top-0 h-24 w-24 -scale-x-100 opacity-30 sm:h-32 sm:w-32" />
          <CornerWeb color={color} className="bottom-0 left-0 hidden h-20 w-20 -scale-y-100 opacity-[0.16] sm:block" />
        </>
      );
    case 'snow':
      return <Snow color={color} reduced={reduced} />;
    case 'stardust':
      return <Stardust color={color} reduced={reduced} />;
    default:
      return null;
  }
}

export default function SeasonalHeroAtmosphere({ event, className = '' }: SeasonalHeroAtmosphereProps) {
  const reduced = useReducedMotion() ?? false;
  const active = useMemo(() => (event !== undefined ? event : getActiveSeasonalEvent()), [event]);

  if (!active?.atmosphere) return null;

  return (
    <>
      <div
        className={`pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit] ${className}`}
        aria-hidden="true"
      >
        {renderVariant(active.atmosphere, reduced)}
      </div>
      {active.heroInteraction && (
        <SeasonalHeroInteraction config={active.heroInteraction} color={active.atmosphere.color} />
      )}
    </>
  );
}
