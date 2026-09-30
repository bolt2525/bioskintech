// Verificación puntual del fix: la confirmación de un paciente cuyo recordatorio ya fue
// marcado como 'leido' por Meta debe seguir siendo reconocida.
import { getPendingAppointmentReplyContext } from '../lib/whatsapp-crm.js';

const phone = process.argv[2] || '593992966854';
const row = await getPendingAppointmentReplyContext(phone);
console.log(row
  ? `OK ${phone} -> paciente="${row.patient_name}" cita=${new Date(row.appointment_start).toISOString()} evt=${row.appointment_event_id}`
  : `NULL ${phone} -> la confirmación se seguiría perdiendo`);
process.exit(0);
