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
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Sparkles } from 'lucide-react';
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
    if (!event?.dongle.clickParticles?.length) return;
    const pool = event.dongle.clickParticles;
    const newParticles: Particle[] = Array.from({ length: 6 }).map((_, i) => ({
      id: Date.now() + i,
      char: pool[Math.floor(Math.random() * pool.length)],
      deltaX: (Math.random() - 0.5) * 80,
      deltaY: -35 - Math.random() * 45,
      rotate: (Math.random() - 0.5) * 90,
    }));

    setParticles(prev => [...prev, ...newParticles]);
    setTimeout(() => {
      setParticles(prev => prev.filter(p => !newParticles.includes(p)));
    }, 1000);
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
  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-3 select-none group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Contenedor de la barra vertical + dongle interactivo ──────── */}
      <div className="relative flex items-center justify-center">
        {/* Barra vertical de la clínica con sutil gradiente del evento */}
        <div
          className={`w-2 h-9 rounded-full transition-all duration-500 shadow-sm ${
            event.id === 'halloween'
              ? 'bg-gradient-to-b from-[#deb887] via-[#f97316] to-[#deb887]'
              : 'bg-gradient-to-b from-[#deb887] to-amber-600'
          }`}
        />

        {/* Hilo sutil y dongle colgante animado tipo dije */}
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-auto">
          {/* Hilo conector fino */}
          <div className="w-[1.5px] h-3 bg-gradient-to-b from-[#deb887] to-amber-500/80 shadow-xs" />

          {/* Charm colgante con física pendular */}
          <motion.button
            type="button"
            onClick={handleDongleClick}
            animate={{
              rotate: isHovered ? [-14, 14, -14] : [-5, 5, -5],
              scale: isHovered ? 1.15 : 1,
            }}
            transition={{
              repeat: Infinity,
              duration: isHovered ? 1.4 : 3,
              ease: 'easeInOut',
            }}
            className="origin-top cursor-pointer text-base leading-none filter drop-shadow-[0_2px_4px_rgba(0,0,0,0.18)] hover:scale-125 active:scale-90 transition-transform focus:outline-none"
            title={`Especial de ${event.name} — Clic para abrir sugerencia`}
            aria-label={`Especial de ${event.name}`}
            aria-expanded={showPopover}
          >
            {event.dongle.emoji}
          </motion.button>
        </div>

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
      <div className="relative">
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
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border shadow-xs transition-all cursor-pointer active:scale-95 ${
              event.dongle.badgeClass || 'bg-amber-50 text-amber-700 border-amber-200/80 hover:bg-amber-100'
            }`}
            title="Ver detalles de temporada"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-ping opacity-75" />
            <span>{event.dongle.label}</span>
          </button>
        </div>

        <p className="text-xs text-gray-600 leading-tight">
          {subtitle}
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
            className="absolute top-full left-0 mt-3 w-72 sm:w-80 bg-white/95 backdrop-blur-md rounded-2xl border border-gray-100/90 p-3.5 shadow-2xl z-50 text-left"
            role="dialog"
            aria-label={`Detalles de ${event.name}`}
          >
            {/* Acento superior del evento */}
            <div className={`h-1 w-full rounded-full mb-2.5 ${event.theme.badgeBg}`} />

            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-base leading-none">{event.dongle.emoji}</span>
                <span className="text-xs font-bold uppercase tracking-wider text-gray-900">
                  {event.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowPopover(false)}
                className="text-gray-400 hover:text-gray-600 p-0.5 rounded-md hover:bg-gray-100 transition-colors"
                aria-label="Cerrar ventana"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-xs text-gray-600 mt-2 leading-relaxed">
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
