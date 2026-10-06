import { useState, useMemo } from 'react';

export interface TreatmentGroup<T> {
  key: string;
  displayName: string;
  items: T[];
}

/**
 * Agrupa una lista por una clave normalizada (trim + lowercase) y expone el estado de
 * colapso/expansión de cada grupo. Extraído de la lógica original del historial de
 * Tratamientos (agrupación por procedimiento) para reutilizarse en los 3 modos
 * (Facial/Corporal/Capilar) y en la agrupación de sesiones independientes vs. paquetes.
 */
export function useTreatmentGrouping<T>(items: T[], getGroupName: (item: T) => string) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const groups: TreatmentGroup<T>[] = useMemo(() => {
    const grouped = items.reduce((acc, item) => {
      const raw = (getGroupName(item) || 'Sin procedimiento').trim();
      const key = raw.toLowerCase();
      if (!acc[key]) acc[key] = { key, displayName: raw, items: [] };
      acc[key].items.push(item);
      return acc;
    }, {} as Record<string, TreatmentGroup<T>>);
    return Object.values(grouped);
  }, [items, getGroupName]);

  const toggleGroup = (key: string) => setExpandedGroups(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const expandGroup = (key: string) => setExpandedGroups(prev => new Set(prev).add(key));

  return { groups, expandedGroups, toggleGroup, expandGroup };
}
