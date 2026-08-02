import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, Droplets, FileSignature, X, ArrowRight } from 'lucide-react';

interface Props {
  consultationId: number;
  onConfirm: (enableInjectables: boolean, enableConsents: boolean) => void;
  onClose: () => void;
}

export default function ConsultationActivatedModal({ consultationId, onConfirm, onClose }: Props) {
  const [enableInjectables, setEnableInjectables] = useState(false);
  const [enableConsents, setEnableConsents] = useState(false);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 20 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        >
          {/* Header */}
          <div className="bg-gradient-to-r from-[#deb887]/20 to-amber-50 px-6 py-5 border-b border-[#deb887]/20">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#deb887]/20 rounded-full flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-[#b8944d]" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-800">Consulta registrada</h3>
                  <p className="text-xs text-gray-500 mt-0.5">ID #{consultationId}</p>
                </div>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-600">
              ¿Deseas habilitar tabs adicionales para esta sesión de consulta?
            </p>

            {/* Injectables toggle */}
            <label className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
              enableInjectables ? 'border-[#deb887] bg-amber-50/50' : 'border-gray-100 hover:border-gray-200'
            }`}>
              <input
                type="checkbox"
                checked={enableInjectables}
                onChange={e => setEnableInjectables(e.target.checked)}
                className="sr-only"
              />
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                enableInjectables ? 'bg-[#deb887]/20' : 'bg-gray-100'
              }`}>
                <Droplets className={`w-5 h-5 ${enableInjectables ? 'text-[#b8944d]' : 'text-gray-400'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${enableInjectables ? 'text-gray-800' : 'text-gray-600'}`}>
                  Inyectables
                </p>
                <p className="text-xs text-gray-400">Toxina botulínica · Rellenos & Bioestimuladores</p>
              </div>
              <div className={`w-5 h-5 rounded flex items-center justify-center border-2 flex-shrink-0 ${
                enableInjectables ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300'
              }`}>
                {enableInjectables && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
              </div>
            </label>

            {/* Consents toggle */}
            <label className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
              enableConsents ? 'border-[#deb887] bg-amber-50/50' : 'border-gray-100 hover:border-gray-200'
            }`}>
              <input
                type="checkbox"
                checked={enableConsents}
                onChange={e => setEnableConsents(e.target.checked)}
                className="sr-only"
              />
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                enableConsents ? 'bg-[#deb887]/20' : 'bg-gray-100'
              }`}>
                <FileSignature className={`w-5 h-5 ${enableConsents ? 'text-[#b8944d]' : 'text-gray-400'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${enableConsents ? 'text-gray-800' : 'text-gray-600'}`}>
                  Consentimientos Informados
                </p>
                <p className="text-xs text-gray-400">Formularios de autorización y firma del paciente</p>
              </div>
              <div className={`w-5 h-5 rounded flex items-center justify-center border-2 flex-shrink-0 ${
                enableConsents ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300'
              }`}>
                {enableConsents && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
              </div>
            </label>
          </div>

          {/* Footer */}
          <div className="px-6 pb-5 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
            >
              Continuar sin habilitar
            </button>
            <button
              onClick={() => onConfirm(enableInjectables, enableConsents)}
              className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              Confirmar
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
