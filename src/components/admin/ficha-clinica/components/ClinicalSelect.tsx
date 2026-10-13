import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

interface Props {
  id?: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}

export default function ClinicalSelect({ id, label, value, options, onChange, className = '' }: Props) {
  const generatedId = useId();
  const controlId = id || generatedId;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 280 });
  const selected = options.findIndex(option => option.value === value);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect || !options.length) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(280, options.length * 48 + 8);
    const upwards = below < height && above > below;
    const maxHeight = Math.max(48, Math.min(height, upwards ? above : below));
    setPosition({
      top: upwards ? rect.top - maxHeight - 4 : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
    setActive(Math.max(0, selected));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${controlId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, controlId]);

  return (
    <div className={className}>
      <button ref={trigger} id={controlId} type="button" role="combobox" aria-label={label}
        aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${controlId}-options` : undefined}
        aria-activedescendant={open ? `${controlId}-option-${active}` : undefined}
        onClick={() => open ? setOpen(false) : show()}
        onBlur={() => setOpen(false)}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            if (!open) show();
            const start = open ? active : Math.max(0, selected);
            setActive(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
              : !open ? start : Math.max(0, Math.min(options.length - 1, start + (event.key === 'ArrowDown' ? 1 : -1))));
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            choose(active);
          }
        }}
        className={`admin-focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2.5 text-left text-sm text-gray-800 transition-colors hover:border-gold ${open ? 'border-gold ring-2 ring-gold/20' : 'border-gray-200'}`}>
        <span className="min-w-0 truncate">{options[selected]?.label || value || 'Seleccionar…'}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gold-ink ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menu} id={`${controlId}-options`} role="listbox" aria-label={label}
          className="fixed z-[9999] overflow-y-auto overscroll-contain rounded-xl border border-gold/40 bg-white p-1 shadow-xl"
          style={position}>
          {options.map((option, index) => (
            <div key={option.value} id={`${controlId}-option-${index}`} role="option" aria-selected={value === option.value}
              onPointerDown={event => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm ${index === active ? 'bg-gold/15 text-gold-ink' : 'text-gray-700'} ${value === option.value ? 'font-semibold' : ''}`}>
              <span className="min-w-0 break-words">{option.label}</span>
              {value === option.value ? <Check className="h-4 w-4 shrink-0 text-gold-ink" aria-hidden="true" /> : null}
            </div>
          ))}
        </div>, trigger.current?.closest('dialog') || document.fullscreenElement || document.body,
      )}
    </div>
  );
}
