import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

interface TooltipProps {
  content: string | React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  style?: React.CSSProperties;
  interactive?: boolean;
}

// Portal-based tooltip for better z-index handling
export const Tooltip: React.FC<TooltipProps> = ({ 
  content, 
  children, 
  position = 'top', 
  className = '', 
  style = {},
  interactive = false
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout>();

  const updatePosition = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      
      let top = 0;
      let left = 0;

      // Calculate position based on viewport (fixed)
      switch (position) {
        case 'top':
          top = rect.top - 8; 
          left = rect.left + rect.width / 2;
          break;
        case 'bottom':
          top = rect.bottom + 8;
          left = rect.left + rect.width / 2;
          break;
        case 'left':
          top = rect.top + rect.height / 2;
          left = rect.left - 8;
          break;
        case 'right':
          top = rect.top + rect.height / 2;
          left = rect.right + 8;
          break;
      }
      setCoords({ top, left });
    }
  };

  const showTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    updatePosition();
    setIsVisible(true);
  };

  const hideTooltip = () => {
    if (interactive) {
      timeoutRef.current = setTimeout(() => setIsVisible(false), 100);
    } else {
      setIsVisible(false);
    }
  };

  // Close on scroll to prevent detachment
  useEffect(() => {
    if (isVisible) {
      const handleScroll = () => setIsVisible(false);
      window.addEventListener('scroll', handleScroll, true);
      return () => window.removeEventListener('scroll', handleScroll, true);
    }
  }, [isVisible]);

  const isHtml = typeof content === 'string' && content.trim().startsWith('<');

  return (
    <>
      <div 
        ref={triggerRef}
        className={`relative inline-flex ${className}`}
        style={style}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </div>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {isVisible && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
              style={{ 
                top: coords.top, 
                left: coords.left,
                position: 'fixed',
                zIndex: 99999 
              }}
              className={`px-3 py-1.5 text-xs font-medium text-white bg-gray-800 rounded-lg shadow-xl transform ${
                isHtml ? 'whitespace-normal max-w-xs' : 'whitespace-nowrap'
              } ${
                interactive ? 'pointer-events-auto' : 'pointer-events-none'
              } ${
                position === 'top' ? '-translate-x-1/2 -translate-y-full' :
                position === 'bottom' ? '-translate-x-1/2' :
                position === 'left' ? '-translate-x-full -translate-y-1/2' :
                '-translate-y-1/2'
              }`}
              onMouseEnter={() => {
                if (interactive && timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                }
              }}
              onMouseLeave={() => {
                if (interactive) {
                  hideTooltip();
                }
              }}
            >
              {isHtml ? (
                <div dangerouslySetInnerHTML={{ __html: content as string }} />
              ) : (
                content
              )}
              {/* Arrow */}
              <div 
                className={`absolute w-2 h-2 bg-gray-800 transform rotate-45 ${
                  position === 'top' ? 'bottom-[-4px] left-1/2 -translate-x-1/2' :
                  position === 'bottom' ? 'top-[-4px] left-1/2 -translate-x-1/2' :
                  position === 'left' ? 'right-[-4px] top-1/2 -translate-y-1/2' :
                  'left-[-4px] top-1/2 -translate-y-1/2'
                }`}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
};
