/**
 * @file src/components/admin/dashboard/SeasonalBrandDongle.tsx
 * @description Dongle estacional interactivo integrado directamente en el contenedor del nombre e ícono de la clínica.
 *
 * En lugar de ocupar espacio como un banner independiente, interactúa de forma sutil y elegante con:
 *  - La barra/ícono vertical dorada de la clínica (añadiendo el charm colgante con animación pendular).
 *  - El nombre de la clínica (con un badge temático y decoración en la esquina).
 *  - Micro-interacción: clic sobre el dongle lanza partículas festivas minimalistas y despliega un popover flotante con la sugerencia de temporada.
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, ChevronRight } from 'lucide-react';
import {
  getActiveSeasonalEvent,
  type SeasonalEventConfig,
} from './seasonalEvents';

interface SeasonalBrandDongleProps {
  /** Nombre de la clínica autenticada */
  clinicName: string;
  /** Subtítulo (Rol de usuario y nombre) */
  subtitle: string;
  /** Callback para navegar a módulos sugeridos */
  onNavigate?: (path: string) => void;
  /** Override opcional para probar eventos */
  eventOverride?: SeasonalEventConfig | null;
}

interface Particle {
  id: number;
  char: string;
  deltaX: number;
  deltaY: number;
  rotate: number;
}

export default function SeasonalBrandDongle({
  clinicName,
  subtitle,
  onNavigate,
  eventOverride,
}: SeasonalBrandDongleProps) {
  const [event, setEvent] = useState<SeasonalEventConfig | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const timersRef = useRef<number[]>([]);

  // Limpiar timers pendientes al desmontar (evita setState tras unmount)
  useEffect(() => {
    const timers = timersRef;
    return () => timers.current.forEach(window.clearTimeout);
  }, []);

  useEffect(() => {
    const active = eventOverride !== undefined ? eventOverride : getActiveSeasonalEvent();
    setEvent(active);
  }, [eventOverride]);

  // Cerrar el popover al hacer clic fuera o presionar Esc
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPopover(false);
    };

    if (showPopover) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showPopover]);

  // Lanzar partículas festivas al hacer clic en el dongle
  const triggerParticles = () => {
    if (reduceMotion || !event?.dongle.clickParticles?.length) return;
    const pool = event.dongle.clickParticles;
    const newParticles: Particle[] = Array.from({ length: 6 }).map((_, i) => ({
      id: Date.now() + i,
      char: pool[Math.floor(Math.random() * pool.length)],
      deltaX: (Math.random() - 0.5) * 80,
      deltaY: -35 - Math.random() * 45,
      rotate: (Math.random() - 0.5) * 90,
    }));

    setParticles(prev => [...prev, ...newParticles]);
    timersRef.current.push(
      window.setTimeout(() => {
        setParticles(prev => prev.filter(p => !newParticles.includes(p)));
      }, 1000),
    );
  };

  const handleDongleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerParticles();
    setShowPopover(prev => !prev);
  };

  // ─── Render estándar si no hay evento activo ──────────────────────────────
  if (!event) {
    return (
      <div className="flex items-center gap-3">
        <div className="w-2 h-9 bg-[#deb887] rounded-full" />
        <div>
          <h1
            className="text-xl font-bold text-gray-900 leading-tight"
            style={{ fontFamily: 'Playfair Display, serif' }}
          >
            {clinicName}
          </h1>
          <p className="text-xs text-gray-600 leading-tight">
            {subtitle}
          </p>
        </div>
      </div>
    );
  }

  // ─── Render estacional interactivo y minimalista ───────────────────────────
  const accent = event.theme.accentColor;

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-3 select-none group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Contenedor de la barra vertical + dongle interactivo ──────── */}
      <div className="relative flex items-center justify-center">
        {/* Barra vertical de la clínica: dorado champán con brillo del acento del evento */}
        <div
          className="h-9 w-2 rounded-full shadow-sm transition-all duration-500"
          style={{ background: `linear-gradient(to bottom, #deb887, ${accent}b3 50%, #deb887)` }}
        />

        {/* Brazo dorado con argolla: el charm cuelga a un costado de la barra, sin atravesarla */}
        <span
          className="pointer-events-none absolute left-1/2 top-[3px] h-px w-3.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]"
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute top-[0.5px] h-[7px] w-[7px] rounded-full border border-[#c5a075] bg-white shadow-[0_0_0_1px_rgba(222,184,135,0.25)]"
          style={{ left: 'calc(50% + 12px)' }}
          aria-hidden="true"
        />

        {/* Hilo de seda + charm con física pendular (pivote en la argolla) */}
        <motion.div
          className="absolute top-[7px] flex w-5 origin-top flex-col items-center"
          style={{ left: 'calc(50% + 12px)', marginLeft: -7 }}
          animate={
            reduceMotion
              ? { rotate: 0 }
              : { rotate: isHovered ? [-9, 9] : [-4, 4] }
          }
          transition={{
            repeat: Infinity,
            repeatType: 'mirror',
            duration: isHovered ? 1.3 : 3.2,
            ease: 'easeInOut',
          }}
        >
          <span className="h-3 w-px bg-gradient-to-b from-[#c5a075] to-[#deb887]/40" aria-hidden="true" />
          <button
            type="button"
            onClick={handleDongleClick}
            className="admin-focus-ring -mt-px rounded-full text-[15px] leading-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.2)] transition-transform duration-200 hover:scale-110 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#deb887]"
            title={`Especial de ${event.name} — Clic para abrir sugerencia`}
            aria-label={`Especial de ${event.name}`}
            aria-expanded={showPopover}
            aria-haspopup="dialog"
          >
            {event.dongle.emoji}
          </button>
        </motion.div>

        {/* Emisión de micro-partículas al interactuar */}
        <div className="absolute inset-0 pointer-events-none overflow-visible">
          {particles.map(p => (
            <motion.span
              key={p.id}
              initial={{ opacity: 1, scale: 0.6, x: 0, y: 0 }}
              animate={{
                opacity: 0,
                scale: 1.25,
                x: p.deltaX,
                y: p.deltaY,
                rotate: p.rotate,
              }}
              transition={{ duration: 0.9, ease: 'easeOut' }}
              className="absolute left-1/2 top-0 -translate-x-1/2 text-sm select-none z-50 pointer-events-none"
            >
              {p.char}
            </motion.span>
          ))}
        </div>
      </div>

      {/* ── Textos de la clínica con decoraciones sutiles ─────────────── */}
      <div className="relative ml-4">
        {/* Decoración temática sutil en la esquina (ej: telaraña en Halloween) */}
        {event.dongle.cornerEmoji && (
          <span
            className="pointer-events-none absolute -top-2.5 -right-4 text-xs select-none opacity-25 group-hover:opacity-75 transition-opacity duration-300 animate-pulse"
            aria-hidden="true"
          >
            {event.dongle.cornerEmoji}
          </span>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <h1
            className="text-xl font-bold text-gray-900 leading-tight transition-colors duration-200"
            style={{ fontFamily: 'Playfair Display, serif' }}
          >
            {clinicName}
          </h1>

          {/* Micro-badge interactivo y discreto */}
          <button
            type="button"
            onClick={() => setShowPopover(prev => !prev)}
            className="group/badge relative inline-flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-md transition-all duration-300 hover:-translate-y-px hover:text-gray-900 hover:shadow-md active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#deb887]"
            style={{
              borderColor: `${accent}40`,
              background: `linear-gradient(135deg, rgba(255,255,255,0.9), ${accent}1f)`,
            }}
            title="Ver detalles de temporada"
            aria-haspopup="dialog"
            aria-expanded={showPopover}
          >
            <span
              className="h-1.5 w-1.5 rounded-full motion-safe:animate-pulse"
              style={{ background: accent, boxShadow: `0 0 6px ${accent}99` }}
              aria-hidden="true"
            />
            <span className="relative">{event.dongle.label}</span>
            {/* Destello que cruza el badge al hover */}
            <span
              className="pointer-events-none absolute inset-y-0 -left-full w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/70 to-transparent transition-transform duration-700 group-hover/badge:translate-x-[300%] motion-reduce:hidden"
              aria-hidden="true"
            />
          </button>
        </div>

        <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-tight text-gray-600">
          <span
            className="h-px w-3 shrink-0 rounded-full"
            style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{subtitle}</span>
        </p>
      </div>

      {/* ── Popover flotante minimalista con consejo estético ─────────── */}
      <AnimatePresence>
        {showPopover && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="absolute top-full left-0 z-50 mt-3 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/70 bg-white/90 p-4 text-left shadow-[0_20px_50px_-12px_rgba(0,0,0,0.25)] ring-1 ring-black/5 backdrop-blur-xl sm:w-80"
            role="dialog"
            aria-label={`Detalles de ${event.name}`}
          >
            {/* Filete luminoso superior con el acento del evento */}
            <div
              className="absolute inset-x-0 top-0 h-px"
              style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
              aria-hidden="true"
            />

            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full text-base leading-none"
                  style={{ background: `${accent}1a`, boxShadow: `inset 0 0 0 1px ${accent}33` }}
                  aria-hidden="true"
                >
                  {event.dongle.emoji}
                </span>
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                    {event.dongle.sublabel || 'Temporada'}
                  </p>
                  <p className="text-sm font-semibold leading-tight text-gray-900" style={{ fontFamily: 'Playfair Display, serif' }}>
                    {event.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPopover(false)}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#deb887]"
                aria-label="Cerrar ventana"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-gray-600">
              {event.dongle.tooltipTip || event.description}
            </p>

            {event.actionPath && onNavigate && (
              <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-center justify-between">
                <span className="text-[10px] text-gray-400 font-medium">Recomendación médica</span>
                <button
                  type="button"
                  onClick={() => {
                    setShowPopover(false);
                    onNavigate(event.actionPath!);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#c5a075] hover:text-[#b08b5e] transition-colors"
                >
                  <span>{event.actionLabel || 'Ver sugerencia'}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
