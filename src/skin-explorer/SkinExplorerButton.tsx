import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Microscope, Sparkles, ChevronRight } from 'lucide-react';

/**
 * Teaser elegante del módulo DermoAtlas 3D para la página de login.
 * Navega a /skin-explorer (ruta pública, sin admin layout).
 */
export default function SkinExplorerButton() {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      className="w-full mt-5"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.45, ease: 'easeOut' }}
    >
      {/* Línea divisora con texto */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-gray-100" />
        <span className="text-[11px] text-gray-300 font-medium tracking-wide">Descubre</span>
        <div className="flex-1 h-px bg-gray-100" />
      </div>

      <motion.button
        type="button"
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        whileHover={{ y: -1, boxShadow: '0 8px 24px rgba(222,184,135,0.15)' }}
        whileTap={{ scale: 0.99 }}
        onClick={() => navigate('/skin-explorer')}
        className="w-full flex items-center gap-4 p-4 rounded-2xl border border-[#deb887]/25 bg-gradient-to-r from-[#fdf8f0] to-[#faf4ea] hover:border-[#deb887]/50 transition-colors text-left"
      >
        {/* Ícono */}
        <motion.div
          className="w-12 h-12 rounded-xl bg-[#deb887] flex items-center justify-center flex-shrink-0 shadow-sm shadow-[#deb887]/30"
          animate={{ scale: hovered ? 1.05 : 1 }}
          transition={{ duration: 0.25, type: 'spring', stiffness: 400 }}
        >
          <Microscope size={22} className="text-white" />
        </motion.div>

        {/* Texto */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Sparkles size={11} className="text-[#deb887]" />
            <span className="text-[#deb887] text-[10px] font-semibold uppercase tracking-wider">
              DermoAtlas 3D
            </span>
          </div>
          <p className="text-gray-700 font-semibold text-sm leading-snug">
            Explora la piel en una nueva dimensión
          </p>
          <p className="text-gray-400 text-[11px] mt-0.5">
            Modelo 3D interactivo · Capas anatómicas · Guía clínica
          </p>
        </div>

        {/* Flecha animada */}
        <motion.div
          animate={{ x: hovered ? 3 : 0 }}
          transition={{ duration: 0.25, type: 'spring', stiffness: 500 }}
          className="flex-shrink-0"
        >
          <ChevronRight size={18} className="text-[#deb887]" />
        </motion.div>
      </motion.button>
    </motion.div>
  );
}
