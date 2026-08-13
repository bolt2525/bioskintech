import { ArrowLeft, FileText, Users, Shield, AlertCircle, Clock, Ban, RefreshCw, Scale, Settings, HelpCircle } from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';

const CONTACT_EMAIL = 'bolt2525@gmail.com';
const LAST_UPDATED = '07 de agosto de 2026';
const PLAN_PRICE = '$245 USD / año';

interface SectionProps {
  number: number;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function Section({ number, title, icon, children }: SectionProps) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-[#deb887]/15 overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-[#fdf8f0] to-white">
        <div className="w-8 h-8 bg-[#deb887] rounded-lg flex items-center justify-center flex-shrink-0 text-white">
          {icon}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-bold text-[#deb887] uppercase tracking-wider">Art. {number}</span>
          <h2 className="font-semibold text-gray-800 text-sm sm:text-base">{title}</h2>
        </div>
      </div>
      <div className="px-6 py-5 text-sm text-gray-700 leading-relaxed space-y-3">
        {children}
      </div>
    </div>
  );
}

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea]">
      {/* Blobs decorativos */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden>
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-[#deb887]/8 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-72 h-72 bg-[#deb887]/6 rounded-full blur-3xl" />
      </div>

      {/* Header pegajoso */}
      <header className="sticky top-0 bg-white/90 backdrop-blur border-b border-[#deb887]/20 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-[#deb887] transition-colors font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Volver</span>
          </button>
          <div className="flex items-center gap-3 flex-1">
            <BrandLogo className="h-10 w-auto object-contain" compact />
          </div>
          <span className="text-xs text-gray-400 hidden sm:block">Actualizado: {LAST_UPDATED}</span>
        </div>
      </header>

      {/* Contenido */}
      <main className="relative max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-5 pb-16">

        {/* Hero */}
        <div className="bg-white rounded-2xl shadow-sm border border-[#deb887]/20 p-6 sm:p-8">
          <div className="flex items-start gap-4 mb-5">
            <div className="w-14 h-14 bg-[#deb887] rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md">
              <FileText className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900" style={{ fontFamily: 'Playfair Display, serif' }}>
                Condiciones de Servicio
              </h1>
              <p className="text-gray-400 text-xs sm:text-sm mt-1.5">
                Plataforma BIOSKINTECH · Última actualización: {LAST_UPDATED}
              </p>
            </div>
          </div>
          <p className="text-gray-600 leading-relaxed text-sm sm:text-base">
            Las presentes Condiciones de Servicio regulan el acceso y uso de la plataforma web{' '}
            <strong className="text-gray-800">BIOSKINTECH</strong> (en adelante, la "Plataforma") por parte de clínicas,
            centros estéticos, spas y profesionales de la salud (en adelante, el "Cliente"). Al registrarse o utilizar
            la Plataforma, el Cliente declara haber leído, comprendido y aceptado íntegramente estas condiciones.
          </p>
        </div>

        {/* 1. Objeto del Contrato */}
        <Section number={1} title="Objeto del Contrato" icon={<FileText className="w-4 h-4" />}>
          <p>
            BIOSKINTECH es una plataforma de gestión clínica bajo el modelo Software como Servicio (SaaS), diseñada para profesionales de la estética médica, cosmiátricas, médicos y operadores de centros de bienestar. La Plataforma provee, entre otros:
          </p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Fichas clínicas digitales y expedientes de pacientes</li>
            <li>Gestión de agenda y citas con integración Google Calendar</li>
            <li>Consentimientos informados digitales con firma electrónica</li>
            <li>Módulos de inventario, finanzas y reportes administrativos</li>
            <li>Herramientas de diagnóstico e inteligencia artificial aplicada</li>
          </ul>
          <p>El acceso a estos módulos depende del plan contratado y de las funcionalidades habilitadas por el administrador de la Plataforma.</p>
        </Section>

        {/* 2. Definiciones */}
        <Section number={2} title="Definiciones" icon={<HelpCircle className="w-4 h-4" />}>
          <div className="space-y-2">
            <p><strong>Plataforma:</strong> La aplicación web BIOSKINTECH accesible en bioskintechapp.com.</p>
            <p><strong>Cliente / Clínica:</strong> La persona natural o jurídica que contrata el servicio para uso profesional.</p>
            <p><strong>Usuarios:</strong> Las personas autorizadas por el Cliente para acceder a la Plataforma (admin, colaboradores).</p>
            <p><strong>Paciente / Titular:</strong> La persona cuya información es registrada y gestionada por el Cliente a través del sistema.</p>
            <p><strong>Suscripción:</strong> El período de acceso activo al servicio, renovable anualmente.</p>
          </div>
        </Section>

        {/* 3. Acceso y Registro */}
        <Section number={3} title="Acceso y Registro" icon={<Users className="w-4 h-4" />}>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li>El Cliente debe registrarse con información veraz, completa y actualizada. Datos falsos pueden resultar en la cancelación inmediata de la cuenta.</li>
            <li>Las credenciales de acceso (usuario y contraseña) son personales e intransferibles. El Cliente es responsable de mantenerlas en confidencialidad.</li>
            <li>El administrador del Cliente puede crear cuentas adicionales de usuario para su equipo dentro de la Plataforma.</li>
            <li>El Cliente notificará de inmediato a BIOSKINTECH si detecta acceso no autorizado a su cuenta.</li>
          </ul>
        </Section>

        {/* 4. Plan, Precio y Pagos */}
        <Section number={4} title="Plan de Suscripción y Pagos" icon={<Settings className="w-4 h-4" />}>
          <div className="bg-[#fdf8f0] border border-[#deb887]/30 rounded-xl p-4 space-y-1.5">
            <p className="font-semibold text-gray-800">Plan Lanzamiento BioSkinTech</p>
            <p className="text-2xl font-bold text-[#deb887]">{PLAN_PRICE}</p>
            <p className="text-xs text-gray-500">Incluye acceso completo a todos los módulos activos durante el período de suscripción.</p>
          </div>
          <ul className="list-disc list-inside space-y-1.5 pl-1 mt-2">
            <li>El pago es anual y se realiza por adelantado.</li>
            <li>No se realizan reembolsos proporcionales salvo fallo técnico grave imputable exclusivamente a BIOSKINTECH.</li>
            <li>Al vencer la suscripción, el acceso al sistema quedará suspendido hasta su renovación. Los datos se conservan por 30 días adicionales.</li>
            <li>BIOSKINTECH se reserva el derecho de ajustar los precios con un mínimo de <strong>30 días de aviso previo</strong> mediante notificación en el panel de control.</li>
          </ul>
        </Section>

        {/* 5. Uso Aceptable */}
        <Section number={5} title="Uso Aceptable" icon={<Shield className="w-4 h-4" />}>
          <p className="font-semibold text-gray-800">El Cliente se compromete a:</p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Utilizar la Plataforma exclusivamente para la gestión clínica o estética legítima de su práctica profesional.</li>
            <li>Tratar los datos de los pacientes conforme a la <strong>Ley Orgánica de Protección de Datos Personales (LOPDP)</strong> del Ecuador, en su calidad de Responsable del Tratamiento.</li>
            <li>No intentar acceder a datos de otras clínicas o usuarios no autorizados.</li>
            <li>No compartir credenciales fuera de su equipo de trabajo autorizado.</li>
          </ul>
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800 mt-2">
            <p className="font-semibold mb-1">Queda expresamente prohibido:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Realizar ingeniería inversa, descompilar o copiar el software.</li>
              <li>Usar herramientas de automatización no autorizadas (scrapers, bots).</li>
              <li>Transferir o revender el acceso a terceros sin autorización expresa de BIOSKINTECH.</li>
              <li>Usar la Plataforma para actividades ilícitas, fraudulentas o que perjudiquen a terceros.</li>
            </ul>
          </div>
        </Section>

        {/* 6. Propiedad Intelectual */}
        <Section number={6} title="Propiedad Intelectual" icon={<Shield className="w-4 h-4" />}>
          <p>
            El software, diseño, marca, logotipos y demás elementos de la Plataforma son propiedad exclusiva de{' '}
            <strong>RAFAEL LARREA GALINDO / BIOSKINTECH</strong>. Todos los derechos reservados.
          </p>
          <p>
            El Cliente recibe una <strong>licencia de uso limitada, no exclusiva y no transferible</strong> para acceder a la Plataforma durante el período de suscripción activa. Esta licencia no implica cesión de ningún derecho de propiedad intelectual.
          </p>
          <p>
            Los datos generados por el Cliente y sus pacientes dentro del sistema son de su exclusiva propiedad. BIOSKINTECH no adquiere ningún derecho sobre dicha información.
          </p>
        </Section>

        {/* 7. Titularidad y Portabilidad de Datos */}
        <Section number={7} title="Titularidad y Portabilidad de los Datos" icon={<FileText className="w-4 h-4" />}>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li>Los datos de los pacientes son propiedad del Cliente, quien actúa como <strong>Responsable del Tratamiento</strong>. BIOSKINTECH actúa como <strong>Encargado del Tratamiento</strong> según la LOPDP.</li>
            <li>Al cancelar la suscripción, el Cliente puede solicitar la exportación de todos sus datos dentro de los <strong>30 días posteriores</strong> a la fecha de cancelación.</li>
            <li>Vencido ese plazo, BIOSKINTECH podrá eliminar los datos de manera permanente e irreversible, sin obligación de conservarlos.</li>
            <li>La solicitud de exportación debe realizarse al correo:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#deb887] hover:underline font-medium">{CONTACT_EMAIL}</a>
            </li>
          </ul>
        </Section>

        {/* 8. Disponibilidad */}
        <Section number={8} title="Disponibilidad del Servicio" icon={<RefreshCw className="w-4 h-4" />}>
          <p>
            BIOSKINTECH procura mantener la Plataforma disponible de manera continua. Sin embargo, <strong>no se garantiza un nivel de disponibilidad (uptime) específico</strong>, dado que el servicio depende de infraestructura de terceros (Neon Postgres, Cloudflare, Vercel).
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800">
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Los mantenimientos planificados se comunicarán con anticipación a través del panel de control.</li>
              <li>Las interrupciones por causas de fuerza mayor, desastres naturales o fallos de proveedores externos no son imputables a BIOSKINTECH.</li>
            </ul>
          </div>
        </Section>

        {/* 9. Limitación de Responsabilidad */}
        <Section number={9} title="Limitación de Responsabilidad" icon={<AlertCircle className="w-4 h-4" />}>
          <p>BIOSKINTECH no será responsable por daños o perjuicios derivados de:</p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Uso incorrecto o negligente de la Plataforma por parte del Cliente o sus usuarios.</li>
            <li><strong>Procedimientos médicos, diagnósticos, tratamientos estéticos o recetas</strong> emitidos por los profesionales que utilizan la Plataforma. BIOSKINTECH provee herramientas de gestión, no servicios médicos directos.</li>
            <li>Conducta inapropiada, negligencia o mala praxis del profesional de la salud. Ante una denuncia debidamente comprobada, BIOSKINTECH se reserva el derecho de suspender o no renovar la suscripción del profesional.</li>
            <li>Información cargada en el sistema por el Cliente, su equipo médico, asistentes o secretarias.</li>
            <li>Pérdida de datos atribuible a acciones u omisiones del propio Cliente.</li>
            <li>Interrupciones del servicio por causas ajenas a BIOSKINTECH (proveedores de infraestructura, problemas de conectividad, fuerza mayor).</li>
          </ul>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 mt-1">
            En ningún caso la responsabilidad total de BIOSKINTECH ante el Cliente excederá el valor de la suscripción anual efectivamente pagada por el período en disputa.
          </div>
        </Section>

        {/* 9b. Recomendación para Pacientes */}
        <Section number={9} title="Recomendación a los Pacientes — Verificación Profesional" icon={<Users className="w-4 h-4" />}>
          <p>
            BIOSKINTECH insta a los pacientes a investigar y validar cuidadosamente la información del profesional o centro estético antes de someterse a cualquier procedimiento.
          </p>
          <div className="bg-[#fdf8f0] border border-[#deb887]/20 rounded-xl p-4 space-y-2 text-xs">
            <p className="font-semibold text-gray-800">En Ecuador, puedes verificar:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-gray-700">
              <li>Títulos profesionales registrados en la <strong>SENESCYT</strong> (senescyt.gob.ec)</li>
              <li>Registros de profesionales de salud en el <strong>Ministerio de Salud Pública (MSP)</strong></li>
              <li>Habilitación de establecimientos de salud en la plataforma del MSP</li>
            </ul>
          </div>
          <p className="text-xs text-gray-500">
            BIOSKINTECH no verifica ni certifica las credenciales de los profesionales registrados. La responsabilidad de la idoneidad profesional recae exclusivamente en el propio profesional o clínica contratante.
          </p>
        </Section>

        {/* 10. Suspensión y Cancelación */}
        <Section number={10} title="Suspensión y Cancelación" icon={<Ban className="w-4 h-4" />}>
          <p className="font-semibold text-gray-800">BIOSKINTECH podrá suspender o cancelar el servicio en los siguientes casos:</p>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li><strong>Falta de pago:</strong> El acceso se suspende automáticamente 7 días después del vencimiento de la suscripción.</li>
            <li><strong>Incumplimiento grave:</strong> Violación a las cláusulas de Uso Aceptable o a las presentes condiciones.</li>
            <li><strong>Actividades ilícitas:</strong> Si se detecta uso fraudulento, el servicio puede cancelarse de forma inmediata y sin reembolso.</li>
          </ul>
          <p>El Cliente puede cancelar la suscripción en cualquier momento enviando una solicitud al correo{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#deb887] hover:underline font-medium">{CONTACT_EMAIL}</a>.
            La cancelación voluntaria no genera reembolso proporcional.
          </p>
          <p>BIOSKINTECH puede discontinuar el servicio por razones de negocio, con un mínimo de <strong>30 días de aviso previo</strong>.</p>
        </Section>

        {/* 11. Modificaciones */}
        <Section number={11} title="Modificaciones de las Condiciones" icon={<Clock className="w-4 h-4" />}>
          <p>
            BIOSKINTECH se reserva el derecho de modificar estas Condiciones de Servicio en cualquier momento para adaptarlas a cambios legales, técnicos o de negocio.
          </p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Los cambios serán notificados a través del panel de control con <strong>al menos 15 días de anticipación</strong>.</li>
            <li>El uso continuado de la Plataforma tras la fecha de vigencia de las nuevas condiciones implica su aceptación.</li>
            <li>Si el Cliente no acepta los cambios, podrá cancelar su suscripción antes de la fecha de entrada en vigor.</li>
          </ul>
        </Section>

        {/* 12. Ley Aplicable */}
        <Section number={12} title="Ley Aplicable y Jurisdicción" icon={<Scale className="w-4 h-4" />}>
          <p>
            Las presentes Condiciones de Servicio se rigen e interpretan de conformidad con las leyes de la{' '}
            <strong>República del Ecuador</strong>.
          </p>
          <p>
            Cualquier controversia, disputa o reclamación derivada de o relacionada con estas condiciones se someterá a la jurisdicción y competencia de los{' '}
            <strong>jueces y tribunales competentes de la ciudad de Cuenca, Ecuador</strong>, renunciando las partes a cualquier otro fuero que pudiera corresponderles.
          </p>
          <div className="bg-[#fdf8f0] border border-[#deb887]/20 rounded-xl p-3">
            <p className="text-xs text-gray-600">
              Para consultas, reclamaciones o solicitudes relacionadas con estas Condiciones de Servicio, contactar a:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#deb887] hover:underline font-medium">{CONTACT_EMAIL}</a>
            </p>
          </div>
        </Section>

        {/* 13. Respaldo de Datos y Continuidad */}
        <Section number={13} title="Respaldo de Datos y Continuidad del Servicio" icon={<RefreshCw className="w-4 h-4" />}>
          <p>
            BIOSKINTECH implementa mecanismos de respaldo automático de la información clínica y administrativa almacenada en la Plataforma, con el objetivo de garantizar la integridad y recuperabilidad de los datos ante incidentes técnicos.
          </p>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li>Los respaldos se realizan de forma periódica en la infraestructura de Neon Postgres con replicación geográfica.</li>
            <li>Los mantenimientos planificados se notificarán con anticipación en el panel de control.</li>
            <li>Las interrupciones por mantenimiento, actualizaciones o ciberataques serán comunicadas oportunamente.</li>
          </ul>
        </Section>

        {/* 14. Enlace a Terceros */}
        <Section number={14} title="Enlaces a Sitios de Terceros" icon={<Settings className="w-4 h-4" />}>
          <p>
            La Plataforma puede incluir integraciones o referencias a servicios de terceros (Google Calendar, PayPhone, WhatsApp Business API, entre otros). BIOSKINTECH no asume responsabilidad alguna sobre el contenido, políticas de privacidad ni términos de dichos servicios externos.
          </p>
          <p className="text-xs text-gray-500">
            Se recomienda al Cliente revisar los términos y condiciones de cada servicio integrado de forma independiente.
          </p>
        </Section>

        {/* Footer de la página */}
        <div className="text-center text-xs text-gray-400 pt-4">
          <p>BioSkinTech © {new Date().getFullYear()} · RUC 0105872600001 · Ecuador</p>
          <p className="mt-1">
            Al registrarte o usar la Plataforma aceptas estas Condiciones de Servicio y nuestra{' '}
            <a href="/politica-de-privacidad" className="text-[#deb887] hover:underline">Política de Privacidad</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
