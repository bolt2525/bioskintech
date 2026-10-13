/**
 * @file src/components/admin/dashboard/SeasonalHeroInteraction.tsx
 * @description Interacción lúdica reutilizable del hero: una MASCOTA en la esquina que, al hacer clic
 * ("aplastarla"), invoca una CRIATURA/OBJETO (`summon`) que vuela con curva orgánica hacia el nombre
 * del usuario y se posa sobre él un momento.
 *
 * Todo se declara en `seasonalEvents.ts` → `heroInteraction`. Para un evento nuevo basta con elegir
 * `mascot` y `summon` de los registros de abajo (MASCOTS / SUMMONS). Ver docs/SEASONAL_EVENTS.md.
 *
 * Reglas del contrato:
 *  - El destino del vuelo es el elemento con `data-hero-name` dentro del mismo hero (fallback: esquina izquierda).
 *  - Se monta en una capa `pointer-events-none`; solo la mascota recibe eventos.
 *  - Respeta `prefers-reduced-motion`: sin vuelo, la criatura aparece directamente posada y se desvanece.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { HeroInteractionConfig, HeroMascotKind, HeroSummonKind } from './seasonalEvents';

/* ───────────────────────── Mascotas ───────────────────────── */

const THREAD_LENGTH = 54;
const IDLE_DROP = 12;

interface MascotProps {
  color: string;
  reduced: boolean;
  squashed: boolean;
  label: string;
  hint: string;
  onActivate: (rect: DOMRect) => void;
}

/** Arañita colgando de un hilo. Se aplasta (scaleY) al hacer clic. */
function SpiderMascot({ color, reduced, squashed, label, hint, onActivate }: MascotProps) {
  const [hovered, setHovered] = useState(false);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const breathing = reduced
    ? { duration: 0 }
    : { duration: 5, ease: 'easeInOut' as const, repeat: Infinity, repeatType: 'mirror' as const };
  const threadScale = reduced ? 1 : [1, (THREAD_LENGTH + IDLE_DROP) / THREAD_LENGTH];

  return (
    <motion.div
      className="absolute right-12 top-0 origin-top sm:right-24"
      style={{ width: 22, height: THREAD_LENGTH + 40 }}
      animate={reduced ? undefined : { rotate: [-2.2, 2.2] }}
      transition={{ duration: 6, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
    >
      <motion.div
        className="mx-auto origin-top"
        aria-hidden="true"
        style={{ width: 1, height: THREAD_LENGTH, background: `linear-gradient(${color}00, ${color}b0)` }}
        animate={{ scaleY: threadScale }}
        transition={breathing}
      />
      <motion.div
        className="absolute left-0"
        style={{ top: THREAD_LENGTH - 2, width: 22 }}
        animate={{ y: reduced ? 0 : [0, IDLE_DROP] }}
        transition={breathing}
      >
        <motion.button
          ref={bodyRef}
          type="button"
          title={hint}
          aria-label={label}
          onClick={() => bodyRef.current && onActivate(bodyRef.current.getBoundingClientRect())}
          onHoverStart={() => setHovered(true)}
          onHoverEnd={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          className="pointer-events-auto relative block cursor-pointer rounded-full p-1 -m-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#deb887]"
          style={{ transformOrigin: '50% 100%' }}
          animate={squashed ? { scaleY: 0.3, scaleX: 1.35 } : { scaleY: hovered ? 1.12 : 1, scaleX: hovered ? 1.12 : 1 }}
          transition={{ duration: squashed ? 0.12 : 0.3, ease: 'easeOut' }}
        >
          <svg viewBox="0 0 24 22" width="22" height="20" aria-hidden="true">
            <g stroke={color} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.9">
              <path d="M9.5 9 L4 5 L1.5 8" />
              <path d="M9.5 10.5 L3 11 L1 15" />
              <path d="M10 12 L4.5 16 L3.5 20" />
              <path d="M11 13 L8.5 18 L8.5 21" />
              <path d="M14.5 9 L20 5 L22.5 8" />
              <path d="M14.5 10.5 L21 11 L23 15" />
              <path d="M14 12 L19.5 16 L20.5 20" />
              <path d="M13 13 L15.5 18 L15.5 21" />
            </g>
            <ellipse cx="12" cy="14" rx="3.6" ry="4.4" fill={color} opacity="0.75" />
            <circle cx="12" cy="8.6" r="2.7" fill={color} opacity="0.9" />
            <circle cx="11" cy="8.2" r="0.6" fill="#fff" opacity="0.9" />
            <circle cx="13" cy="8.2" r="0.6" fill="#fff" opacity="0.9" />
          </svg>
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute right-full top-1/2 mr-1.5 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
            style={{ background: `${color}` }}
            initial={false}
            animate={{ opacity: hovered && !squashed ? 0.9 : 0, x: hovered ? 0 : 4 }}
            transition={{ duration: 0.2 }}
          >
            {hint}
          </motion.span>
        </motion.button>
      </motion.div>
    </motion.div>
  );
}

/** Registro de mascotas. Agregar una nueva = componente con `MascotProps` + entrada aquí + tipo en seasonalEvents.ts */
const MASCOTS: Record<HeroMascotKind, (props: MascotProps) => ReactElement> = {
  spider: SpiderMascot,
};

/* ───────────────────────── Criaturas invocadas ───────────────────────── */

const SUMMON_SIZE = 30;

function GhostSprite({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 32 36" width={SUMMON_SIZE} height={SUMMON_SIZE * 1.125} aria-hidden="true">
      <ellipse cx="16" cy="34" rx="8" ry="1.6" fill="#000" opacity="0.12" />
      <path
        d="M16 2C8.5 2 4 7.6 4 14.5V30c0 1 1 1.500 1.800.800l2.700-2.400 2.800 2.600c.600.500 1.400.500 2 0L16 28.700l2.700 2.300c.600.500 1.400.500 2 0l2.800-2.600 2.700 2.400c.800.700 1.800.200 1.800-.800V14.500C28 7.600 23.500 2 16 2Z"
        fill="#fbfaff"
        stroke={color}
        strokeWidth="1"
        opacity="0.96"
      />
      <ellipse cx="12" cy="14" rx="2" ry="2.8" fill="#2b1b45" />
      <ellipse cx="20" cy="14" rx="2" ry="2.8" fill="#2b1b45" />
      <circle cx="12.700" cy="13" r="0.7" fill="#fff" />
      <circle cx="20.700" cy="13" r="0.7" fill="#fff" />
      <ellipse cx="16" cy="19.500" rx="1.800" ry="2.200" fill="#2b1b45" opacity="0.8" />
      <ellipse cx="8.500" cy="18" rx="2" ry="1.200" fill="#f9a8d4" opacity="0.5" />
      <ellipse cx="23.500" cy="18" rx="2" ry="1.200" fill="#f9a8d4" opacity="0.5" />
    </svg>
  );
}

function SkullSprite({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 32 36" width={SUMMON_SIZE} height={SUMMON_SIZE * 1.125} aria-hidden="true">
      <ellipse cx="16" cy="34" rx="8" ry="1.6" fill="#000" opacity="0.12" />
      <path
        d="M16 3C9 3 4.500 7.800 4.500 14c0 4 1.800 6.600 4.500 8v4.500c0 1 .8 1.800 1.800 1.800h10.400c1 0 1.800-.8 1.800-1.800V22c2.700-1.400 4.500-4 4.500-8C27.500 7.800 23 3 16 3Z"
        fill="#fbf7ee"
        stroke={color}
        strokeWidth="1"
      />
      <circle cx="11.500" cy="14.500" r="3.200" fill="#2b1b45" />
      <circle cx="20.500" cy="14.500" r="3.200" fill="#2b1b45" />
      <circle cx="11.500" cy="14.500" r="1.200" fill="#fb923c" />
      <circle cx="20.500" cy="14.500" r="1.200" fill="#fb923c" />
      <path d="M16 18.500 14.500 21.500h3Z" fill="#2b1b45" />
      <path d="M12.500 26v-2.500M16 26v-2.500M19.500 26v-2.500" stroke="#2b1b45" strokeWidth="0.9" />
    </svg>
  );
}

/** Registro de criaturas invocadas. Agregar una nueva = sprite SVG + entrada aquí + tipo en seasonalEvents.ts */
const SUMMONS: Record<HeroSummonKind, (props: { color: string }) => ReactElement> = {
  ghost: GhostSprite,
  skull: SkullSprite,
};

/* ───────────────────────── Orquestación ───────────────────────── */

type Phase = 'flying' | 'perched' | 'leaving';

interface Flight {
  id: number;
  phase: Phase;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

const FALLBACK_TARGET = { x: 80, y: 25 };
const FLIGHT_SECONDS = 2.4;
const SQUASH_MS = 380;
const TRAIL = [0.14, 0.28, 0.42];

interface SeasonalHeroInteractionProps {
  config: HeroInteractionConfig;
  color: string;
}

export default function SeasonalHeroInteraction({ config, color }: SeasonalHeroInteractionProps) {
  const reduced = useReducedMotion() ?? false;
  const layerRef = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [squashed, setSquashed] = useState(false);
  const idRef = useRef(0);
  const timers = useRef<number[]>([]);
  const perchMs = config.perchMs ?? 4500;

  const schedule = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(window.clearTimeout);
  }, []);

  const handleActivate = useCallback(
    (mascotRect: DOMRect) => {
      const layer = layerRef.current;
      if (!layer) return;
      const layerRect = layer.getBoundingClientRect();
      const nameEl = layer.parentElement?.querySelector<HTMLElement>('[data-hero-name]');
      const nameRect = nameEl?.getBoundingClientRect();

      const half = SUMMON_SIZE / 2;
      const from = {
        x: mascotRect.left - layerRect.left + mascotRect.width / 2 - half,
        y: mascotRect.top - layerRect.top - 4,
      };
      // Se posa justo encima del centro del nombre
      const to = nameRect
        ? {
            x: nameRect.left - layerRect.left + nameRect.width / 2 - half,
            y: Math.max(2, nameRect.top - layerRect.top - SUMMON_SIZE * 0.8),
          }
        : FALLBACK_TARGET;

      timers.current.forEach(window.clearTimeout);
      timers.current = [];
      const id = ++idRef.current;
      setSquashed(true);
      schedule(() => setSquashed(false), SQUASH_MS);
      setFlight({ id, phase: reduced ? 'perched' : 'flying', from, to });
      if (reduced) {
        schedule(() => setFlight(f => (f?.id === id ? { ...f, phase: 'leaving' } : f)), perchMs);
        schedule(() => setFlight(f => (f?.id === id ? null : f)), perchMs + 700);
      }
    },
    [perchMs, reduced, schedule],
  );

  const handleLanded = useCallback(
    (id: number) => {
      setFlight(f => (f?.id === id ? { ...f, phase: 'perched' } : f));
      schedule(() => setFlight(f => (f?.id === id ? { ...f, phase: 'leaving' } : f)), perchMs);
      schedule(() => setFlight(f => (f?.id === id ? null : f)), perchMs + 700);
    },
    [perchMs, schedule],
  );

  const Mascot = MASCOTS[config.mascot];
  const Summon = SUMMONS[config.summon];

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[inherit]">
      <Mascot
        color={color}
        reduced={reduced}
        squashed={squashed}
        label={config.ariaLabel}
        hint={config.hint}
        onActivate={handleActivate}
      />

      {flight && (
        <>
          {/* "Puf" de humo en el punto de origen */}
          {!reduced &&
            [-1, 0, 1].map(n => (
              <motion.span
                key={`${flight.id}-puff-${n}`}
                aria-hidden="true"
                className="absolute rounded-full"
                style={{ left: flight.from.x + SUMMON_SIZE / 2 - 5, top: flight.from.y + 10, width: 10, height: 10, background: `${color}90` }}
                initial={{ opacity: 0.7, scale: 0.4, x: 0, y: 0 }}
                animate={{ opacity: 0, scale: 2.2, x: n * 14, y: -10 - Math.abs(n) * 4 }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
              />
            ))}

          {/* Estela de destellos (copias tenues con retraso) */}
          {!reduced &&
            flight.phase === 'flying' &&
            TRAIL.map((delay, i) => (
              <FlyingSprite key={`${flight.id}-trail-${i}`} flight={flight} delay={delay} trail>
                <span
                  aria-hidden="true"
                  className="block rounded-full"
                  style={{ width: 8 - i * 1.5, height: 8 - i * 1.5, marginLeft: 11, marginTop: 20, background: '#fff', boxShadow: `0 0 8px 2px ${color}` }}
                />
              </FlyingSprite>
            ))}

          <FlyingSprite flight={flight} reduced={reduced} onLanded={() => handleLanded(flight.id)}>
            <motion.div
              animate={
                flight.phase === 'leaving'
                  ? { opacity: 0, y: -8 }
                  : flight.phase === 'perched' && !reduced
                    ? { opacity: 1, y: [0, -4] }
                    : { opacity: 1, y: 0 }
              }
              transition={
                flight.phase === 'perched' && !reduced
                  ? { duration: 1.4, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }
                  : { duration: 0.6 }
              }
              style={{ filter: `drop-shadow(0 0 6px ${color}aa)` }}
            >
              <Summon color={color} />
            </motion.div>
          </FlyingSprite>
        </>
      )}
    </div>
  );
}

/* ───────────────────────── Trayectoria ───────────────────────── */

interface FlyingSpriteProps {
  flight: Flight;
  children: React.ReactNode;
  reduced?: boolean;
  trail?: boolean;
  delay?: number;
  onLanded?: () => void;
}

/** Mueve a su hijo del origen al destino con una curva (arco con ondulación) usando solo transform. */
function FlyingSprite({ flight, children, reduced = false, trail = false, delay = 0, onLanded }: FlyingSpriteProps) {
  const { from, to } = flight;
  const dy = Math.max(30, Math.abs(to.x - from.x) * 0.12);
  const xs = [from.x, from.x + (to.x - from.x) * 0.35, from.x + (to.x - from.x) * 0.7, to.x];
  const ys = [from.y, from.y + dy, to.y - dy * 0.6, to.y];

  if (reduced) {
    return (
      <div className="absolute left-0 top-0" style={{ transform: `translate(${to.x}px, ${to.y}px)` }}>
        {children}
      </div>
    );
  }

  const landed = flight.phase !== 'flying';
  return (
    <motion.div
      className="absolute left-0 top-0 will-change-transform"
      initial={{ x: from.x, y: from.y, opacity: 0, scale: 0.4 }}
      animate={
        trail
          ? { x: xs, y: ys, opacity: [0, 0.8, 0.8, 0], scale: 1 }
          : { x: landed ? to.x : xs, y: landed ? to.y : ys, opacity: 1, scale: 1 }
      }
      transition={{
        delay,
        x: { duration: FLIGHT_SECONDS, ease: 'easeInOut', times: [0, 0.35, 0.7, 1] },
        y: { duration: FLIGHT_SECONDS, ease: 'easeInOut', times: [0, 0.35, 0.7, 1] },
        opacity: { duration: trail ? FLIGHT_SECONDS : 0.3 },
        scale: { duration: 0.4, ease: 'backOut' },
      }}
      onAnimationComplete={trail || landed ? undefined : onLanded}
    >
      {children}
    </motion.div>
  );
}
