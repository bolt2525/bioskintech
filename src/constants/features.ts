/**
 * @file src/constants/features.ts
 * @description Configuración centralizada de módulos del Admin Panel.
 *
 * ¿Por qué este archivo?
 * La lista de módulos (`MODULE_CONFIG` / `MASTER_MODULES`) estaba duplicada
 * en `AdminDashboard.tsx` y `AdminMasterDashboard.tsx` — idéntica en ambos.
 * Ahora vive aquí y ambos la importan.
 *
 * Estructura de cada módulo:
 *  - feat: clave de feature en base de datos (usado para control de acceso)
 *  - title: nombre visible en el dashboard
 *  - description: subtítulo de la tarjeta
 *  - icon: componente Lucide
 *  - path: ruta de HashRouter
 *  - iconColor: clase Tailwind del ícono
 *  - bgColor: clase Tailwind del fondo del ícono
 */

import {
  Calendar, Clock, Ban, Brain, Zap, Bot, ClipboardList,
  DollarSign, Package, Cuboid, Wrench, Database, Activity,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Lista completa de features reconocidas por el backend
// (debe coincidir con ALL_FEATURES en api/admin-auth.js)
// ─────────────────────────────────────────────────────────────────────────────
export const ALL_FEATURES = [
  'calendar', 'block_schedule', 'appointment', 'diagnosis', 'protocols',
  'chat_assistant', 'clinical_records', 'finance', 'inventory',
  'clinical_3d', 'technical', 'backup', 'blog',
] as const;

export type FeatureKey = typeof ALL_FEATURES[number];

// ─────────────────────────────────────────────────────────────────────────────
// Metadatos de feature para toggles del Master Admin
// ─────────────────────────────────────────────────────────────────────────────
export const FEATURE_META: Record<FeatureKey, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  calendar:         { label: 'Agenda',           icon: Calendar,      color: 'text-indigo-600' },
  block_schedule:   { label: 'Bloqueo Horarios', icon: Ban,           color: 'text-red-500'    },
  appointment:      { label: 'Cita Manual',      icon: Clock,         color: 'text-orange-500' },
  diagnosis:        { label: 'Diagnóstico IA',   icon: Brain,         color: 'text-teal-600'   },
  protocols:        { label: 'Protocolos',       icon: Zap,           color: 'text-yellow-500' },
  chat_assistant:   { label: 'Asistente IA',     icon: Bot,           color: 'text-pink-500'   },
  clinical_records: { label: 'Fichas Clínicas',  icon: ClipboardList, color: 'text-pink-600'   },
  finance:          { label: 'Finanzas',         icon: DollarSign,    color: 'text-amber-500'  },
  inventory:        { label: 'Inventario',       icon: Package,       color: 'text-cyan-600'   },
  clinical_3d:      { label: 'Visualización 3D', icon: Cuboid,        color: 'text-violet-500' },
  technical:        { label: 'Serv. Técnico',    icon: Wrench,        color: 'text-slate-600'  },
  backup:           { label: 'Backup / BD',      icon: Database,      color: 'text-blue-600'   },
  blog:             { label: 'Blog Admin',       icon: Activity,      color: 'text-lime-600'   },
};

// ─────────────────────────────────────────────────────────────────────────────
// Configuración completa de módulos (tiles del dashboard)
// Usada tanto en AdminDashboard como en AdminMasterDashboard
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
    feat: 'diagnosis',
    title: 'Diagnóstico IA',
    description: 'Análisis dermatológico asistido por IA',
    icon: Brain,
    path: '/admin/diagnosis',
    iconColor: 'text-teal-500',
    bgColor: 'bg-teal-50',
  },
  {
    feat: 'protocols',
    title: 'Protocolos Clínicos',
    description: 'Protocolos de aparatología médica con IA',
    icon: Zap,
    path: '/admin/protocols',
    iconColor: 'text-yellow-500',
    bgColor: 'bg-yellow-50',
  },
  {
    feat: 'chat_assistant',
    title: 'Asistente de Respuestas',
    description: 'IA Gema para redactar respuestas a pacientes',
    icon: Bot,
    path: '/admin/chat-assistant',
    iconColor: 'text-pink-500',
    bgColor: 'bg-pink-50',
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
    feat: 'technical',
    title: 'Servicio Técnico',
    description: 'Gestión de reparaciones e informes BioskinTech',
    icon: Wrench,
    path: '/admin/technical',
    iconColor: 'text-slate-500',
    bgColor: 'bg-slate-50',
  },
  {
    feat: 'backup',
    title: 'Estado del Sistema',
    description: 'Diagnóstico de API, Calendar y SMTP',
    icon: Activity,
    path: '/admin',
    iconColor: 'text-emerald-500',
    bgColor: 'bg-emerald-50',
  },
  {
    feat: 'backup',
    title: 'Base de Datos',
    description: 'Descargar respaldo completo de datos',
    icon: Database,
    path: '/admin',
    iconColor: 'text-blue-500',
    bgColor: 'bg-blue-50',
  },
  {
    feat: 'blog',
    title: 'Blog Admin',
    description: 'Gestión de artículos del blog',
    icon: Database,
    path: '/blog-admin',
    iconColor: 'text-lime-500',
    bgColor: 'bg-lime-50',
  },
];
