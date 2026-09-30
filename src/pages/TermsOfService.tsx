import { FileText, Users, Shield, AlertCircle, Clock, Ban, RefreshCw, Scale, Settings, HelpCircle, PenLine, Brain, Database, Plug, Handshake, CloudLightning, Stethoscope, Mail as MailIcon } from 'lucide-react';
import { LegalShell, LegalSection as Section, Note, Mail } from '../components/legal/LegalLayout';

const ul = 'list-disc list-inside space-y-1.5 pl-1';

export default function TermsOfService() {
  return (
    <LegalShell
      title="Condiciones de Servicio"
      icon={<FileText className="w-7 h-7" />}
      intro={<>
        <p>
          Estas Condiciones regulan el acceso y uso de la plataforma web <strong className="text-gray-800">BIOSKINTECH</strong> (la "Plataforma"), accesible en
          bioskintechapp.com, por parte de clínicas, centros estéticos, spas y profesionales de la salud (el "Cliente") y de las personas que el Cliente autoriza (los "Usuarios").
        </p>
        <p>
          Al registrarse, aceptar una invitación, pagar o usar la Plataforma, el Cliente celebra un contrato electrónico válido conforme a la
          <strong> Ley de Comercio Electrónico, Firmas Electrónicas y Mensajes de Datos</strong> del Ecuador y acepta íntegramente estas Condiciones y la
          <a href="/politica-de-privacidad" className="text-gold-dark font-semibold hover:underline"> Política de Privacidad</a>, que forma parte de ellas.
          Si no está de acuerdo, no debe usar la Plataforma.
        </p>
      </>}
      footer={<p>Al usar la Plataforma aceptas estas Condiciones y la <a href="/politica-de-privacidad" className="text-gold hover:underline">Política de Privacidad</a>.</p>}
    >
      <Section number={1} title="Objeto del servicio" icon={<FileText className="w-4 h-4" />}>
        <p>BIOSKINTECH es un software de gestión bajo modelo SaaS (Software como Servicio) que, según el plan y los módulos habilitados, permite:</p>
        <ul className={ul}>
          <li>Fichas clínicas digitales, expedientes, fotografías y marcaciones 2D/3D.</li>
          <li>Agenda integrada con Google Calendar, reservas en línea y recordatorios por correo o WhatsApp.</li>
          <li>Consentimientos informados digitales con firma presencial o remota.</li>
          <li>Inventario, finanzas, respaldos y, de forma opcional, herramientas de inteligencia artificial.</li>
        </ul>
        <p>BIOSKINTECH <strong>no presta servicios médicos, sanitarios, legales ni contables</strong>. Cualquier otro servicio de BIOSKINTECH (por ejemplo, servicio técnico de equipos) se rige por acuerdos separados.</p>
      </Section>

      <Section number={2} title="Definiciones" icon={<HelpCircle className="w-4 h-4" />}>
        <div className="space-y-2">
          <p><strong>Cliente:</strong> persona natural o jurídica que contrata la Plataforma para uso profesional.</p>
          <p><strong>Usuarios:</strong> administradores y colaboradores a quienes el Cliente da acceso.</p>
          <p><strong>Paciente / Titular:</strong> persona cuyos datos registra el Cliente.</p>
          <p><strong>Contenido del Cliente:</strong> toda información, archivo o dato cargado en la Plataforma por el Cliente, sus Usuarios o sus pacientes.</p>
          <p><strong>Responsable / Encargado del Tratamiento:</strong> según la LOPDP, el Cliente es Responsable de los datos de sus pacientes y BIOSKINTECH es Encargado.</p>
        </div>
      </Section>

      <Section number={3} title="Capacidad, registro y cuentas" icon={<Users className="w-4 h-4" />}>
        <ul className={ul}>
          <li>El servicio es exclusivamente para <strong>uso profesional o empresarial</strong>. Quien acepta declara ser mayor de edad y tener facultades para obligar al Cliente.</li>
          <li>La información de registro debe ser veraz y actualizada. Datos falsos permiten la suspensión inmediata.</li>
          <li>Las credenciales son personales e intransferibles. El Cliente responde por toda actividad realizada con las cuentas de sus Usuarios y debe revocar de inmediato el acceso de quienes dejen de colaborar con él.</li>
          <li>El Cliente debe notificar sin demora cualquier acceso no autorizado a <Mail />.</li>
        </ul>
      </Section>

      <Section number={4} title="Precio, pago y renovación" icon={<Settings className="w-4 h-4" />}>
        <ul className={ul}>
          <li>El precio aplicable es el que se muestra al Cliente en el proceso de pago o en el código de registro entregado, con impuestos indicados. El pago es anual y anticipado, salvo acuerdo escrito distinto.</li>
          <li>Los pagos se procesan a través de PayPhone; BIOSKINTECH no almacena datos de tarjetas.</li>
          <li>No hay reembolsos totales ni proporcionales, salvo falla técnica grave imputable exclusivamente a BIOSKINTECH que impida el uso del servicio durante más de 15 días consecutivos.</li>
          <li>BIOSKINTECH puede modificar precios para renovaciones futuras con al menos <strong>30 días de aviso</strong>.</li>
        </ul>
      </Section>

      <Section number={5} title="Vencimiento, suspensión y cuentas demo" icon={<Clock className="w-4 h-4" />}>
        <ul className={ul}>
          <li>La Plataforma avisa desde <strong>21 días antes</strong> del vencimiento. Al vencer la suscripción, <strong>el acceso se suspende automáticamente</strong> hasta su renovación.</li>
          <li>Los datos se conservan <strong>30 días</strong> después del vencimiento; luego pueden eliminarse según la Política de Privacidad.</li>
          <li>Las cuentas demo son de prueba: no deben contener datos reales de pacientes y se eliminan automáticamente al vencer.</li>
        </ul>
      </Section>

      <Section number={6} title="Uso aceptable" icon={<Shield className="w-4 h-4" />}>
        <p className="font-semibold text-gray-800">Queda prohibido:</p>
        <ul className={ul}>
          <li>Acceder o intentar acceder a datos de otras clínicas, eludir controles de seguridad o realizar pruebas de intrusión o de carga sin autorización escrita.</li>
          <li>Cargar malware, archivos manipulados o contenido ilícito, o usar la Plataforma para fines fraudulentos o contrarios a la normativa sanitaria.</li>
          <li>Realizar ingeniería inversa, copiar, revender o sublicenciar la Plataforma, o usar scrapers/bots no autorizados.</li>
          <li>Registrar datos de personas sin base legal o para fines distintos de la atención y gestión de la clínica.</li>
        </ul>
      </Section>

      <Section number={7} title="Obligaciones del Cliente como Responsable del Tratamiento" icon={<Stethoscope className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Informar a sus pacientes y obtener los consentimientos que exija la ley, incluidos los de menores de edad a través de sus representantes.</li>
          <li>Cumplir la normativa sanitaria, de historia clínica y de protección de datos, incluidos los plazos de conservación.</li>
          <li>Verificar la exactitud del Contenido del Cliente y la idoneidad y habilitación de sus profesionales.</li>
          <li>Contar con autorización de los pacientes para recibir recordatorios por WhatsApp o correo, y cumplir las políticas de Meta y Google.</li>
          <li>Atender los derechos de sus pacientes, con la asistencia técnica razonable de BIOSKINTECH.</li>
          <li>Descargar periódicamente respaldos de su información (ver Art. 11).</li>
        </ul>
      </Section>

      <Section number={8} title="Consentimientos, plantillas y firma" icon={<PenLine className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Las plantillas de consentimientos, recetas y protocolos son <strong>modelos referenciales</strong>. No constituyen asesoría legal ni médica; el Cliente debe revisarlas y adaptarlas a cada procedimiento y paciente.</li>
          <li>La firma de consentimientos se captura como firma manuscrita digitalizada en pantalla, con fecha y hora y, en la modalidad remota, verificación por código enviado al correo del paciente y huella de integridad SHA-256. Constituye una <strong>firma electrónica simple</strong> y evidencia digital; <strong>no es una firma electrónica certificada</strong> emitida por una entidad de certificación acreditada.</li>
          <li>Corresponde al Cliente evaluar si ese mecanismo es suficiente para cada caso o si requiere firma certificada o documento físico adicional.</li>
        </ul>
      </Section>

      <Section number={9} title="Inteligencia artificial" icon={<Brain className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Las funciones de IA son opcionales y de apoyo. Sus resultados pueden ser incompletos o incorrectos y <strong>no sustituyen el juicio clínico</strong>.</li>
          <li>La Plataforma no es un dispositivo médico ni emite diagnósticos. Toda decisión clínica es responsabilidad exclusiva del profesional.</li>
          <li>Al activarlas, el Cliente autoriza el envío del contenido seleccionado al proveedor de IA indicado en la Política de Privacidad.</li>
        </ul>
      </Section>

      <Section number={10} title="Propiedad intelectual y titularidad de los datos" icon={<Shield className="w-4 h-4" />}>
        <ul className={ul}>
          <li>El software, diseño, marcas, modelos 3D, plantillas y demás elementos de la Plataforma pertenecen a BIOSKINTECH o a sus licenciantes. El Cliente recibe una licencia de uso limitada, no exclusiva, no transferible y revocable durante la suscripción.</li>
          <li>El Contenido del Cliente es del Cliente. Este otorga a BIOSKINTECH una licencia limitada para almacenarlo y procesarlo solo con el fin de prestar, asegurar y respaldar el servicio.</li>
          <li>BIOSKINTECH puede usar métricas técnicas agregadas y anónimas, que no identifican a personas ni clínicas, para mejorar el servicio.</li>
          <li>Las sugerencias que el Cliente envíe pueden ser utilizadas libremente por BIOSKINTECH sin compensación.</li>
        </ul>
      </Section>

      <Section number={11} title="Respaldos, exportación y continuidad" icon={<Database className="w-4 h-4" />}>
        <ul className={ul}>
          <li>BIOSKINTECH genera una copia de seguridad diaria cifrada de los datos de cada clínica, inmutable durante 30 días y eliminada automáticamente a los 35 días. La base de datos permite además recuperación a un punto en el tiempo dentro de las últimas 6 horas.</li>
          <li>El administrador de la clínica puede exportar sus datos (JSON completo restaurable y CSV) e importar respaldos o pacientes desde el módulo Base de Datos.</li>
          <li><strong>Las fotografías y archivos no se incluyen en las exportaciones descargables</strong> por su tamaño; permanecen en almacenamiento privado y solo se exportan sus referencias.</li>
          <li>Los respaldos no garantizan recuperar información creada o modificada después de la última copia disponible (pérdida potencial de hasta 24 horas).</li>
          <li>La restauración agrega registros faltantes y no sobrescribe los existentes. El Cliente es responsable de los archivos que importa y de validar el resultado; BIOSKINTECH puede apoyar en su recuperación sin garantía de resultado.</li>
        </ul>
        <Note tone="amber">Se recomienda que el Cliente descargue y guarde en lugar seguro una exportación al menos semanal. Las exportaciones contienen datos sensibles: su custodia es responsabilidad del Cliente.</Note>
      </Section>

      <Section number={12} title="Servicios de terceros" icon={<Plug className="w-4 h-4" />}>
        <p>Las integraciones con Google (Calendar, Gmail, Gemini), Meta (WhatsApp), PayPhone y Cloudflare dependen de esos proveedores y de sus condiciones. BIOSKINTECH no responde por su disponibilidad, cambios, costos, bloqueos de cuentas ni por el tratamiento que realicen conforme a sus propias políticas.</p>
      </Section>

      <Section number={13} title="Disponibilidad y mantenimiento" icon={<RefreshCw className="w-4 h-4" />}>
        <p>BIOSKINTECH procura mantener la Plataforma disponible, pero <strong>no garantiza un nivel de disponibilidad específico</strong> ni la ausencia de errores. Podrá realizar mantenimientos y actualizaciones, informando con anticipación los planificados cuando sea razonablemente posible, y aplicar cambios urgentes por seguridad sin aviso previo.</p>
      </Section>

      <Section number={14} title="Limitación de responsabilidad" icon={<AlertCircle className="w-4 h-4" />}>
        <p>En la máxima medida permitida por la ley, BIOSKINTECH no responde por:</p>
        <ul className={ul}>
          <li>Actos médicos, diagnósticos, tratamientos, recetas, resultados estéticos o mala praxis de los profesionales que usan la Plataforma.</li>
          <li>Contenido del Cliente, su exactitud o su base legal, ni por resultados sugeridos por la IA.</li>
          <li>Pérdidas causadas por acciones u omisiones del Cliente o sus Usuarios (eliminaciones, importaciones, credenciales comprometidas, dispositivos inseguros).</li>
          <li>Fallas de proveedores externos, conectividad, fuerza mayor o ataques que superen medidas de seguridad razonables.</li>
          <li>Daños indirectos, lucro cesante, pérdida de oportunidades, reputación o clientela.</li>
        </ul>
        <Note tone="amber">La responsabilidad total de BIOSKINTECH frente al Cliente, por cualquier causa, no excederá el valor efectivamente pagado por el Cliente en los 12 meses anteriores al hecho que la origine. Esta limitación no aplica en caso de dolo.</Note>
      </Section>

      <Section number={15} title="Indemnidad" icon={<Handshake className="w-4 h-4" />}>
        <p>El Cliente mantendrá indemne a BIOSKINTECH, sus titulares y colaboradores frente a reclamos, sanciones, multas, costas y honorarios razonables derivados de: (a) la atención prestada a sus pacientes; (b) el tratamiento de datos sin base legal o en incumplimiento de la LOPDP por parte del Cliente; (c) el Contenido del Cliente; o (d) el incumplimiento de estas Condiciones por el Cliente o sus Usuarios.</p>
      </Section>

      <Section number={16} title="Recomendación a los pacientes" icon={<Users className="w-4 h-4" />}>
        <p>BIOSKINTECH no verifica ni certifica las credenciales de los profesionales registrados. Recomendamos a los pacientes validar al profesional o centro antes de cualquier procedimiento, por ejemplo en la <strong>SENESCYT</strong> y en los registros del <strong>Ministerio de Salud Pública</strong> y de la <strong>ACESS</strong>.</p>
      </Section>

      <Section number={17} title="Suspensión y terminación" icon={<Ban className="w-4 h-4" />}>
        <ul className={ul}>
          <li>BIOSKINTECH podrá suspender o terminar el servicio por falta de pago, incumplimiento grave, uso ilícito, riesgo para la seguridad de la Plataforma o de otros clientes, u orden de autoridad competente. En casos de riesgo inminente la suspensión puede ser inmediata.</li>
          <li>Ante denuncias fundadas de mala praxis o uso indebido de datos, BIOSKINTECH podrá suspender o no renovar la cuenta.</li>
          <li>El Cliente puede cancelar en cualquier momento escribiendo a <Mail />; la cancelación no genera reembolso.</li>
          <li>BIOSKINTECH puede discontinuar el servicio con al menos 30 días de aviso, habilitando la exportación de datos durante ese plazo.</li>
        </ul>
      </Section>

      <Section number={18} title="Fuerza mayor" icon={<CloudLightning className="w-4 h-4" />}>
        <p>Ninguna parte responde por incumplimientos causados por hechos fuera de su control razonable: desastres naturales, cortes de energía o telecomunicaciones, fallas o decisiones de proveedores de infraestructura, actos de autoridad, conflictos o ciberataques que superen medidas de seguridad razonables.</p>
      </Section>

      <Section number={19} title="Modificaciones y notificaciones" icon={<MailIcon className="w-4 h-4" />}>
        <ul className={ul}>
          <li>BIOSKINTECH puede modificar estas Condiciones. Los cambios se informan en el panel y deben aceptarse antes de continuar usándolo; la aceptación queda registrada con fecha, versión, IP y navegador.</li>
          <li>Si el Cliente no acepta una nueva versión, puede cancelar su suscripción conforme al Art. 17.</li>
          <li>Las notificaciones se realizarán al correo registrado por el Cliente o mediante el panel, y se consideran recibidas desde su envío.</li>
        </ul>
      </Section>

      <Section number={20} title="Disposiciones generales" icon={<FileText className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Estas Condiciones, la Política de Privacidad y las condiciones comerciales aceptadas al pagar constituyen el acuerdo íntegro entre las partes.</li>
          <li>Si alguna cláusula fuera declarada inválida, las demás seguirán vigentes.</li>
          <li>La falta de ejercicio de un derecho no implica renuncia a él.</li>
          <li>El Cliente no puede ceder este contrato sin autorización escrita. BIOSKINTECH puede cederlo en caso de reorganización, fusión o venta del negocio, notificándolo al Cliente.</li>
        </ul>
      </Section>

      <Section number={21} title="Ley aplicable y jurisdicción" icon={<Scale className="w-4 h-4" />}>
        <p>Estas Condiciones se rigen por las leyes de la <strong>República del Ecuador</strong>. Las partes intentarán resolver cualquier controversia de forma directa durante 30 días desde su notificación escrita; de no lograrlo, se someten a los <strong>jueces competentes de la ciudad de Cuenca, Ecuador</strong>.</p>
        <Note>Consultas y reclamos: <Mail /></Note>
      </Section>
    </LegalShell>
  );
}
