/**
 * @file src/components/layout/ModuleFlyoutNav.tsx
 * @description Menú flyout en el borde izquierdo para saltar entre módulos del panel.
 *
 * - `ModuleFlyout`: presentacional, solo props (sin router, auth ni APIs) → apto para harness aislado.
 * - `ModuleFlyoutNav` (default): conectado a auth/permisos/rutas. Reutiliza `getVisibleModules`
 *   (misma regla que los tiles del dashboard: sin ampliar permisos ni habilitar módulos ocultos).
 *
 * Interacción: hover (solo puntero fino), clic/tap, teclado (Enter/Espacio/→ abren; ↑↓ Home End;
 * Escape cierra y devuelve el foco), cierre al hacer clic fuera o al salir el foco.
 * No se abre sobre diálogos modales. Respeta prefers-reduced-motion.
 * Salir de una ficha con cambios pendientes pide confirmación (no hay autoguardado).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Home, LayoutGrid, Settings } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { useAuth } from '../../context/AuthContext';
import { useMasterView } from '../../context/MasterViewContext';
import { useAdminNav } from '../../hooks/useAdminNav';
import { hasUnsavedChanges, hasUnsavedReporters } from '../../hooks/useUnsavedChangesGuard';
import { getVisibleModules } from '../../constants/features';
import { isModuleActive, nextFocusIndex, onTriggerClick, shouldCloseOnPointerLeave, shouldConfirmLeave } from './moduleNav';

export interface FlyoutItem {
  key: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
}

interface ModuleFlyoutProps {
  items: FlyoutItem[];
  onNavigate: (item: FlyoutItem) => void;
  /** Se evalúa al elegir un destino; true → pide confirmación antes de salir. */
  confirmLeave?: () => boolean;
  /** true → no abrir (p. ej. hay un diálogo modal abierto). Por defecto detecta `dialog[open]`/`aria-modal`. */
  isBlocked?: () => boolean;
}

const defaultIsBlocked = () =>
  typeof document !== 'undefined' && !!document.querySelector('dialog[open], [aria-modal="true"]');

const finePointer = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;

const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 220;

export function ModuleFlyout({ items, onNavigate, confirmLeave, isBlocked = defaultIsBlocked }: ModuleFlyoutProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<FlyoutItem | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const timer = useRef<number>();
  const focusOnOpen = useRef(false);
  /** true cuando el usuario fijó el menú con clic/tap/teclado: el hover ya no lo cierra. */
  const pinned = useRef(false);

  const clearTimer = () => window.clearTimeout(timer.current);
  const close = useCallback((returnFocus = false) => {
    window.clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  const openMenu = (viaKeyboard = false) => {
    if (isBlocked()) return;
    focusOnOpen.current = viaKeyboard;
    setOpen(true);
  };
  /**
   * Clic en el botón. Si el menú se abrió por hover, el clic lo FIJA (no lo cierra);
   * un segundo clic lo cierra. Así hover + clic nunca producen un cierre accidental.
   */
  const handleTriggerClick = (event: React.MouseEvent) => {
    clearTimer();
    const viaKeyboard = event.detail === 0;
    const next = onTriggerClick({ open, pinned: pinned.current });
    if (!next.open) { close(); return; }
    const wasOpen = open;
    pinned.current = next.pinned;
    if (wasOpen) { if (viaKeyboard) focusFirst(); return; }
    openMenu(viaKeyboard);
  };

  const links = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []);
  const focusFirst = () => {
    const all = links();
    (all.find(a => a.getAttribute('aria-current') === 'page') ?? all[0])?.focus();
  };

  // Foco al ítem activo/primero cuando se abre con teclado.
  // rAF: el panel pasa de `visibility:hidden` a visible con una transición; hay que esperar al primer frame.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const raf = requestAnimationFrame(focusFirst);
    return () => cancelAnimationFrame(raf);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cierre exterior
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open, close]);

  // Si aparece un diálogo modal con el menú abierto, se cierra
  useEffect(() => {
    if (!open) return;
    const observer = new MutationObserver(() => { if (isBlocked()) close(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    return () => observer.disconnect();
  }, [open, isBlocked, close]);

  useEffect(() => clearTimer, []);

  const go = (item: FlyoutItem) => {
    close();
    if (confirmLeave?.()) { setPending(item); return; }
    onNavigate(item);
  };

  const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>, item: FlyoutItem) => {
    // Ctrl/⌘/Shift/clic central: comportamiento nativo (nueva pestaña)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    go(item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close(true);
      return;
    }
    if (!open) return;
    const all = links();
    const next = nextFocusIndex(event.key, all.indexOf(document.activeElement as HTMLAnchorElement), all.length);
    if (next !== null) { event.preventDefault(); all[next]?.focus(); }
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!open || pending) return;
    const next = event.relatedTarget as Node | null;
    if (next && !rootRef.current?.contains(next)) close();
  };

  const handlePointerEnter = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse' || !finePointer()) return;
    clearTimer();
    if (!open) timer.current = window.setTimeout(() => openMenu(), HOVER_OPEN_MS);
  };
  const handlePointerLeave = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse' || !finePointer() || pinned.current) return;
    clearTimer(); // cancela una apertura por hover pendiente
    if (shouldCloseOnPointerLeave({ open, pinned: pinned.current })) timer.current = window.setTimeout(() => close(), HOVER_CLOSE_MS);
  };

  return (
    <div
      ref={rootRef}
      className="fixed left-0 top-1/2 z-40 -translate-y-1/2"
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      data-testid="module-flyout"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Menú de módulos"
        aria-expanded={open}
        aria-controls="module-flyout-panel"
        aria-haspopup="true"
        onClick={handleTriggerClick}
        onKeyDown={e => { if (e.key === 'ArrowRight' && !open) { e.preventDefault(); pinned.current = true; openMenu(true); } }}
        className="flex h-24 w-7 items-center justify-center rounded-r-xl border border-l-0 border-gold/50 bg-gradient-to-b from-[#1f332e] to-[#172522] text-gold shadow-lg transition-colors hover:from-[#27403a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold motion-reduce:transition-none sm:w-8"
      >
        <LayoutGrid className="h-4 w-4" aria-hidden="true" />
      </button>

      <nav
        id="module-flyout-panel"
        aria-label="Módulos de BIOSKIN"
        className={`absolute left-7 top-1/2 max-h-[calc(100dvh-6rem)] w-64 max-w-[calc(100vw-2.5rem)] -translate-y-1/2 overflow-y-auto         overscroll-contain rounded-2xl border border-gold/30 bg-[#172522] p-2 text-white shadow-2xl duration-200 motion-reduce:transition-none sm:left-8 ${
                  // Abrir: visibilidad inmediata (el foco por teclado necesita el panel visible). Cerrar: fade-out y luego `visibility:hidden`.
                  open
                    ? 'visible translate-x-1 opacity-100 transition-[opacity,transform]'
                    : 'invisible -translate-x-3 opacity-0 transition-[opacity,transform,visibility]'
                }`}
      >
        <div className="mb-1 h-0.5 rounded bg-gradient-to-r from-gold to-gold-dark" aria-hidden="true" />
        <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-100/60">Ir a</p>
        <ul ref={listRef} className="space-y-0.5">
          {items.map(item => {
            const Icon = item.icon;
            return (
              <li key={item.key}>
                <a
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  onClick={e => handleLinkClick(e, item)}
                  className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold motion-reduce:transition-none ${
                    item.active
                      ? 'bg-gold/15 font-semibold text-gold'
                      : 'text-emerald-50/85 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {pending && (
        <Dialog open onClose={() => setPending(null)} labelledBy="module-flyout-leave-title" describedBy="module-flyout-leave-desc" className="w-full sm:w-[26rem]">
          <div className="rounded-2xl bg-white p-5 shadow-2xl">
            <h2 id="module-flyout-leave-title" className="text-base font-bold text-gray-900">¿Salir de esta ficha?</h2>
            <p id="module-flyout-leave-desc" className="mt-2 text-sm text-gray-600">
              Vas a ir a «{pending.label}». Los cambios que no hayas guardado en esta pantalla se perderán;
              BIOSKIN no guarda automáticamente.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" autoFocus onClick={() => setPending(null)}
                className="min-h-11 rounded-xl border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                Seguir en la ficha
              </button>
              <button type="button" onClick={() => { const item = pending; setPending(null); onNavigate(item); }}
                className="min-h-11 rounded-xl bg-[#172522] px-4 text-sm font-semibold text-white hover:bg-[#1f332e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                Salir sin guardar
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Versión conectada (auth + permisos + rutas)
// ─────────────────────────────────────────────────────────────────────────────

export default function ModuleFlyoutNav() {
  const { user, hasFeature, userModuleOverrides } = useAuth();
  const masterView = useMasterView();
  const { to } = useAdminNav();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const canManage = user?.role === 'clinic_admin' || user?.role === 'master_admin';
  const effectiveHasFeature = masterView.isActive ? masterView.hasFeatureInContext : hasFeature;

  const items = useMemo<FlyoutItem[]>(() => {
    const disabled = new Set(userModuleOverrides.filter(o => !o.enabled).map(o => o.feature));
    const home = to('');
    const modules = getVisibleModules(effectiveHasFeature, canManage, disabled).map(m => {
      const href = to(m.path.replace(/^\/admin\//, ''));
      return { key: m.feat, label: m.title, href, icon: m.icon, active: isModuleActive(pathname, href, m.path) };
    });
    return [
      { key: 'home', label: 'Inicio', href: home, icon: Home, active: pathname === home },
      ...modules,
      { key: 'settings', label: 'Ajustes', href: home, icon: Settings },
    ];
  }, [userModuleOverrides, to, effectiveHasFeature, canManage, pathname]);

  const onNavigate = useCallback((item: FlyoutItem) => {
    navigate(item.href, item.key === 'settings' ? { state: { openSettings: 'profile' } } : undefined);
  }, [navigate]);

  const confirmLeave = useCallback(
    () => shouldConfirmLeave(pathname, hasUnsavedChanges(), hasUnsavedReporters()),
    [pathname],
  );

  // master_admin fuera de "ver clínica" no tiene módulos clínicos
  if (!user || (user.role === 'master_admin' && !masterView.isActive)) return null;

  return <ModuleFlyout items={items} onNavigate={onNavigate} confirmLeave={confirmLeave} />;
}
