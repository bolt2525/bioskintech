/**
 * @file src/components/admin/dashboard/SeasonalEventWidget.tsx
 * @description Widget / Dongle estacional reutilizable para fechas y eventos especiales en el Dashboard.
 *
 * Se activa automáticamente según las fechas definidas en `seasonalEvents.ts`.
 * Permite minimizar/cerrar la tarjeta manteniendo un dongle interactivo discreto.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, ChevronRight, Eye } from 'lucide-react';
import {
  getActiveSeasonalEvent,
  type SeasonalEventConfig,
} from './seasonalEvents';

interface SeasonalEventWidgetProps {
  /** Permite forzar un evento específico para previsualización o pruebas */
  eventOverride?: SeasonalEventConfig | null;
  /** Clase CSS adicional para el contenedor principal */
  className?: string;
}

export default function SeasonalEventWidget({
  eventOverride,
  className = '',
}: SeasonalEventWidgetProps) {
  const navigate = useNavigate();
  const [event, setEvent] = useState<SeasonalEventConfig | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const active = eventOverride !== undefined ? eventOverride : getActiveSeasonalEvent();
    setEvent(active);
    if (active) {
      const dismissed = localStorage.getItem(`bioskin_event_dismissed_${active.id}`) === 'true';
      setIsDismissed(dismissed);
    }
  }, [eventOverride]);

  if (!event) return null;

  const handleDismiss = () => {
    setIsDismissed(true);
    try {
      localStorage.setItem(`bioskin_event_dismissed_${event.id}`, 'true');
    } catch {
      // Ignorar fallos de quota en modo incógnito
    }
  };

  const handleRestore = () => {
    setIsDismissed(false);
    try {
      localStorage.removeItem(`bioskin_event_dismissed_${event.id}`);
    } catch {
      // Ignorar
    }
  };

  return (
    <div className={`relative mb-6 select-none ${className}`} role="region" aria-label={event.name}>
      <AnimatePresence mode="wait">
        {isDismissed ? (
          /* Dongle compacto minimizado en la esquina */
          <motion.div
            key="dongle-minimized"
            initial={{ opacity: 0, scale: 0.9, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex justify-end"
          >
            <button
              type="button"
              onClick={handleRestore}
              className={`group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-md backdrop-blur-md transition-all hover:scale-105 active:scale-95 ${event.theme.bgGradient} ${event.theme.borderColor} ${event.theme.titleColor}`}
              title={`Mostrar especial de ${event.name}`}
              aria-label={`Mostrar especial de ${event.name}`}
            >
              <span className="text-base leading-none animate-bounce">{event.dongle.emoji}</span>
              <span>{event.dongle.label}</span>
              <Eye className="h-3 w-3 opacity-60 group-hover:opacity-100 transition-opacity" />
            </button>
          </motion.div>
        ) : (
          /* Tarjeta/Banner estacional completo con dongle integrado */
          <motion.section
            key="seasonal-banner"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className={`relative overflow-hidden rounded-3xl border p-5 sm:p-6 shadow-lg ${event.theme.bgGradient} ${event.theme.borderColor} ${event.theme.glowColor}`}
          >
            {/* Elementos decorativos animados de fondo */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
              {event.decorations?.map((dec, idx) => (
                <span
                  key={idx}
                  className={`absolute select-none transition-transform duration-1000 ${dec.className || ''}`}
                  style={dec.style}
                >
                  {dec.char}
                </span>
              ))}
            </div>

            {/* Dongle decorativo sobresaliente */}
            <div className="absolute top-0 right-14 -translate-y-1 sm:translate-y-0">
              <div
                className={`flex items-center gap-1.5 rounded-b-xl border-x border-b px-3 py-1 text-[11px] font-bold uppercase tracking-wider shadow-sm ${event.theme.badgeBg} ${event.theme.badgeText} ${event.theme.borderColor}`}
              >
                <span className="text-sm leading-none">{event.dongle.emoji}</span>
                <span>{event.dongle.label}</span>
              </div>
            </div>

            {/* Botón de cierre / minimizar */}
            <button
              type="button"
              onClick={handleDismiss}
              aria-label={`Ocultar banner de ${event.name}`}
              className="absolute top-3.5 right-3.5 rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Contenido principal del evento */}
            <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pr-8">
              <div className="space-y-1.5 max-w-2xl">
                <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest bg-white/10 backdrop-blur-sm border border-white/15 text-white/90">
                  <Sparkles className="h-3 w-3 text-amber-300" />
                  <span>{event.tag}</span>
                </div>

                <h3 className={`text-lg sm:text-xl font-bold tracking-tight ${event.theme.titleColor}`}>
                  {event.title}
                </h3>

                <p className={`text-xs sm:text-sm leading-relaxed ${event.theme.textColor}`}>
                  {event.description}
                </p>
              </div>

              {/* Botón de acción opcional */}
              {event.actionPath && (
                <div className="pt-2 sm:pt-0 sm:shrink-0">
                  <button
                    type="button"
                    onClick={() => event.actionPath && navigate(event.actionPath)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-white/90 px-4 py-2 text-xs font-bold text-gray-900 shadow-sm transition-all hover:bg-white hover:scale-105 active:scale-95"
                  >
                    <span>{event.actionLabel || 'Ver más'}</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
