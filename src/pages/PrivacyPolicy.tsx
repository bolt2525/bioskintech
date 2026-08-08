import { ArrowLeft, Shield, Users, Database, Globe, Clock, UserCheck, FileText, Bell } from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';

const CONTACT_EMAIL = 'bolt2525@gmail.com';
const LAST_UPDATED = '07 de agosto de 2026';

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

export default function PrivacyPolicy() {
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
              <Shield className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900" style={{ fontFamily: 'Playfair Display, serif' }}>
                Política de Privacidad y Tratamiento de Datos Personales
              </h1>
              <p className="text-gray-400 text-xs sm:text-sm mt-1.5">
                Plataforma BIOSKINTECH · Última actualización: {LAST_UPDATED}
              </p>
            </div>
          </div>
          <p className="text-gray-600 leading-relaxed text-sm sm:text-base">
            El presente documento constituye la Política de Privacidad y Acuerdo de Tratamiento de Datos de la plataforma web <strong className="text-gray-800">BIOSKINTECH</strong>{' '}
            (en adelante, la "Plataforma"). De conformidad con la{' '}
            <strong>Ley Orgánica de Protección de Datos Personales (LOPDP)</strong> de la República del Ecuador, se detallan las condiciones bajo las cuales se recopilan, almacenan, protegen y tratan los datos personales de las clínicas, profesionales de la salud afiliados (los "Usuarios/Clientes") y sus respectivos pacientes (los "Titulares").
          </p>
        </div>

        {/* 1. Identificación */}
        <Section number={1} title="Identificación del Responsable y del Encargado" icon={<UserCheck className="w-4 h-4" />}>
          <div className="bg-[#fdf8f0] rounded-xl p-4 space-y-1.5 border border-[#deb887]/20">
            <p><strong>Titular de la Plataforma:</strong> RAFAEL LARREA GALINDO</p>
            <p><strong>RUC:</strong> 0105872600001</p>
            <p><strong>País de operación:</strong> Ecuador</p>
            <p><strong>Correo de contacto:</strong>{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#deb887] hover:underline">{CONTACT_EMAIL}</a>
            </p>
          </div>
          <p className="font-semibold text-gray-800 mt-1">Definición de roles según la LOPDP:</p>
          <ol className="list-decimal list-inside space-y-2 pl-1">
            <li>
              <strong>Responsable del Tratamiento:</strong> Las clínicas, centros estéticos, spas, médicos, cosmiátricas y profesionales de la salud que contratan la Plataforma. Ellos deciden qué datos solicitar y captar de sus pacientes.
            </li>
            <li>
              <strong>Encargado del Tratamiento:</strong> La Plataforma actúa exclusivamente como proveedor de software (SaaS) que facilita la infraestructura técnica para el procesamiento, gestión y almacenamiento de información por cuenta de las clínicas.
            </li>
          </ol>
        </Section>

        {/* 2. Base Legal */}
        <Section number={2} title="Base Legal y Consentimiento Explícito" icon={<FileText className="w-4 h-4" />}>
          <p>De acuerdo con los artículos 7 y 8 de la LOPDP, el tratamiento de datos personales en esta Plataforma es legítimo porque:</p>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li>Se cuenta con el <strong>consentimiento explícito, libre, específico e informado</strong> del Titular, manifestado mediante la aceptación digital en los formularios del sistema.</li>
            <li>Es necesario para la ejecución de la relación de prestación de servicios de salud y bienestar entre el profesional y el paciente.</li>
          </ul>
          <p>La Plataforma implementa formularios digitales obligatorios con casillas de verificación independientes donde el paciente declara conocer, entender y aceptar:</p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>La naturaleza del tratamiento estético o médico a realizarse.</li>
            <li>Las instrucciones de cuidados pre y post tratamiento.</li>
            <li>Los riesgos, problemas y complicaciones informadas.</li>
            <li>La autorización expresa para el almacenamiento de sus datos personales, clínicos y fotográficos.</li>
          </ul>
        </Section>

        {/* 3. Categorías de Datos */}
        <Section number={3} title="Categorías de Datos Objeto de Tratamiento" icon={<Database className="w-4 h-4" />}>
          <p className="font-semibold text-gray-800">A. Datos de las Clínicas y Profesionales (Usuarios):</p>
          <p>Nombres, apellidos, número de cédula/RUC, registro del MSP/SENESCYT, correo electrónico, teléfono y demás datos de contacto profesional.</p>
          <p className="font-semibold text-gray-800 mt-2">B. Datos de los Pacientes (Datos de Categoría Especial / Sensibles):</p>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            Al amparo del artículo 25 de la LOPDP, los datos relativos a la salud tienen categoría de <strong>datos sensibles</strong> y reciben la máxima protección.
          </div>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li><strong>Datos demográficos:</strong> Nombres, identificación, fecha de nacimiento, contacto.</li>
            <li><strong>Fichas Clínicas Digitales:</strong> Antecedentes médicos, alergias, diagnósticos, historial de tratamientos, evoluciones y notas del profesional.</li>
            <li><strong>Datos Biométricos y Gráficos:</strong> Fotografías médicas del antes y después, necesarias para el seguimiento de la evolución clínica.</li>
          </ul>
        </Section>

        {/* 4. Infraestructura */}
        <Section number={4} title="Infraestructura Técnica y Flujo Transfronterizo de Datos" icon={<Globe className="w-4 h-4" />}>
          <p>Para garantizar la máxima disponibilidad, integridad y confidencialidad exigida por la normativa, la Plataforma utiliza infraestructura en la nube con transferencia internacional segura a proveedores de primer nivel tecnológico:</p>
          <div className="space-y-3 mt-1">
            <div className="flex gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
              <span className="text-[#deb887] font-bold text-lg leading-none mt-0.5">1.</span>
              <div>
                <p className="font-semibold text-gray-800">Base de Datos General</p>
                <p className="text-gray-600">Datos de texto y clínicos almacenados en <strong>Neon Postgres</strong>, con cifrado y aislamiento de datos por clínica (multi-tenant).</p>
              </div>
            </div>
            <div className="flex gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
              <span className="text-[#deb887] font-bold text-lg leading-none mt-0.5">2.</span>
              <div>
                <p className="font-semibold text-gray-800">Almacenamiento Multimedia</p>
                <p className="text-gray-600">Imágenes y fotografías guardadas y distribuidas de forma encriptada mediante <strong>Cloudflare R2</strong>.</p>
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 border border-gray-100">
            Ambos proveedores cuentan con certificaciones internacionales de seguridad (ISO/IEC 27001 y SOC 2), garantizando un nivel de protección adecuado conforme a los requisitos de la LOPDP.
          </p>
        </Section>

        {/* 5. Finalidades */}
        <Section number={5} title="Finalidades del Tratamiento" icon={<UserCheck className="w-4 h-4" />}>
          <p>Los datos personales recabados serán utilizados únicamente para:</p>
          <ul className="list-disc list-inside space-y-1.5 pl-1">
            <li>Gestionar la agenda, citas, historiales médicos y fichas estéticas/clínicas dentro de la plataforma.</li>
            <li>Registrar formalmente el entendimiento del paciente sobre los cuidados pre y post tratamiento, así como la aceptación de posibles complicaciones médicas.</li>
            <li>Proveer al profesional herramientas de seguimiento administrativo y financiero interno de la clínica (a futuro, según los módulos habilitados).</li>
            <li>Garantizar el soporte técnico, mantenimiento y correcto funcionamiento de la plataforma.</li>
          </ul>
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800">
            La Plataforma <strong>NO vende, comercializa ni cede</strong> bajo ningún concepto los datos personales de clínicas o pacientes a terceros con fines publicitarios o ajenos al servicio.
          </div>
        </Section>

        {/* 6. Conservación */}
        <Section number={6} title="Plazo de Conservación de los Datos" icon={<Clock className="w-4 h-4" />}>
          <p>Los datos personales e historias clínicas se conservarán durante el tiempo estrictamente necesario para:</p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Cumplir con las finalidades de salud descritas en este documento.</li>
            <li>Cumplir con las obligaciones legales de retención de registros médicos vigentes en el Ecuador.</li>
            <li>Resolver cualquier controversia derivada del tratamiento.</li>
          </ul>
          <p>Lo anterior, salvo que el Titular revoque su consentimiento de forma legal conforme a los procedimientos establecidos.</p>
        </Section>

        {/* 7. Derechos ARCO */}
        <Section number={7} title="Derechos del Titular (Derechos ARCO)" icon={<Users className="w-4 h-4" />}>
          <p>
            De acuerdo con la LOPDP, los pacientes y usuarios tienen derecho a ejercer en cualquier momento sus derechos de{' '}
            <strong>Acceso, Rectificación, Actualización, Cancelación/Eliminación, Oposición y Portabilidad</strong> de sus datos personales.
          </p>
          <div className="bg-[#fdf8f0] rounded-xl p-4 border border-[#deb887]/20">
            <p className="font-semibold text-gray-800 mb-2">Para ejercer sus derechos:</p>
            <p>Envíe una solicitud por escrito adjuntando copia de su documento de identidad al correo electrónico:</p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex items-center gap-1.5 mt-2 text-[#deb887] hover:text-[#c9a96e] font-semibold hover:underline transition-colors"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 mt-2">
            <p className="font-semibold mb-1">📌 Nota de gestión de datos para Pacientes:</p>
            <p>
              Cuando la solicitud sea presentada por un <strong>Paciente</strong>, la Plataforma (en su rol de Encargado) notificará y coordinará de manera inmediata con la <strong>Clínica o Profesional de la salud</strong> correspondiente (Responsable del Tratamiento), a fin de validar la procedencia legal y médica de la solicitud antes de ejecutar cualquier modificación o eliminación técnica en las bases de datos.
            </p>
          </div>
        </Section>

        {/* 8. Modificaciones */}
        <Section number={8} title="Modificaciones a la Política de Privacidad" icon={<Bell className="w-4 h-4" />}>
          <p>
            La Plataforma se reserva el derecho de modificar esta política en cualquier momento para adaptarla a actualizaciones del sistema, nuevas especialidades médicas integradas o reformas legislativas en el Ecuador.
          </p>
          <p>
            Toda modificación será notificada a las clínicas usuarias dentro del panel de control de la aplicación con un aviso de lectura obligatoria.
          </p>
        </Section>

        {/* Footer de la página */}
        <div className="text-center text-xs text-gray-400 pt-4">
          <p>BioSkinTech © {new Date().getFullYear()} · RUC 0105872600001 · Ecuador</p>
          <p className="mt-1">
            Este documento tiene validez legal conforme a la LOPDP (Ley Orgánica de Protección de Datos Personales del Ecuador).
          </p>
        </div>
      </main>
    </div>
  );
}
