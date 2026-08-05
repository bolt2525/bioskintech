/**
 * @file src/constants/features.ts
 * @description Configuración centralizada de módulos del Admin Panel.
 */

import {
  Calendar, Clock, Ban, ClipboardList,
  DollarSign, Package, Cuboid, Database, Activity, MessageCircle, Brain, Microscope,
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
    feat: 'calendar',
    title: 'Gestión de Agenda',
    description: 'Visualiza y administra citas del calendario',
    icon: Calendar,
    path: '/admin/calendar',
    iconColor: 'text-indigo-500',
    bgColor: 'bg-indigo-50',
  },
  {
    feat: 'appointment',
    title: 'Agendar Cita',
    description: 'Crea citas manualmente en el sistema',
    icon: Clock,
    path: '/admin/appointment',
    iconColor: 'text-orange-500',
    bgColor: 'bg-orange-50',
  },
  {
    feat: 'block_schedule',
    title: 'Bloqueo de Horarios',
    description: 'Bloquea horarios no disponibles',
    icon: Ban,
    path: '/admin/block-schedule',
    iconColor: 'text-red-500',
    bgColor: 'bg-red-50',
  },
  {
    feat: 'ai_consultation',
    title: 'Consultas IA',
    description: 'Consultas médicas asistidas por IA con contexto clínico',
    icon: Brain,
    path: '/admin/ai-consultation',
    iconColor: 'text-[#deb887]',
    bgColor: 'bg-[#deb887]/10',
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
    description: 'Conectividad de servicios: DB, Calendar y Email',
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
