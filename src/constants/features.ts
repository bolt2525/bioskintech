/**
 * @file src/constants/features.ts
 * @description Configuración centralizada de módulos del Admin Panel.
 */

import {
  Calendar, Clock, Ban, ClipboardList,
  DollarSign, Package, Cuboid, Database, Activity, Brain, Microscope, CalendarDays,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Lista de features activas — debe coincidir con ALL_FEATURES en api/admin-auth.js
// ─────────────────────────────────────────────────────────────────────────────
export const ALL_FEATURES = [
  'calendar', 'block_schedule', 'appointment',
  'clinical_records', 'finance', 'inventory', 'clinical_3d',
  'system_status', 'backup', 'ai_consultation', 'skin_explorer',
] as const;

export type FeatureKey = typeof ALL_FEATURES[number];

// ─────────────────────────────────────────────────────────────────────────────
// Metadatos de feature para toggles del Master Admin
// ─────────────────────────────────────────────────────────────────────────────
export const FEATURE_META: Record<FeatureKey, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  calendar:         { label: 'Agenda',           icon: Calendar,      color: 'text-indigo-600' },
  block_schedule:   { label: 'Bloqueo Horarios', icon: Ban,           color: 'text-red-500'    },
  appointment:      { label: 'Cita Manual',      icon: Clock,         color: 'text-orange-500' },
  clinical_records: { label: 'Fichas Clínicas',  icon: ClipboardList, color: 'text-pink-600'   },
  finance:          { label: 'Finanzas',         icon: DollarSign,    color: 'text-amber-500'  },
  inventory:        { label: 'Inventario',       icon: Package,       color: 'text-cyan-600'   },
  clinical_3d:      { label: 'Visualización 3D', icon: Cuboid,        color: 'text-violet-500' },
  ai_consultation:  { label: 'Consultas IA',     icon: Brain,         color: 'text-[#deb887]'  },
  system_status:    { label: 'Estado Sistema',   icon: Activity,      color: 'text-emerald-600' },
  backup:           { label: 'Base de Datos',    icon: Database,      color: 'text-blue-600'   },  skin_explorer:    { label: 'DermoAtlas 3D',    icon: Microscope, color: 'text-amber-600'  },};

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de módulos — tiles del dashboard
// ─────────────────────────────────────────────────────────────────────────────
export interface ModuleConfig {
  feat: FeatureKey;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  path: string;
  iconColor: string;
  bgColor: string;
  hidden?: boolean;
}

export const MODULE_LIST: ModuleConfig[] = [
  {
    feat: 'clinical_records',
    title: 'Fichas Clínicas',
    description: 'Pacientes, antecedentes y tratamientos',
    icon: ClipboardList,
    path: '/admin/clinical-records',
    iconColor: 'text-[#deb887]',
    bgColor: 'bg-[#deb887]/10',
  },
  {
    // ponytail: feat:calendar es el representante del grupo; las sub-cards validan permisos individualmente
    feat: 'calendar',
    title: 'Agenda',
    description: 'Citas, calendario, bloqueos de horario y agendamiento',
    icon: CalendarDays,
    path: '/admin/agenda',
    iconColor: 'text-indigo-500',
    bgColor: 'bg-indigo-50',
  },
  {
    feat: 'ai_consultation',
    title: 'Consultas IA',
    description: 'Consultas médicas asistidas por IA con contexto clínico',
    icon: Brain,
    path: '/admin/ai-consultation',
    iconColor: 'text-[#deb887]',
    bgColor: 'bg-[#deb887]/10',
    hidden: true,
  },
  {
    feat: 'finance',
    title: 'Finanzas',
    description: 'Gestión de ingresos y egresos',
    icon: DollarSign,
    path: '/admin/finance',
    iconColor: 'text-emerald-500',
    bgColor: 'bg-emerald-50',
  },
  {
    feat: 'inventory',
    title: 'Inventario',
    description: 'Control de stock, lotes y vencimientos',
    icon: Package,
    path: '/admin/inventory',
    iconColor: 'text-cyan-500',
    bgColor: 'bg-cyan-50',
  },
  {
    feat: 'clinical_3d',
    title: 'Visualización 3D',
    description: 'Entorno de visualización clínica en 3D',
    icon: Cuboid,
    path: '/admin/clinical-3d',
    iconColor: 'text-violet-500',
    bgColor: 'bg-violet-50',
  },
  {
    feat: 'system_status',
    title: 'Estado del Sistema',
    description: 'Suscripción, email y conectividad de la clínica',
    icon: Activity,
    path: '/admin/system-status',
    iconColor: 'text-emerald-500',
    bgColor: 'bg-emerald-50',
  },
  {
    feat: 'backup',
    title: 'Base de Datos',
    description: 'Estadísticas y respaldo de datos de la clínica',
    icon: Database,
    path: '/admin/backup',
    iconColor: 'text-blue-500',
    bgColor: 'bg-blue-50',
  },
  {
    feat: 'skin_explorer',
    title: 'DermoAtlas 3D',
    description: 'Explorador interactivo de la piel — anatomía, capas y tratamientos',
    icon: Microscope,
    path: '/admin/skin-explorer',
    iconColor: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
];
