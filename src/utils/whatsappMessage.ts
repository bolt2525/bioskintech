const templateTitles: Record<string, string> = {
  confirmacion_cita: 'Confirmación de cita',
  agenda_diaria_staff: 'Resumen de agenda',
};

const fieldLabels: Record<string, string> = {
  nombre_paciente: 'Paciente',
  nombre_clinica: 'Clínica',
  nombre_usuario: 'Profesional',
  servicio: 'Servicio',
  fecha_hora: 'Fecha y hora',
  enlace_contacto: 'Contacto',
  fecha: 'Fecha',
  resumen: 'Agenda',
};

export function parseWhatsAppTemplate(content: string) {
  const match = /^\[plantilla:([a-zA-Z0-9_-]+)\]\s*([\s\S]*)$/.exec(content);
  if (!match) return null;
  const fields = match[2].split(/\s+\|\s+(?=[a-z_]+=)/).map(entry => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return null;
    const key = entry.slice(0, separator);
    return { key, label: fieldLabels[key] || key.replace(/_/g, ' '), value: entry.slice(separator + 1) };
  }).filter((field): field is { key: string; label: string; value: string } => field !== null);
  return { name: match[1], title: templateTitles[match[1]] || match[1].replace(/_/g, ' '), fields };
}

export function trustedWhatsAppHref(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'wa.me' && /^\/[0-9]{7,15}$/.test(url.pathname)) return value;
    return ['bioskintechapp.com', 'www.bioskintechapp.com', 'bioskintech.vercel.app'].includes(url.hostname) &&
      /^\/r\/[A-Za-z0-9._-]{4,64}$/.test(url.pathname) ? value : null;
  } catch {
    return null;
  }
}

export function whatsAppMessagePreview(content: string | null, direction?: 'entrante' | 'saliente' | null) {
  const template = direction === 'entrante' ? null : parseWhatsAppTemplate(content || '');
  return template ? `Plantilla: ${template.title}` : content || 'Sin contenido';
}
