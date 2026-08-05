/**
 * SkinExplorerButton — Botón teaser animado para la página de login.
 * Invita al usuario a descubrir el módulo DermoAtlas 3D.
 * Usa framer-motion (ya instalado) para las animaciones.
 */

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Microscope, Sparkles, ChevronRight, ArrowRight } from 'lucide-react';

// Partículas flotantes decorativas
function FloatingParticle({ delay, x, y }: { delay: number; x: number; y: number }) {
  return (
    <motion.div
      className="absolute w-1 h-1 rounded-full bg-[#f59e0b]/60"
      style={{ left: `${x}%`, top: `${y}%` }}
      initial={{ opacity: 0, scale: 0 }}
      animate={{
        opacity: [0, 1, 0],
        scale: [0, 1.5, 0],
        y: [-10, -30, -50],
      }}
      transition={{
        duration: 2.5,
        delay,
        repeat: Infinity,
        repeatDelay: Math.random() * 2 + 1,
        ease: 'easeOut',
      }}
    />
  );
}

const PARTICLES = [
  { x: 10, y: 60 }, { x: 25, y: 80 }, { x: 45, y: 70 },
  { x: 65, y: 75 }, { x: 80, y: 65 }, { x: 90, y: 80 },
  { x: 35, y: 85 }, { x: 70, y: 55 },
];

// Puntos de capas de la piel (decorativos)
const LAYER_DOTS = [
  { label: 'Epidermis', color: '#f59e0b', top: '28%' },
  { label: 'Dermis', color: '#c99277', top: '48%' },
  { label: 'Hipodermis', color: '#f97316', top: '68%' },
];

export default function SkinExplorerButton() {
  const [hovered, setHovered] = useState(false);
  const [pulse, setPulse] = useState(0);

  // Pulso periódico para llamar la atención cuando no está hovered
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      className="w-full mt-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.5, ease: 'easeOut' }}
    >
      <motion.button
        type="button"
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        whileTap={{ scale: 0.98 }}
        onClick={() => window.open('/gestionestetica/admin/skin-explorer', '_blank')}
        className="w-full relative overflow-hidden rounded-2xl text-left select-none"
        style={{ background: 'linear-gradient(135deg, #1a1210 0%, #2d1a12 50%, #1a1210 100%)' }}
      >
        {/* Borde animado */}
        <motion.div
          className="absolute inset-0 rounded-2xl"
          style={{
            background: 'linear-gradient(135deg, #c99277, #f59e0b, #c99277, #f97316)',
            backgroundSize: '300% 300%',
            padding: '1px',
          }}
          animate={{ backgroundPosition: hovered ? ['0% 0%', '100% 100%'] : ['0% 0%', '60% 60%'] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        >
          <div
            className="w-full h-full rounded-2xl"
            style={{ background: 'linear-gradient(135deg, #1a1210 0%, #251610 50%, #1a1210 100%)' }}
          />
        </motion.div>

        {/* Partículas flotantes */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
          {PARTICLES.map((p, i) => (
            <FloatingParticle key={i} delay={i * 0.3} x={p.x} y={p.y} />
          ))}
        </div>

        {/* Glow de fondo */}
        <motion.div
          className="absolute inset-0 rounded-2xl"
          animate={{
            opacity: hovered ? 1 : 0.4,
            background: hovered
              ? 'radial-gradient(circle at 30% 50%, rgba(201,146,119,0.2) 0%, transparent 70%)'
              : 'radial-gradient(circle at 30% 50%, rgba(201,146,119,0.08) 0%, transparent 70%)',
          }}
          transition={{ duration: 0.4 }}
        />

        {/* Contenido */}
        <div className="relative z-10 flex items-center gap-4 p-4">

          {/* Ícono 3D con capas animadas */}
          <div className="flex-shrink-0 relative">
            <motion.div
              className="w-14 h-14 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #c99277, #f59e0b)' }}
              animate={{
                boxShadow: hovered
                  ? '0 0 20px rgba(201,146,119,0.6), 0 0 40px rgba(245,158,11,0.2)'
                  : '0 0 8px rgba(201,146,119,0.2)',
              }}
              transition={{ duration: 0.4 }}
            >
              <Microscope size={26} className="text-white" />
            </motion.div>

            {/* Líneas de capas decorativas */}
            <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1">
              {LAYER_DOTS.map((dot, i) => (
                <motion.div
                  key={dot.label}
                  className="flex items-center gap-1"
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.6 + i * 0.1 }}
                >
                  <motion.div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: dot.color }}
                    animate={{
                      scale: hovered ? [1, 1.5, 1] : 1,
                      opacity: hovered ? 1 : 0.6,
                    }}
                    transition={{ duration: 0.8, delay: i * 0.1, repeat: hovered ? Infinity : 0 }}
                  />
                </motion.div>
              ))}
            </div>
          </div>

          {/* Texto */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <Sparkles size={11} className="text-[#f59e0b]" />
              <span className="text-[#f59e0b] text-[10px] font-semibold uppercase tracking-widest">
                DermoAtlas 3D
              </span>
            </div>
            <h3 className="text-white font-bold text-sm leading-tight">
              Explora la piel en una nueva dimensión
            </h3>
            <p className="text-white/40 text-[11px] mt-0.5 leading-relaxed">
              Modelo 3D interactivo · Capas anatómicas · Guía de tratamientos
            </p>

            {/* Capa pills animadas */}
            <AnimatePresence>
              {hovered && (
                <motion.div
                  className="flex gap-1 mt-2"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.2 }}
                >
                  {LAYER_DOTS.map((d) => (
                    <span
                      key={d.label}
                      className="px-1.5 py-0.5 rounded-full text-[9px] font-medium"
                      style={{ backgroundColor: d.color + '25', color: d.color }}
                    >
                      {d.label}
                    </span>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Flecha */}
          <motion.div
            animate={{ x: hovered ? 3 : 0 }}
            transition={{ duration: 0.3, type: 'spring', stiffness: 400 }}
            className="flex-shrink-0"
          >
            <ArrowRight size={16} className="text-[#c99277]" />
          </motion.div>
        </div>

        {/* Indicador de "nueva función" */}
        <motion.div
          key={pulse}
          className="absolute top-3 right-3"
          initial={{ scale: 1.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4 }}
        >
          <span className="flex items-center gap-1 bg-[#f59e0b]/20 text-[#f59e0b] text-[9px] font-semibold px-1.5 py-0.5 rounded-full border border-[#f59e0b]/30">
            <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-pulse" />
            NUEVO
          </span>
        </motion.div>
      </motion.button>

      {/* Subtexto debajo */}
      <motion.p
        className="text-center text-[10px] text-gray-300 mt-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
      >
        Disponible para todos los usuarios del panel
      </motion.p>
    </motion.div>
  );
}
