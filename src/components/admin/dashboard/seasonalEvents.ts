/**
 * @file src/components/admin/dashboard/seasonalEvents.ts
 * @description Plantilla y configuración de eventos estacionales / fechas especiales para el dashboard principal.
 *
 * Para agregar o modificar un evento (ej. Halloween, Navidad, Aniversario, etc.):
 * Solo edita este archivo agregando o cambiando la lista de SEASONAL_EVENTS.
 * Soporta fechas en formato 'MM-DD' (recurrente anual) o 'YYYY-MM-DD' (año específico).
 */

export interface SeasonalDecoration {
  /** Emoji, carácter o símbolo decorativo */
  char: string;
  /** Clases CSS de posición y animación (ej: flotación, escala, opacidad) */
  className?: string;
  /** Estilos inline adicionales */
  style?: React.CSSProperties;
}

export interface SeasonalEventConfig {
  /** Identificador único (ej: 'halloween', 'navidad', 'black-friday') */
  id: string;
  /** Nombre amigable del evento */
  name: string;
  /**
   * Inicio del evento: 'MM-DD' (repite cada año) o 'YYYY-MM-DD' (año específico)
   * Ej: '10-10' para 10 de octubre
   */
  startDate: string;
  /**
   * Fin del evento: 'MM-DD' o 'YYYY-MM-DD'
   * Ej: '11-03' para 03 de noviembre
   */
  endDate: string;
  /** Forzar que el evento esté activo independientemente de la fecha del sistema */
  forceActive?: boolean;
  /** Etiqueta pequeña / badge (ej: 'Especial Halloween 🎃') */
  tag: string;
  /** Título principal de la tarjeta/banner */
  title: string;
  /** Mensaje descriptivo o recomendación clínica/estética para la temporada */
  description: string;
  /** Texto opcional para botón de acción o sugerencia */
  actionLabel?: string;
  /** Ruta a la que dirige la acción (ej: '/admin/agenda', '/admin/ficha-clinica') */
  actionPath?: string;
  /** Configuración visual del dongle y tarjeta */
  theme: {
    /** Clases de gradiente o fondo principal */
    bgGradient: string;
    /** Clases de borde */
    borderColor: string;
    /** Color o clases del badge */
    badgeBg: string;
    badgeText: string;
    /** Color del título */
    titleColor: string;
    /** Color del texto secundario */
    textColor: string;
    /** Resplandor o sombra decorativa */
    glowColor: string;
    /** Acento temático */
    accentColor: string;
  };
  /** Configuración del dongle flotante y su interacción con el branding del dashboard */
  dongle: {
    emoji: string;
    label: string;
    sublabel?: string;
    /** Emoji decorativo en la esquina del contenedor (ej. '🕸️' para Halloween, '⭐' para Navidad) */
    cornerEmoji?: string;
    /** Partículas visuales que vuelan al interactuar o hacer clic */
    clickParticles?: string[];
    /** Mensaje corto o consejo clínico que aparece en el tooltip interactivo */
    tooltipTip?: string;
    /** Clases para el badge sutil al lado del nombre */
    badgeClass?: string;
  };
  /** Elementos flotantes decorativos animados */
  decorations?: SeasonalDecoration[];
}

/**
 * Catálogo de eventos estacionales preconfigurados.
 * Puedes activar, agregar nuevos eventos o ajustar fechas directamente aquí.
 */
export const SEASONAL_EVENTS: SeasonalEventConfig[] = [
  {
    id: 'halloween',
    name: 'Halloween & Día de Muertos',
    // Desde el 10 de octubre hasta el 3 de noviembre
    startDate: '10-10',
    endDate: '11-03',
    tag: 'Temporada Halloween 🎃',
    title: '¡Especial de Halloween en BIOSKIN! 🦇',
    description:
      'Días ideales para promover tratamientos de luminosidad facial, hidratación profunda y peeling revitalizante antes de los eventos de fin de mes.',
    actionLabel: 'Ver Agenda',
    actionPath: '/admin/agenda',
    theme: {
      bgGradient: 'bg-gradient-to-br from-[#1a0f2e] via-[#2d1238] to-[#160c24]',
      borderColor: 'border-orange-500/30',
      badgeBg: 'bg-orange-500/20 border border-orange-500/40',
      badgeText: 'text-orange-300',
      titleColor: 'text-orange-100',
      textColor: 'text-orange-200/80',
      glowColor: 'shadow-[0_10px_35px_-10px_rgba(249,115,22,0.35)]',
      accentColor: '#f97316',
    },
    dongle: {
      emoji: '🎃',
      label: 'Halloween',
      sublabel: 'Edición Especial',
      cornerEmoji: '🕸️',
      clickParticles: ['🎃', '🦇', '✨', '👻', '🕷️'],
      tooltipTip: 'Temporada ideal para peelings revitalizantes, luminosidad y protocolos pre-fiestas.',
      badgeClass: 'bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500/20',
    },
    decorations: [
      { char: '🦇', className: 'top-2 right-12 text-lg animate-pulse opacity-70' },
      { char: '✨', className: 'top-4 right-28 text-sm animate-bounce opacity-80' },
      { char: '🕸️', className: 'bottom-2 right-4 text-2xl opacity-40' },
      { char: '👻', className: 'bottom-3 right-20 text-lg opacity-60' },
      { char: '🕷️', className: 'top-1 left-24 text-xs opacity-50' },
    ],
  },
  {
    id: 'black-friday',
    name: 'Black Friday / Cyber Days',
    startDate: '11-20',
    endDate: '11-30',
    tag: 'Black Days 🏷️',
    title: '¡Semana de Promociones Exclusivas! ✨',
    description:
      'Aprovecha la temporada de Black Friday para ofrecer paquetes de sesiones y promociones de medicina estética a tus pacientes recurrentes.',
    actionLabel: 'Fichas Clínicas',
    actionPath: '/admin/ficha-clinica',
    theme: {
      bgGradient: 'bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-950',
      borderColor: 'border-gold/40',
      badgeBg: 'bg-gold/20 border border-gold/40',
      badgeText: 'text-gold',
      titleColor: 'text-white',
      textColor: 'text-gray-300',
      glowColor: 'shadow-[0_10px_35px_-10px_rgba(222,184,135,0.35)]',
      accentColor: '#deb887',
    },
    dongle: {
      emoji: '🏷️',
      label: 'Black Days',
      sublabel: 'Promociones',
      cornerEmoji: '✨',
      clickParticles: ['🏷️', '✨', '💎', '🔥'],
      tooltipTip: 'Impulsa paquetes de tratamientos y promociones exclusivas para fidelizar pacientes.',
      badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20 hover:bg-amber-500/20',
    },
    decorations: [
      { char: '✨', className: 'top-2 right-8 text-sm opacity-80 animate-ping' },
      { char: '💎', className: 'bottom-2 right-16 text-lg opacity-70' },
    ],
  },
  {
    id: 'navidad',
    name: 'Navidad & Fiestas',
    startDate: '12-01',
    endDate: '12-26',
    tag: 'Navidad & Bienestar 🎄',
    title: '¡Felices Fiestas en BIOSKIN! 🎁',
    description:
      'Diciembre es el mes de mayor demanda en armonización facial y cuidado de la piel. Asegura el seguimiento y bienestar de cada paciente.',
    actionLabel: 'Ver Agenda',
    actionPath: '/admin/agenda',
    theme: {
      bgGradient: 'bg-gradient-to-br from-[#0c2419] via-[#153a29] to-[#081b12]',
      borderColor: 'border-emerald-400/30',
      badgeBg: 'bg-emerald-500/20 border border-emerald-400/40',
      badgeText: 'text-emerald-300',
      titleColor: 'text-emerald-50',
      textColor: 'text-emerald-200/80',
      glowColor: 'shadow-[0_10px_35px_-10px_rgba(16,185,129,0.3)]',
      accentColor: '#10b981',
    },
    dongle: {
      emoji: '🎄',
      label: 'Navidad',
      sublabel: 'Bienestar',
      cornerEmoji: '❄️',
      clickParticles: ['🎄', '❄️', '⭐', '🎁', '✨'],
      tooltipTip: 'Alta demanda en armonización facial y bienestar para las celebraciones de fin de año.',
      badgeClass: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20',
    },
    decorations: [
      { char: '❄️', className: 'top-2 right-10 text-base animate-pulse opacity-80' },
      { char: '🎁', className: 'bottom-2 right-20 text-lg opacity-70' },
      { char: '⭐', className: 'top-4 right-32 text-sm opacity-90' },
    ],
  },
  {
    id: 'ano-nuevo',
    name: 'Año Nuevo',
    startDate: '12-27',
    endDate: '01-06',
    tag: 'Año Nuevo ✨',
    title: '¡Nuevo Año, Nueva Piel! 🥂',
    description:
      'Inicia el año con planes personalizados de renovación cutánea y protocolos de estética médica preventiva.',
    actionLabel: 'Ver Módulos',
    theme: {
      bgGradient: 'bg-gradient-to-br from-[#121829] via-[#1a233d] to-[#0d1220]',
      borderColor: 'border-amber-400/30',
      badgeBg: 'bg-amber-400/20 border border-amber-400/40',
      badgeText: 'text-amber-300',
      titleColor: 'text-amber-50',
      textColor: 'text-amber-200/80',
      glowColor: 'shadow-[0_10px_35px_-10px_rgba(251,191,36,0.3)]',
      accentColor: '#fbbf24',
    },
    dongle: {
      emoji: '🥂',
      label: 'Año Nuevo',
      sublabel: 'Renovación',
      cornerEmoji: '⭐',
      clickParticles: ['🥂', '✨', '🎉', '🌟'],
      tooltipTip: 'Inicia el año con nuevos protocolos de renovación celular y planes personalizados.',
      badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20 hover:bg-amber-500/20',
    },
    decorations: [
      { char: '✨', className: 'top-2 right-12 text-base animate-bounce opacity-80' },
      { char: '🎉', className: 'bottom-2 right-16 text-lg opacity-70' },
      { char: '⭐', className: 'top-3 right-28 text-sm opacity-90' },
    ],
  },
  {
    id: 'san-valentin',
    name: 'San Valentín',
    startDate: '02-01',
    endDate: '02-16',
    tag: 'Mes del Amor & Cuidado 💖',
    title: '¡Mes del Amor Propio y la Belleza! 🌹',
    description:
      'Promueve paquetes de cuidado facial en pareja y tratamientos de labios y rejuvenecimiento.',
    actionLabel: 'Ver Agenda',
    actionPath: '/admin/agenda',
    theme: {
      bgGradient: 'bg-gradient-to-br from-[#2a0e1c] via-[#3d1428] to-[#200a15]',
      borderColor: 'border-pink-500/30',
      badgeBg: 'bg-pink-500/20 border border-pink-400/40',
      badgeText: 'text-pink-300',
      titleColor: 'text-pink-50',
      textColor: 'text-pink-200/80',
      glowColor: 'shadow-[0_10px_35px_-10px_rgba(244,114,182,0.3)]',
      accentColor: '#f472b6',
    },
    dongle: {
      emoji: '💖',
      label: 'San Valentín',
      sublabel: 'Amor Propio',
      cornerEmoji: '🌹',
      clickParticles: ['💖', '🌹', '✨', '💕'],
      tooltipTip: 'Días propicios para planes de rejuvenecimiento facial, labios y protocolos de autocuidado.',
      badgeClass: 'bg-pink-500/10 text-pink-600 border-pink-500/20 hover:bg-pink-500/20',
    },
    decorations: [
      { char: '🌹', className: 'top-2 right-10 text-base opacity-80' },
      { char: '✨', className: 'bottom-2 right-16 text-sm opacity-70' },
    ],
  },
];

/**
 * Determina si un evento estacional está activo para la fecha dada.
 * Maneja tanto rangos dentro del mismo año como rangos que cruzan fin de año (ej. 12-27 a 01-06).
 */
export function isEventActive(event: SeasonalEventConfig, targetDate = new Date()): boolean {
  if (event.forceActive) return true;

  const currentYear = targetDate.getFullYear();
  const currentMonth = targetDate.getMonth() + 1;
  const currentDay = targetDate.getDate();
  const currentMMDD = `${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
  const currentYYYYMMDD = `${currentYear}-${currentMMDD}`;

  // Si tiene formato completo YYYY-MM-DD
  if (event.startDate.length === 10 && event.endDate.length === 10) {
    return currentYYYYMMDD >= event.startDate && currentYYYYMMDD <= event.endDate;
  }

  // Formato MM-DD
  const start = event.startDate;
  const end = event.endDate;

  // Rango normal en el mismo año (ej. 10-10 a 11-03)
  if (start <= end) {
    return currentMMDD >= start && currentMMDD <= end;
  }

  // Rango que cruza fin de año (ej. 12-27 a 01-06)
  return currentMMDD >= start || currentMMDD <= end;
}

/**
 * Obtiene el evento estacional actualmente activo, o null si no hay ninguno.
 */
export function getActiveSeasonalEvent(targetDate = new Date()): SeasonalEventConfig | null {
  for (const event of SEASONAL_EVENTS) {
    if (isEventActive(event, targetDate)) {
      return event;
    }
  }
  return null;
}
