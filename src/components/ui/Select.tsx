import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: (string | SelectOption)[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  placeholder = 'Seleccionar...',
  className = '',
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setCoords({
        top: rect.bottom + 4, // 4px gap
        left: rect.left,
        width: rect.width
      });
    }
  };

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen) {
      updatePosition();
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  useEffect(() => {
    const handleScroll = () => {
      if (isOpen) setIsOpen(false);
    };
    const handleResize = () => {
      if (isOpen) setIsOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleResize);
      document.addEventListener('click', handleClickOutside);
    }

    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  const getOptionLabel = (opt: string | SelectOption) => {
    return typeof opt === 'string' ? opt : opt.label;
  };

  const getOptionValue = (opt: string | SelectOption) => {
    return typeof opt === 'string' ? opt : opt.value;
  };

  const selectedOption = options.find(opt => getOptionValue(opt) === value);
  const displayValue = selectedOption ? getOptionLabel(selectedOption) : value;

  return (
    <>
      <div
        ref={triggerRef}
        onClick={(e) => {
            e.stopPropagation();
            toggleOpen();
        }}
        className={`
          relative w-full p-2.5 border rounded-xl text-sm transition-all cursor-pointer flex items-center justify-between group
          ${isOpen ? 'border-[#deb887] ring-2 ring-[#deb887] bg-white' : 'border-gray-200 bg-gray-50/50 hover:bg-white'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${className}
        `}
      >
        <span className={`truncate ${!value ? 'text-gray-400' : 'text-gray-700 font-medium'}`}>
          {value ? displayValue : placeholder}
        </span>
        <ChevronDown 
          size={16} 
          className={`text-gray-400 transition-transform duration-200 group-hover:text-[#deb887] ${isOpen ? 'rotate-180 text-[#deb887]' : ''}`} 
        />
      </div>

      {isOpen && createPortal(
        <div
          className="fixed z-[9999] bg-white border border-gray-100 rounded-xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
          style={{
            top: coords.top,
            left: coords.left,
            width: coords.width,
            maxHeight: '300px',
            overflowY: 'auto'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="py-1">
            {options.map((opt) => {
              const optValue = getOptionValue(opt);
              const optLabel = getOptionLabel(opt);
              const isSelected = value === optValue;

              return (
                <div
                  key={optValue}
                  onClick={() => {
                    onChange(optValue);
                    setIsOpen(false);
                  }}
                  className={`
                    px-3 py-2.5 text-sm cursor-pointer transition-colors flex items-center justify-between
                    ${isSelected ? 'bg-[#deb887]/10 text-[#deb887] font-medium' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}
                  `}
                >
                  <span>{optLabel || 'Seleccionar...'}</span>
                  {isSelected && <Check size={14} className="text-[#deb887]" />}
                </div>
              );
            })}
            {options.length === 0 && (
              <div className="px-3 py-2.5 text-sm text-gray-400 italic text-center">
                No hay opciones
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
