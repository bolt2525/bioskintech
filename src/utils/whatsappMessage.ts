const templateTitles: Record<string, string> = {
  confirmacion_cita: 'Confirmación de cita',
  agenda_diaria_staff: 'Resumen de agenda',
};

export function normalizeAppointmentPhone(value: string) {
  const phone = value.trim();
  if (!/^(?:\+|00)?[0-9][0-9 ().-]*$/.test(phone)) return '';
  let digits = phone.replace(/\D/g, '');
  const international = phone.startsWith('+') || phone.startsWith('00');
  if (phone.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    if (/^09\d{8}$/.test(digits) || /^0[2-7]\d{7}$/.test(digits)) {
      digits = `593${digits.slice(1)}`;
    } else if (/^9\d{8}$/.test(digits)) {
      digits = `593${digits}`;
    } else if (!/^[1-9]\d{9,14}$/.test(digits)) {
      return '';
    }
  }
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : '';
}

export function appointmentContact(description = '') {
  const text = description
    .replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ');
  const phone = text.match(/^[ \t]*(?:[📞☎📱][ \t]*)?(?:tel[eé]fono|tel\.?|celular|m[oó]vil|phone|whatsapp)(?:[ \t]*\/[ \t]*whatsapp)?[ \t]*:[ \t]*([^\r\n]*)/imu)?.[1]?.trim() || '';
  const internationalPhone = normalizeAppointmentPhone(phone);
  const issue = !phone
    ? 'Sin teléfono registrado en Google Calendar. Edita la descripción y añade «Teléfono: +código de país y número».'
    : !internationalPhone
      ? 'Revisa el teléfono en la descripción. Para otros países usa +código de país y número; para Ecuador puedes usar el formato local.'
      : '';
  return { phone, internationalPhone, issue };
}

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
