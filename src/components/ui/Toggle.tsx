import React from 'react';
import { motion } from 'framer-motion';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label }) => {
  return (
    <div className="flex items-center gap-3 cursor-pointer" onClick={() => onChange(!checked)}>
      <div className={`w-12 h-6 flex items-center rounded-full p-1 transition-colors duration-300 ${checked ? 'bg-[#deb887]' : 'bg-gray-300'}`}>
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 700, damping: 30 }}
          className={`bg-white w-4 h-4 rounded-full shadow-md ${checked ? 'ml-auto' : ''}`}
        />
      </div>
      {label && <span className="text-sm font-medium text-gray-700 select-none">{label}</span>}
    </div>
  );
};
