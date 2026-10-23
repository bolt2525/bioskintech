# WhatsApp coexistencia: conexión piloto

## Estado y alcance

Implementación del login y autorización por usuario, **no activación de recordatorios desde sus números**.

- El master habilita **Coexistencia ON/OFF** en la lista de usuarios. Es independiente de `whatsapp_bot_enabled`.
- Solo el usuario habilitado ve la tarjeta y el login en **Estado del sistema**. El interruptor global del piloto debe estar habilitado y Meta configurado para iniciar el login.
- Login, estado y eliminación de la credencial local se gestionan juntos en **Estado del sistema → WhatsApp coexistencia**, sin una opción adicional en Ajustes del dashboard.
- El número del chatbot y los resúmenes al personal se conservan. El webhook solo entrega al bot y al CRM global los eventos `messages` cuyo `metadata.phone_number_id` corresponde exactamente al número del sistema.
- **Los recordatorios automáticos del cron a pacientes quedan pausados para todos durante este piloto**, sin respaldo desde el número del sistema. No basta conectar el número para reactivarlos. Se mantienen los acuses y las respuestas a notificaciones históricas del chatbot.
- El piloto no importa contactos, historial, mensajes ni ecos de los números propios al CRM global ni los interpreta como comandos. Solicita las sincronizaciones requeridas por Meta y conserva sus IDs; **no verifica su finalización ni constituye todavía un inbox de coexistencia**. Los eventos firmados se reconocen sin guardar su contenido clínico.
- Meta devuelve la cuenta seleccionada. Se valida el acceso con el token canjeado, la app emisora y los permisos, y se comprueba `is_on_biz_app=true` y `platform_type=CLOUD_API`. Si no llega el ID de teléfono, el piloto solo admite una cuenta con un único número elegible; nunca elige arbitrariamente la primera cuenta/número.
- Los estados son `pending_validation`, `setup_failed` y `disconnected`: **no existe un estado activo de envío** en esta fase.

### Teléfonos del bot y atribución retenida

El alta/edición del teléfono de usuario, el perfil propio, la configuración del bot y su habilitación rechazan números presentes en `phone` o `whatsapp_staff_phone` de otro usuario, incluso inactivo o tombstone. También rechazan atribución de conversaciones a otra clínica o sin clínica; ante un error de comprobación no se guarda el número. Una conversación de la misma clínica requiere que esta siga operativa. El rechazo informa que el teléfono está asignado o retenido por atribución histórica.

No se borran teléfonos de tombstones, no se reasignan conversaciones ni se habilita la reutilización de identificadores. Cualquier transferencia segura requiere diseño y confirmación separados; desactivar el bot o una cuenta no libera su número.

## Correcciones a la guía inicial

1. Embedded Signup no es un formulario de PublicInput ni un login genérico de Facebook. Utiliza **Facebook Login for Business** con `config_id` y respuesta `code`; el backend canjea ese código. El SDK se carga desde `https://connect.facebook.net/es_LA/sdk.js`.
2. Para la variante v4 de coexistencia, `extras.featureType` es `whatsapp_business_app_onboarding`; `setup.coexistence=true` no sustituye esta configuración. `sessionInfoVersion: "3"` identifica el formato del evento, no la versión del flujo de signup.
3. En coexistencia se omite `/register`: el teléfono ya está registrado en WhatsApp Business.
4. No se verificó en la documentación oficial el endpoint `shared_waba_templates` de la guía. No se utiliza. Cada cuenta remitente necesita plantillas propias aprobadas; se podrá automatizar su creación mediante la API de plantillas, sin asumir que se comparte la aprobación.
5. La tabla real de usuarios es `clinic_users`, con ID `INTEGER` y `clinic_id UUID`, verificados en Neon. Las credenciales se almacenan cifradas y no se envían al navegador.

## Preparación de los usuarios

La coexistencia requiere **WhatsApp Business**, no la aplicación WhatsApp personal. Quienes usan WhatsApp personal deben revisar y realizar el cambio a Business, respaldar sus conversaciones y comprobar que conservan su información antes del onboarding. No deben borrar la cuenta ni dar de baja su número para este piloto.

La elegibilidad depende también del país, estado de la cuenta y requisitos vigentes de Meta. No se garantiza que todos los números puedan conectarse.

## Pasos en Meta, en orden

Los nombres de las secciones pueden variar según la interfaz y el estado de revisión de la app.

1. **Conservar la integración existente.** En Meta for Developers, abrir la app que ya utiliza el chatbot. Identificar App ID, portafolio empresarial asociado y producto/caso de uso WhatsApp. No eliminar el número del sistema, su token ni su webhook.
2. **Revisar el negocio proveedor.** Completar la verificación empresarial y revisar el alta como **Tech Provider**. Tener Cloud API funcionando con un número propio no acredita automáticamente permiso para incorporar los negocios de otros usuarios.
3. **Revisar acceso para terceros.** Tramitar App Review/Advanced Access para `whatsapp_business_management` y `whatsapp_business_messaging`, y Access Verification cuando Meta lo requiera. Preparar la demostración del login y del uso solicitado. En desarrollo, limitar las pruebas a negocios/cuentas de prueba autorizados por Meta; no prometer disponibilidad para clientes reales antes de aprobar estos requisitos.
4. **Configurar la app web.** Revisar dominio HTTPS real, política de privacidad y mecanismo de eliminación de datos en la configuración de la app. Habilitar Facebook Login for Business y registrar el dominio permitido del SDK. No usar una ruta con `#` como dominio ni inventar un callback OAuth: este flujo devuelve el código al SDK y lo canjea el backend.
5. **Crear la configuración de Embedded Signup.** En las configuraciones de Facebook Login for Business, crear/seleccionar el flujo de WhatsApp Embedded Signup compatible con **v4 y onboarding de WhatsApp Business app/coexistencia**. Configurar el token de integración empresarial y los activos/permisos requeridos siguiendo el asistente de Meta. Copiar su **Configuration ID**, distinto del App ID. Las versiones v2/v3 del flujo fueron anunciadas para deprecación el 15-10-2026; no preparar una nueva integración sobre ellas.
6. **Revisar webhooks sin reemplazar el bot.** Mantener la URL pública de `/api/whatsapp-chatbot`, su verify token y la firma con el App Secret de esa misma app. Revisar las suscripciones a `messages`, `account_update`, `history`, `smb_app_state_sync` y `smb_message_echoes`. El backend suscribe la app a la cuenta seleccionada al conectar (`/{waba_id}/subscribed_apps`).
7. **Configurar el servidor.** Aplicar la migración y las variables indicadas abajo. Habilitar primero un único usuario de prueba desde master. No introducir el App Secret ni tokens en el chat, código cliente, capturas o variables `VITE_`.
8. **Conectar el piloto.** Como ese usuario, abrir Estado del sistema → Preparar conexión → Continuar con Meta. Usar un número Business de prueba distinto del bot. Elegir la cuenta y completar las autorizaciones y comprobaciones que muestre Meta. Mantener abierta WhatsApp Business durante la sincronización.
9. **Validar onboarding, no solo el popup.** Confirmar en Meta la suscripción, el número, permisos y sincronizaciones. La documentación exige iniciar/sincronizar contactos e historial dentro de las primeras 24 horas; el backend solicita ambas al conectar. `pending_validation` significa solicitudes aceptadas, **no sincronización completa**. Si Meta informa un error de historial no compartido (`2593109`), distinguirlo de un fallo técnico. Un alta incompleta o un timeout requiere revisión antes de repetir: las solicitudes de sincronización son de una sola vez por alta.
10. **Preparar plantillas por cuenta.** Crear/someter las plantillas de recordatorio en la cuenta del piloto y comprobar estado, idioma, parámetros y botones. La aprobación de la cuenta del sistema no se transfiere automáticamente. No enviar mensajes reales a pacientes como prueba.
11. **Fase posterior, antes de activar envíos.** Implementar y validar persistencia/CRM por canal, ventana de 24 horas por remitente y destinatario, estados/confirmaciones por usuario y canal, sincronización y ecos, revocaciones y selección de plantilla aprobada por cuenta. Probar con datos ficticios dos usuarios compartiendo un mismo teléfono de paciente. Solo entonces habilitar el envío desde canales propios, mediante un cambio revisado y autorización expresa.

## Servidor y migración

Variables de servidor, además de las actuales de WhatsApp:

| Variable | Propósito |
|---|---|
| `WHATSAPP_COEXISTENCE_PILOT_ENABLED` | `false` por defecto. Kill switch del login; no habilita recordatorios. |
| `WHATSAPP_META_APP_ID` | App que emite el código y firma el webhook existente. |
| `WHATSAPP_SIGNUP_CONFIG_ID` | Configuración de Embedded Signup/Business Login. |
| `WHATSAPP_GRAPH_VERSION` | `v26.0`, versión consultada en la documentación oficial. Independiente de la versión del signup. No cambia la versión del envío legacy del bot. |
| `WHATSAPP_CHANNEL_ENCRYPTION_KEY` | 32 bytes aleatorios en hexadecimal, solo en servidor. Respaldar de forma segura; rotarla obliga a revincular. |
| `WHATSAPP_APP_SECRET` | Secreto de esa misma app, existente para firmas. |

Generar la clave localmente en una terminal privada con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` y guardarla en el gestor seguro de variables, no en este documento.

```powershell
node --env-file=.env.local scripts\migrate-whatsapp-channels.mjs
```

La migración es idempotente, transaccional y solo crea/expande el esquema en la misma base Neon. Añade el permiso por usuario y las tablas `user_whatsapp_channels` y `whatsapp_signup_attempts`. Las dos tablas son administrativas, como `clinic_oauth_tokens`: RLS habilitado, sin permisos para `PUBLIC` o `bioskin_app`; consultas privadas con usuario y clínica explícitos. El init multi-tenant incorpora el mismo esquema. La purga de clínica incluye ambas tablas. No ejecutar un reset ni crear otra base.

El challenge dura 10 minutos, es de un solo uso y está ligado a usuario, clínica y sesión; preparar otro intento está limitado a uno por minuto. El código y el token no se guardan en localStorage/sessionStorage. El token se cifra con AES-256-GCM ligado a clínica, usuario, cuenta y número. La finalización, desconexión y habilitación/revocación del master comparten un bloqueo **transaccional** de PostgreSQL, compatible con poolers. Si otra operación está en curso, se responde 409 y se debe reintentar; no se informa una desconexión exitosa mientras se está dando de alta.

No se crea ninguna función serverless nueva: continúan **11 archivos de función**. Acciones en `/api/whatsapp-chatbot`: `channelConfig` (GET), `channelStart`, `channelComplete` y `channelDisconnect` (POST). El permiso se modifica en `/api/admin-auth?action=setWhatsAppCoexistenceEnabled`, exclusivamente por master.

## Desconexión y errores

- **Desconectar de BIOSKIN** elimina la credencial local y cancela intentos. No llama a `/deregister`, no modifica el bot y no revoca el acceso de otras cuentas del mismo negocio.
- Completar la baja en **WhatsApp Business → Ajustes → Cuenta → Plataforma empresarial → Desconectar cuenta**, según la interfaz de la app. Revisar también las integraciones empresariales de Meta cuando corresponda.
- Deshabilitar la opción desde master elimina el token local e intentos del usuario. La baja remota sigue requiriendo la acción anterior. Un webhook firmado `PARTNER_REMOVED` elimina las credenciales de la cuenta afectada.
- Ante `setup_failed`, revisar permisos, suscripciones y solicitudes en Meta; no repetir automáticamente una sincronización. Si hay que reiniciar el alta, completar primero el offboarding en la app Business.
- No hay fallback automático al número del sistema. No se declara aprobado ni operativo un canal por el mero éxito de `FB.login`.

## MCP de Meta

El servidor oficial **WhatsApp Business Tools** es remoto: `https://mcp.facebook.com/whatsapp_business_tools`, transporte Streamable HTTP y OAuth de la cuenta de desarrollador. Es beta y su disponibilidad es gradual.

Sirve para que un asistente autorizado inspeccione negocios, números, plantillas y webhooks y realice operaciones administrativas. **No sustituye Embedded Signup ni debe ser el runtime de recordatorios multi-tenant.** No se ha instalado ni autorizado en este proyecto. Si se conecta desde un cliente MCP compatible, comenzar por consultas de solo lectura; crear plantillas, cambiar webhooks, registrar números o enviar mensajes requiere autorización específica. No usar la herramienta de registro normal para un número ya coexistente.

## Validación de esta fase

- Build Vite aprobado; 35 pruebas focalizadas de coexistencia/regresión del bot y 21 adicionales de administración/ciclo de vida aprobadas.
- Migración ejecutada dos veces en Neon: idempotencia comprobada. RLS habilitado y `bioskin_app` sin SELECT/INSERT en ambas tablas, verificados mediante consultas de privilegios. Bloqueo transaccional probado con conexiones concurrentes reales, sin leer datos de usuarios/pacientes.
- 38 comprobaciones del componente en navegador con APIs/SDK ficticios, más integración master/Estado del sistema/dashboard en escritorio y móvil. Corregido y vuelto a probar en Chromium real el caso de excepción síncrona del SDK (1440×1000 y 390×844).
- Lint de archivos nuevos aprobado. El lint de páginas existentes y TypeScript global siguen presentando errores previos fuera de esta tarea; no se afirma que estén limpios.
- No se realizó onboarding real ni envío en Meta. No se configura el MCP ni se cambian credenciales/productos/activos de Meta automáticamente.
- Cron real consultado contra Neon con los destinos HTTP ajenos a la base bloqueados: `sent=0`, `paused=true` y cero llamadas a Meta/Google.

## Fuentes oficiales consultadas

- [Coexistencia y sincronización](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Implementación de Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Alta como Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- [Access Verification](https://developers.facebook.com/documentation/development/release/access-verification)
- [Biblioteca de plantillas](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-library)
- [WhatsApp Business Tools MCP](https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp)
