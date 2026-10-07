import { Shield, Users, Database, Globe, Clock, UserCheck, FileText, Bell, HardDrive, Lock, AlertTriangle, Trash2, Brain, Baby, Server } from 'lucide-react';
import { LegalShell, LegalSection as Section, Note, Mail, ContactChannels } from '../components/legal/LegalLayout';

const ul = 'list-disc list-inside space-y-1.5 pl-1';

export default function PrivacyPolicy({ embedded = false }: { embedded?: boolean }) {
  return (
    <LegalShell
      embedded={embedded}
      title="Política de Privacidad y Tratamiento de Datos Personales"
      icon={<Shield className="w-7 h-7" />}
      intro={<>
        <p>
          Esta Política describe cómo la plataforma <strong className="text-gray-800">BIOSKINTECH</strong> (la "Plataforma") trata datos personales
          conforme a la <strong>Ley Orgánica de Protección de Datos Personales (LOPDP)</strong> de la República del Ecuador y su normativa secundaria.
          Aplica a las clínicas y profesionales que contratan la Plataforma (los "Clientes"), a sus colaboradores con acceso (los "Usuarios") y a los
          pacientes y personas cuyos datos registran los Clientes (los "Titulares").
        </p>
        <p>BIOSKINTECH es operada por <strong>Rafael Israel Larrea Galindo, RUC 0105872600001</strong>, con domicilio en Cuenca, Ecuador. Los canales para ejercer derechos y realizar consultas constan en el Art. 9.</p>
        <p className="text-xs text-gray-500">
          Esta Política forma parte integrante de las Condiciones de Servicio. Ante cualquier discrepancia sobre el tratamiento de datos de pacientes,
          prevalecen las instrucciones documentadas del Cliente como Responsable del Tratamiento, siempre que sean lícitas.
        </p>
      </>}
      footer={<p>Consultas y solicitudes: <Mail /> · WhatsApp +593 984 232 889</p>}
    >
      <Section number={1} title="Roles: quién es Responsable y quién es Encargado" icon={<UserCheck className="w-4 h-4" />}>
        <ol className="list-decimal list-inside space-y-2 pl-1">
          <li>
            <strong>Cliente = Responsable del Tratamiento</strong> de los datos de sus pacientes. El Cliente decide qué datos recoge, con qué finalidad,
            con qué base legal, durante cuánto tiempo los conserva y a quién los comunica. El Cliente es quien debe informar a sus pacientes y obtener
            su consentimiento cuando la ley lo exija.
          </li>
          <li>
            <strong>BIOSKINTECH = Encargado del Tratamiento</strong> de esos datos. Presta únicamente la infraestructura de software (SaaS) y trata
            los datos por cuenta del Cliente y según sus instrucciones, que se entienden dadas por la configuración y el uso que el Cliente hace de la Plataforma.
          </li>
          <li>
            <strong>BIOSKINTECH = Responsable</strong> únicamente de los datos de sus propios Clientes y Usuarios necesarios para prestar y cobrar el servicio
            (datos de cuenta, facturación, registros de acceso y seguridad, soporte y evidencias de aceptación de estos documentos).
          </li>
        </ol>
        <Note>
          BIOSKINTECH no decide sobre la atención clínica, no accede a fichas clínicas salvo que sea técnicamente indispensable para soporte, seguridad
          o una solicitud expresa del Cliente, y no utiliza los datos de pacientes para fines propios.
        </Note>
      </Section>

      <Section number={2} title="Bases de legitimación" icon={<FileText className="w-4 h-4" />}>
        <ul className={ul}>
          <li><strong>Datos de pacientes:</strong> la base de legitimación la determina y acredita el Cliente (consentimiento del Titular, ejecución de la relación de atención sanitaria o estética, cumplimiento de obligaciones legales o interés vital). La Plataforma ofrece herramientas —formularios, casillas de aceptación, consentimientos digitales— que el Cliente debe utilizar y adaptar a su realidad.</li>
          <li><strong>Datos de Clientes y Usuarios:</strong> ejecución del contrato de servicio, cumplimiento de obligaciones legales y tributarias, e interés legítimo en la seguridad de la Plataforma y la prevención del fraude.</li>
          <li><strong>Reservas públicas:</strong> consentimiento expreso que la persona otorga en el formulario de agendamiento a favor de la clínica que reserva.</li>
        </ul>
      </Section>

      <Section number={3} title="Categorías de datos tratados" icon={<Database className="w-4 h-4" />}>
        <p className="font-semibold text-gray-800">A. Clientes y Usuarios</p>
        <p>Nombres, cédula/RUC, registros profesionales (SENESCYT/ACESS), especialidad, correo, teléfono, datos de la clínica, credenciales (almacenadas solo como hash), dirección IP, navegador, dispositivos de confianza, sesiones, registros de auditoría y evidencias de aceptación de estos documentos.</p>
        <p className="font-semibold text-gray-800 mt-2">B. Pacientes (datos sensibles de salud)</p>
        <Note tone="amber">Los datos relativos a la salud son <strong>datos sensibles</strong> según la LOPDP y reciben el mayor nivel de protección disponible en la Plataforma.</Note>
        <ul className={ul}>
          <li>Identificación y contacto: nombres, tipo y número de identificación, fecha de nacimiento, género, estado civil, dirección, teléfono y correo.</li>
          <li>Ficha clínica: antecedentes, alergias, medicación, motivo de consulta, examen físico, diagnósticos, tratamientos, inyectables y lotes, recetas, notas y su historial de versiones.</li>
          <li>Marcaciones clínicas sobre mapas faciales/corporales 2D y modelos 3D (se almacenan como coordenadas y anotaciones, no como imágenes del paciente).</li>
          <li>Fotografías clínicas de evolución. <strong>No se utilizan para identificación biométrica automatizada.</strong></li>
          <li>Consentimientos informados: contenido aceptado, firma manuscrita digitalizada, fecha y hora, verificación por código enviado al correo (firma remota) y huellas de integridad (hash SHA-256).</li>
          <li>Datos económicos de la atención (ingresos, egresos y facturas registradas por el Cliente).</li>
          <li>Mensajes y recordatorios de citas por WhatsApp y correo, cuando el Cliente usa esas funciones.</li>
        </ul>
        <p className="font-semibold text-gray-800 mt-2">C. Personas que reservan en línea</p>
        <p>Nombre, correo, teléfono, tratamiento, fecha y hora solicitados, y datos técnicos de la verificación anti-bot.</p>
      </Section>

      <Section number={4} title="Obligaciones de BIOSKINTECH como Encargado" icon={<Lock className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Tratar los datos solo para prestar el servicio y según las instrucciones del Cliente.</li>
          <li>Exigir confidencialidad a las personas autorizadas para acceder a la infraestructura.</li>
          <li>Aplicar las medidas de seguridad descritas en el Art. 10.</li>
          <li>Recurrir solo a los proveedores (subencargados) listados en el Art. 5 y exigir garantías de protección apropiadas cuando actúen como tales.</li>
          <li>Asistir al Cliente, en la medida de lo técnicamente posible, para atender derechos de los Titulares e incidentes de seguridad.</li>
          <li>Al terminar el servicio, poner los datos a disposición del Cliente y luego eliminarlos conforme al Art. 13.</li>
        </ul>
        <p className="text-xs text-gray-500">Al aceptar esta Política, el Cliente otorga autorización general para el uso de los subencargados del Art. 5. Los cambios relevantes de proveedores se informarán mediante la actualización de este documento.</p>
      </Section>

      <Section number={5} title="Proveedores tecnológicos y transferencias internacionales" icon={<Globe className="w-4 h-4" />}>
        <p>Para operar, la Plataforma utiliza proveedores ubicados principalmente en <strong>Estados Unidos</strong>, lo que implica una transferencia internacional de datos:</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-gray-100 rounded-xl overflow-hidden">
            <thead className="bg-gray-50 text-gray-700"><tr><th className="text-left p-2">Proveedor</th><th className="text-left p-2">Uso</th><th className="text-left p-2">Cuándo</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              <tr><td className="p-2 font-medium">Neon (AWS us-east-1)</td><td className="p-2">Base de datos principal PostgreSQL</td><td className="p-2">Siempre</td></tr>
              <tr><td className="p-2 font-medium">Vercel</td><td className="p-2">Alojamiento de la aplicación y funciones de servidor</td><td className="p-2">Siempre</td></tr>
              <tr><td className="p-2 font-medium">Cloudflare</td><td className="p-2">Fotografías clínicas (R2), copias de seguridad diarias cifradas en un almacenamiento independiente de Neon y verificación anti-bot (Turnstile)</td><td className="p-2">Siempre / reserva pública</td></tr>
              <tr><td className="p-2 font-medium">Google</td><td className="p-2">Google Calendar y envío de correos desde la cuenta Gmail del Usuario; Gemini (IA)</td><td className="p-2">Si el Cliente conecta su cuenta o activa módulos de IA</td></tr>
              <tr><td className="p-2 font-medium">Meta (WhatsApp Business Platform)</td><td className="p-2">Recordatorios y avisos de citas</td><td className="p-2">Si el Cliente activa WhatsApp</td></tr>
              <tr><td className="p-2 font-medium">PayPhone u otras pasarelas</td><td className="p-2">Cobro de la suscripción con tarjeta. BIOSKINTECH no recibe ni almacena números de tarjeta. Los pagos por transferencia o efectivo no involucran a estos proveedores.</td><td className="p-2">Al pagar con tarjeta</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500">
          BIOSKINTECH es el interlocutor del Cliente y asume la selección y gestión de sus proveedores tecnológicos, la protección de la información y
          las garantías exigibles para las transferencias internacionales bajo la LOPDP. El Cliente no necesita gestionar las cuentas de infraestructura.
          La autorización del Cliente no sustituye esas garantías ni su deber de informar a los pacientes cuando corresponda.
        </p>
        <p className="font-semibold text-gray-800 mt-2">Garantías de seguridad de la infraestructura</p>
        <ul className={ul}>
          <li><strong>Vercel:</strong> aloja el entorno de producción de la aplicación y sus funciones de servidor. Ofrece conexiones HTTPS y protección automática frente a ataques de denegación de servicio (DDoS), descritas en su <a href="https://vercel.com/security" className="text-gold-dark underline">documentación de seguridad</a>. Publica un <a href="https://vercel.com/legal/dpa" className="text-gold-dark underline">acuerdo de tratamiento (DPA)</a> con medidas de seguridad y obligaciones de confidencialidad, gestión de subencargados y asistencia. BIOSKINTECH asume la contratación de las garantías aplicables al tratamiento del servicio.</li>
          <li><strong>Neon:</strong> la base PostgreSQL utiliza conexiones cifradas SSL/TLS. Neon documenta cifrado AES-256 de los datos en reposo y controles de autenticación en su <a href="https://neon.com/docs/security/security-overview" className="text-gold-dark underline">descripción de seguridad</a>. Sus <a href="https://neon.com/platform-terms" className="text-gold-dark underline">condiciones de plataforma</a> incluyen garantías contractuales de seguridad. La base principal está alojada en AWS us-east-1 (Estados Unidos).</li>
          <li><strong>Cloudflare R2:</strong> cifra automáticamente los objetos y sus metadatos en reposo con AES-256 y protege las transferencias mediante TLS, según su <a href="https://developers.cloudflare.com/r2/reference/data-security/" className="text-gold-dark underline">documentación de seguridad</a>. BIOSKINTECH mantiene las fotografías en almacenamiento privado, con acceso autorizado mediante enlaces firmados temporales. Cloudflare publica un <a href="https://www.cloudflare.com/cloudflare-customer-dpa/" className="text-gold-dark underline">DPA</a>, un <a href="https://www.cloudflare.com/security-exhibit/" className="text-gold-dark underline">anexo de seguridad</a> y su <a href="https://www.cloudflare.com/gdpr/subprocessors/" className="text-gold-dark underline">lista de subencargados</a>.</li>
          <li><strong>Compromiso de BIOSKINTECH:</strong> mantener controles de acceso por clínica y rol, credenciales de infraestructura exclusivamente en el servidor y copias cifradas de datos estructurados; documentar las finalidades, proveedores y mecanismos de transferencia aplicables; y atender incidentes y solicitudes de devolución o eliminación conforme a esta Política. A solicitud del Cliente facilitará información sobre esas medidas, preservando secretos y datos de otras clínicas.</li>
          <li><strong>Alcance:</strong> las garantías y certificaciones de cada proveedor corresponden a sus propios servicios y no se presentan como certificaciones de BIOSKINTECH. Las transferencias internacionales se gestionan conforme a la normativa ecuatoriana; los cambios relevantes de proveedores se comunicarán al Cliente.</li>
        </ul>
      </Section>

      <Section number={6} title="Inteligencia artificial" icon={<Brain className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Las funciones de IA son <strong>opcionales</strong>, están desactivadas por defecto y se habilitan por clínica.</li>
          <li>Cuando se usan, se envía a Google (Gemini) únicamente el contenido que el profesional selecciona (por ejemplo, textos de la ficha y, si lo incluye, el nombre del paciente) o la imagen de la factura a analizar.</li>
          <li>BIOSKINTECH no entrena modelos propios con datos de pacientes. El uso que el proveedor haga de la información se rige por sus términos de API.</li>
          <li>Las respuestas de la IA son sugerencias de apoyo y pueden contener errores. <strong>No constituyen diagnóstico ni prescripción</strong>; el profesional debe validarlas.</li>
          <li>Se recomienda al Cliente minimizar datos identificativos y obtener el consentimiento del paciente antes de usar IA con su información.</li>
        </ul>
      </Section>

      <Section number={7} title="Finalidades" icon={<UserCheck className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Gestionar fichas clínicas, agenda, consentimientos, inventario, finanzas y comunicaciones de la clínica.</li>
          <li>Autenticar usuarios, proteger la Plataforma, auditar cambios y prevenir accesos indebidos.</li>
          <li>Generar copias de seguridad y permitir la exportación y restauración de datos.</li>
          <li>Prestar soporte, cobrar el servicio y cumplir obligaciones legales.</li>
          <li>Elaborar métricas técnicas agregadas y anónimas de uso para mejorar el servicio, sin identificar a personas.</li>
        </ul>
        <Note tone="green">BIOSKINTECH <strong>no vende, alquila ni cede</strong> datos de Clientes o pacientes con fines publicitarios o ajenos al servicio.</Note>
      </Section>

      <Section number={8} title="Almacenamiento en el navegador y cookies" icon={<HardDrive className="w-4 h-4" />}>
        <ul className={ul}>
          <li>La Plataforma <strong>no utiliza cookies publicitarias ni de analítica de terceros</strong>.</li>
          <li>La sesión se guarda en el almacenamiento de la pestaña (<em>sessionStorage</em>) y expira como máximo a las 24 horas.</li>
          <li>El identificador de "dispositivo de confianza" (hasta 90 días) y algunas preferencias se guardan en <em>localStorage</em>.</li>
          <li>Componentes de terceros —inicio de sesión/conexión con Google y verificación Cloudflare Turnstile— pueden usar sus propias cookies técnicas.</li>
        </ul>
      </Section>

      <Section number={9} title="Derechos de los Titulares" icon={<Users className="w-4 h-4" />}>
        <p>Los Titulares pueden ejercer sus derechos de acceso, rectificación y actualización, eliminación, oposición, portabilidad, suspensión del tratamiento y a no ser objeto de decisiones basadas únicamente en valoraciones automatizadas, entre otros reconocidos por la LOPDP.</p>
        <Note tone="blue">
          <p className="font-semibold mb-1">Pacientes</p>
          <p>Deben dirigirse <strong>primero a la clínica o profesional que los atendió</strong>, que es el Responsable. Si una solicitud llega a BIOSKINTECH, la remitiremos a la clínica correspondiente en un plazo máximo de 5 días hábiles y la asistiremos técnicamente; BIOSKINTECH no puede modificar ni eliminar historias clínicas sin instrucción del Responsable.</p>
        </Note>
        <p><strong>Clientes y Usuarios</strong> pueden ejercer sus derechos sobre sus datos de cuenta por los canales oficiales, adjuntando documento de identidad:</p>
        <ContactChannels />
        <p>Si considera vulnerados sus derechos, puede acudir a la <strong>Superintendencia de Protección de Datos Personales</strong>.</p>
      </Section>

      <Section number={10} title="Medidas de seguridad" icon={<Server className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Comunicaciones cifradas (HTTPS/HSTS) y cifrado en reposo provisto por la infraestructura.</li>
          <li>Contraseñas con PBKDF2 y sal; verificación en dos pasos por correo en dispositivos nuevos; bloqueo temporal tras 5 intentos fallidos.</li>
          <li>Aislamiento de datos entre clínicas mediante controles de aplicación y políticas de seguridad a nivel de fila en la base de datos.</li>
          <li>Roles y alcances de acceso por usuario; registro de auditoría de cambios en fichas.</li>
          <li>Fotografías en almacenamiento privado con enlaces temporales firmados.</li>
          <li>Copia de seguridad diaria cifrada (AES-256) en un proveedor independiente de la base de datos principal, protegida contra borrado o modificación durante 30 días (ver Art. 12). Las fotografías no forman parte de estas copias.</li>
        </ul>
        <Note tone="amber">
          Ningún sistema es invulnerable. BIOSKINTECH asume una <strong>obligación de medios</strong>: aplicar medidas razonables y proporcionales al riesgo,
          no garantizar la ausencia absoluta de incidentes. La seguridad también depende de que el Cliente proteja sus credenciales, dispositivos y cuentas conectadas.
        </Note>
      </Section>

      <Section number={11} title="Incidentes de seguridad" icon={<AlertTriangle className="w-4 h-4" />}>
        <ol className="list-decimal list-inside space-y-1.5 pl-1">
          <li>BIOSKINTECH adoptará medidas para contener y mitigar el incidente.</li>
          <li>Como Encargado, notificará al Cliente afectado sin dilación indebida y dentro de las primeras <strong>24 horas naturales</strong> desde que tenga conocimiento de una violación que afecte sus datos, con la información disponible, y la completará progresivamente.</li>
          <li>No se espera a concluir la investigación para el aviso inicial. Este compromiso rige para todos los Clientes, no solo para quienes tengan un anexo particular; no sustituye los plazos legales ni constituye una garantía de detección inmediata.</li>
          <li>El Cliente, como Responsable de los datos de sus pacientes, notificará a la Superintendencia de Protección de Datos Personales y a los Titulares en los plazos de la LOPDP. BIOSKINTECH colaborará con la información técnica a su alcance.</li>
          <li>Respecto de los datos de los que BIOSKINTECH es Responsable, realizará directamente las notificaciones legales.</li>
        </ol>
      </Section>

      <Section number={12} title="Conservación y copias de seguridad" icon={<Clock className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Los datos clínicos se conservan mientras el Cliente mantenga su cuenta y según sus instrucciones. <strong>El Cliente es responsable de cumplir los plazos legales de conservación de historias clínicas</strong> antes de eliminar información.</li>
          <li>Las eliminaciones realizadas por el Cliente en la Plataforma son inmediatas en la base principal. Por protección de evidencia, no se permite eliminar pacientes con consentimientos firmados.</li>
          <li>Pueden subsistir copias residuales: hasta <strong>6 horas</strong> en el historial de recuperación de la base de datos y hasta <strong>35 días</strong> en las copias de seguridad cifradas, que se eliminan automáticamente al vencer ese plazo.</li>
          <li><strong>Fotografías clínicas:</strong> el respaldo automático estructurado guarda sus referencias. BIOSKINTECH realizará, bajo solicitud expresa y autorización del Master Admin, la entrega anual gratuita de originales y documentos clínicos legibles prevista en las Condiciones de Servicio; no es una réplica fotográfica periódica. Los originales se eliminan 30 días después de terminar la suscripción si no hay renovación. La descarga de ZIP temporales caduca a las 24 horas; BIOSKINTECH gestiona su eliminación mediante procedimientos de limpieza y reglas de retención independientes del almacenamiento de originales.</li>
          <li>Las exportaciones descargadas por el Cliente quedan bajo su exclusiva custodia y responsabilidad.</li>
          <li>Cuentas de prueba: si no se contrata el servicio al finalizar la prueba oficial (3 días, ampliable hasta 10) o un trial comercial concedido por escrito (hasta 30 días), el usuario se desactiva o la cuenta puede eliminarse con sus fotografías, sin obligación de conservar la información; si se contrata, los datos continúan durante el contrato.</li>
        </ul>
      </Section>

      <Section number={13} title="Fin del servicio" icon={<Trash2 className="w-4 h-4" />}>
        <ul className={ul}>
          <li>Durante la suscripción, el administrador de la clínica puede exportar sus datos en todo momento desde el módulo <strong>Base de Datos</strong>: respaldo técnico completo en formato JSON (restaurable en la Plataforma), tablas CSV para Excel y consentimientos firmados en documento legible.</li>
          <li>Estos formatos permiten la portabilidad. La entrega anual autorizada añade originales fotográficos, historias y consentimientos registrados en HTML legible e imprimible; no incluye adaptación a otro sistema ni documentos de papel no registrados.</li>
          <li>Tras el vencimiento o la cancelación, los datos se conservan <strong>30 días</strong> para renovación o para solicitar recuperación por los canales oficiales. La entrega anual no consumida del período terminado puede solicitarse dentro de ese plazo; otras entregas requieren acordar alcance y costos sin restringir derechos legales. El plazo de conservación no amplía el acceso ordinario a la Plataforma. Las fotografías pueden eliminarse al cumplirse ese plazo.</li>
          <li>Vencido ese plazo, BIOSKINTECH podrá eliminar o anonimizar los datos de los sistemas activos, salvo obligación legal. Hasta ejecutar ese procedimiento, los datos permanecerán restringidos y no se usarán para prestar un servicio vencido. Las copias residuales del Art. 12 permanecerán aisladas del uso ordinario hasta vencer su ciclo de retención.</li>
          <li>El Cliente puede solicitar la eliminación de la cuenta y sus datos activos. BIOSKINTECH confirmará por escrito el alcance ejecutado y las excepciones aplicables; esa confirmación no incluirá copias inmutables antes de que venza su retención ni datos cuya conservación exija la ley.</li>
        </ul>
      </Section>

      <Section number={14} title="Menores de edad y personas con capacidad limitada" icon={<Baby className="w-4 h-4" />}>
        <p>Cuando el Cliente registre datos de niñas, niños, adolescentes o personas que requieran representación, es su responsabilidad obtener el consentimiento de su representante legal y verificar su identidad. La Plataforma no está dirigida a menores como usuarios.</p>
      </Section>

      <Section number={15} title="Cambios a esta Política" icon={<Bell className="w-4 h-4" />}>
        <p>BIOSKINTECH podrá actualizar esta Política por cambios legales, técnicos o de proveedores. Cada versión se identifica con su fecha. Los Usuarios deberán aceptar la nueva versión en el panel antes de continuar usándolo; la aceptación queda registrada con fecha, versión, IP y navegador.</p>
      </Section>
    </LegalShell>
  );
}
