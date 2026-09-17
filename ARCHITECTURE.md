# BioSkinTech App — Arquitectura Verificada

**Fecha de auditoría:** 2026-09-07  
**Alcance:** BioSkinTech App únicamente. La división de Ingeniería Biomédica y servicio técnico queda fuera de este documento.

## 1. Estado ejecutivo

BioSkinTech App es una SPA de React 18 + TypeScript construida con Vite y TailwindCSS. Se despliega como aplicación estática en Vercel y expone funciones serverless Node.js bajo `/api/`. La persistencia principal está diseñada para Neon PostgreSQL; las fotografías clínicas usan Cloudflare R2 y la base almacena sus metadatos.

El build de producción pasa. El lint global no está limpio: en la línea base del 2026-09-07 reportó 471 errores y 54 warnings, principalmente en `src/**`. La superficie backend/R2 modificada durante esta auditoría pasa `node --check` y ESLint focalizado.

## 2. Evidencia de infraestructura

| Componente | Evidencia | Estado |
|---|---|---|
| Vercel | CLI autenticada; proyecto `bioskintech`; preset Vite; salida `dist`; Node 24.x | Confirmado en cuenta Vercel |
| Producción | `https://bioskintech.vercel.app` | Confirmado por CLI |
| Variables Vercel | `NEON_APP_URL`, `NEON_DATABASE_URL`, `POSTGRES_URL`, R2, Google, PayPhone, correo y master key aparecen cifradas en los entornos correspondientes | Nombres confirmados; valores no se leen |
| Cloudflare R2 | Bucket `bioskin-fotos`, creado 2026-08-04, región ENAM, clase Standard | Confirmado por MCP y Wrangler |
| R2 CORS | Orígenes BIOSKIN y localhost; métodos GET/PUT/DELETE/HEAD; headers restringidos | Confirmado en bucket |
| R2 credenciales | `R2_ACCESS_KEY_ID` (32 chars hex) y `R2_SECRET_ACCESS_KEY` (64 chars hex, SHA-256 del token) rotadas en Production y Preview el 2026-09-07; verificadas con round-trip real PUT→GET→DELETE contra el bucket | Confirmado funcional end-to-end |
| Neon | Diagnósticos ejecutados mediante `vercel env run`; host Neon, tipos, tablas y políticas consultados sin exponer secretos | Confirmado en entorno conectado |

La existencia de una variable en Vercel no demuestra por sí sola que su valor sea válido ni que el flujo de producción haya sido ejercitado.

## 3. Flujo de ejecución

```text
Navegador React/Vite
  -> /api/<handler>?action=<accion>
  -> authenticateRequest() para acciones privadas
  -> pool Neon apropiado
       - owner: inicialización, migraciones y operaciones administrativas
       - bioskin_app: consultas clínicas con RLS
  -> servicios externos cuando corresponde
       - Google Calendar/Gmail
       - Cloudflare R2
       - PayPhone
       - OpenAI/Gemini
```

### Funciones API detectadas

- `admin-auth.js`: autenticación, sesiones, clínicas, usuarios, configuración y OAuth.
- `ai-consultation.js`: consultas y generación asistida por IA.
- `backup.js`: exportación y restauración.
- `calendar.js`: eventos y agenda de Google Calendar.
- `external-finance.js`: finanzas externas.
- `payments.js`: flujo PayPhone.
- `records.js`: pacientes, expedientes, módulos clínicos, inventario y fotografías.
- `sendEmail.js`: correo y notificaciones.
- `whatsapp-chatbot.js`: verifica webhooks de WhatsApp Cloud API sobre el cuerpo crudo, autoriza por el teléfono canónico de un usuario activo y expone al `master_admin` el historial CRM. Consultas, reportes y recordatorios usan el OAuth, calendario y scopes del usuario identificado, no una cuenta compartida de clínica.
- `system-status.js`: diagnósticos de servicios.

La línea base histórica de `external_finance_records` y el flujo `external-finance.js` se conserva como legado para implementaciones futuras; en esta fase el bot y los reportes usan el conjunto operativo `financial_records` y el correo configurado en `finanzas.admin_email`.

El repositorio contiene 10 archivos de función bajo `/api/`. El límite efectivo de Vercel debe confirmarse contra el plan activo antes de crear nuevas rutas.

## 4. Capas de datos

### Auth y tenancy

La inicialización de `api/admin-auth.js` crea las tablas de clínicas, usuarios, sesiones, features, configuración, OAuth, OTP, dispositivos confiables, invitaciones, suscripciones y notificaciones. Los roles principales son `master_admin`, `clinic_admin` y `clinic_user`. Cada usuario tiene scopes independientes para pacientes (`access_scope`), finanzas (`finance_scope`) e inventario (`inventory_scope`); `calendar_scope` queda en `own` porque Google Calendar/Gmail siempre pertenece a la cuenta individual. Los valores válidos son `own` y `all`, y el servidor los aplica también a accesos directos por ID, estadísticas, exportaciones y mutaciones. `clinic_users.phone` se normaliza a formato Ecuador `593...`, debe ser inequívoco y autoriza al bot interno.

El CRM global de WhatsApp usa `whatsapp_contacts` (teléfono único, nombre opcional, clínica y último mensaje) y `whatsapp_messages` (dirección, contenido, medio, timestamp, estado e ID de Meta). `lib/whatsapp-service.js` persiste cada salida antes de llamar a Meta; el webhook registra entradas, evita repetir efectos ante reintentos y actualiza estados sin retroceder desde leído o fallido. La migración fuente está en `scripts/whatsapp-crm.sql`, también forma parte de `scripts/apply-migrations.mjs`, y la consulta cronológica solo se expone a `master_admin` en `/admin/master/whatsapp`.

El restablecimiento administrativo genera una clave temporal criptográfica en el servidor, reemplaza inmediatamente el hash anterior, elimina OTP de login pendientes y revoca todas las sesiones del usuario. `clinic_users.must_change_password` mantiene un aviso en el panel principal hasta que el usuario completa su cambio personal con verificación OTP. La clave temporal solo se devuelve en la respuesta no-cache del reset y puede enviarse al correo registrado mediante `sendResetCredentials`, que vuelve a verificar que la clave siga vigente antes de enviarla.

Las clínicas nuevas reciben deshabilitadas por defecto `treatment_notes_view`, `ai_consultation` y `clinical_3d`; el Master Admin debe activarlas explícitamente desde la configuración de módulos.

Estas tres features son opt-in: una fila ausente en `clinic_features` también equivale a deshabilitada y solo `enabled=true` concede acceso. Los contadores, tarjetas y toggles del Master Admin aplican la misma regla efectiva que `getFeatures()`; las features normales permanecen activas salvo un `enabled=false` explícito.

Los avisos administrativos al desarrollador cubren registro público, invitaciones, creación/edición de clínicas, conexión/desconexión Gmail y fallos completos de agendamiento; las citas exitosas no generan avisos al desarrollador. Calendar y correo requieren OAuth válido del usuario, sin fallback a service account o SMTP global. `clinic_oauth_tokens` conserva `clinic_id` para pertenencia, pero su identidad única es `clinic_user_id`; el estado OAuth es aleatorio, expira, se consume una sola vez y solo cada usuario puede vincular o desconectar su propia cuenta. La migración aplicada el 2026-09-16 asignó el único token legado inequívoco al usuario correspondiente.

### Fichas clínicas

`lib/neon-clinical-db.js` crea tablas para:

- pacientes y expedientes;
- antecedentes, consultas e historial;
- exámenes físicos y mapas JSONB;
- diagnósticos, tratamientos y recetas (`treatments.equipment_used` admite lista de equipos separados por coma —una sesión puede usar varias aparatologías—; `treatments.parameters JSONB` guarda un mapa `{ nombreEquipo: { campo: valor } }` capturado por equipo vía modal con plantillas según tipo de aparatología o manual; al guardar, el resumen legible de cada equipo se inserta/actualiza como bloque en `notes`, que sigue siendo texto libre editable);
- inyectables y `mapping_data` JSONB;
- consentimientos, tokens y firmas;
- inventario, lotes y movimientos;
- finanzas internas y partidas;
- auditoría, asignaciones y grupos;
- catálogos globales;
- `clinical_photos` con `r2_key` y metadatos.

Inventario agrupa visualmente los productos por el valor normalizado de `category`. El formulario permite escribir categorías nuevas y sugiere las categorías ya registradas o configuradas mediante `datalist`; búsqueda y filtros operan antes de la agrupación.

Las recetas mantienen compatibilidad con la tabla `prescriptions` existente y agregan columnas idempotentes para `prescription_mode`, vigencia y `regulatory_snapshot`. El modo `routine` es el predeterminado; `prescription` exige confirmación explícita antes de imprimir, muestra campos faltantes y reserva firma/sello manual. El registro profesional ACESS se almacena opcionalmente en `clinic_users.registro_acess` y se puede editar desde Mi Información. La migración oficial está en `scripts/apply-migrations.mjs` y fue aplicada en Neon el 2026-09-09.

Hay migraciones idempotentes embebidas en la inicialización. El código conserva migraciones históricas que intentan agregar `clinic_id` como `INTEGER` en algunas tablas, mientras el esquema actual declara `UUID`; esta compatibilidad debe auditarse sobre la base real antes de eliminarla.

### Fotos clínicas

El flujo actual tiene dos caminos:

1. `uploadPhotoProxy`: recibe base64, valida MIME permitido, limita el buffer a 4 MB, sube a R2 y registra metadatos.
2. `getPhotoUploadUrl` + `confirmPhotoUpload`: genera una URL PUT firmada, el cliente sube a R2 y luego confirma la metadata en Neon.

Las lecturas generan URLs firmadas temporales. `getPhotoUploadUrl` exige `content_length` y `generateUploadUrl` firma el `ContentLength` exacto, rechazando por encima de 4 MB antes de emitir la URL. El código no demuestra object versioning ni cifrado de aplicación adicional al TLS/presigned-URL; esos puntos siguen dependiendo de configuración de proveedor.

**Reset de producción (2026-09-07):** se vació el bucket (47 → 0 objetos reales, confirmado por `GET .../objects`) y se limpiaron las 46 filas huérfanas de `clinical_photos` (0 tras el borrado), ya que las credenciales previas eran un placeholder roto (`[REDACTED]`, 11 caracteres) que impedía cualquier operación real. Se generó un token R2 nuevo desde el dashboard de Cloudflare, se cargaron `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` reales en Vercel (Production y Preview) y se verificó con una prueba real de subida, lectura y borrado contra el bucket (`PUT` → `GET` 200 con contenido íntegro → `DELETE` → `GET` posterior 404). El código de `deletePhoto` fue revisado línea por línea y es correcto: borra el objeto R2 primero y solo si eso tiene éxito borra la fila en Neon, por lo que no genera huérfanos nuevos.

## 5. RLS y aislamiento

`scripts/setup-bioskin-role.mjs` configura el rol `bioskin_app`, habilita `FORCE ROW LEVEL SECURITY` y crea políticas por `clinic_id` para tablas clínicas. `withTenantContext()` usa una transacción y `set_config(..., true)`.

La comprobación conectada del 2026-09-07 confirmó RLS habilitado y forzado para `patients`, `clinical_photos`, `financial_records` y `external_finance_records`, con políticas separadas de `SELECT`, `INSERT`, `UPDATE` y `DELETE` para `bioskin_app`. Una prueba de solo lectura con dos clínicas confirmó que cada tenant solo ve sus propias filas y que sin contexto no se devuelven filas clínicas.

Durante esta auditoría se corrigió un riesgo importante: `getAppPool()` ya no degrada silenciosamente a `neondb_owner` cuando falta `NEON_APP_URL`; devuelve `null` y obliga al endpoint a fallar cerrado. La prueba conectada con dos tenants confirmó el aislamiento real.

Las operaciones de fotos también validan que el expediente pertenezca al tenant efectivo y que las lecturas se filtren por `record_id` y `clinic_id`. Las claves R2 confirmadas deben pertenecer al prefijo de la clínica y expediente, y el proxy rechaza imágenes vacías o mayores de 4 MB.

## 6. Seguridad confirmada en código

- Contraseñas con PBKDF2 y salt usando Node crypto.
- Claves temporales generadas con `crypto.randomInt`, sesiones revocadas y aviso persistente de reemplazo.
- Sesiones Bearer persistidas en `admin_sessions` con expiración.
- Bloqueo de login después de intentos fallidos según la lógica de auth.
- Consultas SQL parametrizadas en las superficies revisadas.
- CORS con lista de orígenes permitidos en los handlers revisados.
- Presigned URLs para R2; el bucket no se declara público en el código.
- Headers de seguridad en `vercel.json`.
- Auditoría de operaciones clínicas mediante `patient_audit_log`, aunque algunos fallos de auditoría se silencian.
- Variables privadas sin prefijo `VITE_` en la configuración revisada.
- El webhook de WhatsApp deshabilita el body parser, valida `hub.verify_token` en el challenge y verifica `X-Hub-Signature-256` sobre los bytes originales con `WHATSAPP_APP_SECRET` antes de parsear JSON.
- Las consultas del CRM de WhatsApp exigen una sesión Bearer vigente y rol `master_admin`; las entradas se parametrizan, los teléfonos y enums se validan y las respuestas usan `Cache-Control: private, no-store`.
- El cron de recordatorios exige `Authorization: Bearer $CRON_SECRET` y procesa cada usuario con OAuth propio; cada teléfono recibe solo el resumen de su calendario.
- El bot solo responde a un `clinic_users.phone`/`whatsapp_staff_phone` activo **y con `whatsapp_bot_enabled = true`** (deshabilitado por defecto, solo lo activa `master_admin` por usuario vía `setWhatsAppBotEnabled`). Los números se almacenan canónicos y los desconocidos, ambiguos o con el bot deshabilitado se ignoran sin revelar información.
- El menú financiero respeta `finanzas_visible`, `finance_scope` y grupos de compartición. Genera CSV de `financial_records` para el rango permitido y lo envía desde/al correo OAuth del usuario.
- Menú de clínica consolidado en una sola opción "Agenda" (`agendaMenuStateByPhone`) con submenú: ver citas de hoy, ver citas de otro día (`agendaDateStateByPhone`, stage `awaitingDate`), reprogramar cita y eliminar cita. `parseFlexibleDate()` acepta "hoy"/"mañana"/`DD/MM/AAAA`/`DD-MM-AAAA`/`AAAA-MM-DD` y valida que la fecha exista realmente (rechaza desbordes tipo 31/02). `parseFlexibleTime()` valida horas en 24h o `am/pm`. `getAppointmentsForDate()` centraliza la consulta a Google Calendar (con id de evento, teléfono y duración) para listados, reprogramación y eliminación; `rescheduleStateByPhone`/`deleteStateByPhone` gestionan esos flujos multi-paso (`calendar.events.patch`/`calendar.events.delete`). Todos los listados de citas incluyen enlaces `wa.me` al paciente cuando hay teléfono registrado en el evento.
- Canal separado de soporte técnico interno: números listados en `WHATSAPP_SYSTEM_STAFF_PHONES` (env var, no en código fuente) se enrutan a `handleSystemStaffMessage()` en vez de al flujo de `clinic_users`, con su propio menú (estado de servicios, conteo de clínicas/usuarios, conexiones Google OAuth por clínica, mensajes fallidos de WhatsApp en 24h, y una opción de pregunta libre respondida por Gemini). La IA solo recibe texto ya agregado por consultas SQL fijas del propio código — no tiene acceso directo a la base de datos ni ejecuta consultas arbitrarias, para acotar el riesgo de inyección de prompts o fuga de datos.
- `lib/whatsapp-service.js` envía mensajes vía WhatsApp Cloud API (Graph API) y falla cerrado si `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` no están configuradas; `api/sendEmail.js` lo invoca en el agendamiento solo si el usuario que agenda tiene `clinic_users.whatsapp_bot_enabled = true` **y** `whatsapp_confirm_enabled = true`, sin bloquear el flujo de calendario/correo si falla. Ambos flags son por usuario: `whatsapp_bot_enabled` solo lo activa `master_admin` (botón en la tabla de usuarios de `/admin/master`); `whatsapp_confirm_enabled`, `whatsapp_summary_7am`, `whatsapp_summary_7pm`, `whatsapp_staff_phone` y `whatsapp_finance_phone` los edita el propio usuario en Ajustes → "Bot de WhatsApp" (bloqueado en la UI y rechazado en el backend con 403 si `whatsapp_bot_enabled` es `false`). El mensaje de confirmación (texto libre y plantilla) incluye el nombre del profesional que agendó (`gentilicio` + `full_name`).
- Meta exige una plantilla de mensaje (HSM) aprobada para notificaciones iniciadas por el negocio fuera de la ventana de servicio al cliente de 24h (es decir, cuando el paciente o el staff no le ha escrito antes al número ese día). `lib/whatsapp-crm.js#isWithinCustomerServiceWindow()` revisa si hubo un mensaje entrante del contacto en las últimas 24h; si sí, se envía texto libre con `sendWhatsAppText()`, si no, se usa `sendWhatsAppTemplate()` con parámetros **nombrados** (`{{nombre_variable}}`, requerido por el editor actual de Meta — los posicionales `{{1}}` ya no se aceptan). Esto aplica tanto a la confirmación de cita al paciente (`WHATSAPP_TEMPLATE_APPOINTMENT`/`WHATSAPP_TEMPLATE_APPOINTMENT_LANG`, plantilla `confirmacion_cita`, categoría Utility, con variables `nombre_paciente`, `nombre_clinica`, `nombre_usuario`, `servicio`, `fecha_hora`) como al resumen diario de agenda al staff (`WHATSAPP_TEMPLATE_DAILY_SUMMARY`/`WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG`, plantilla `agenda_diaria_staff`, categoría Marketing, con variables `fecha`/`resumen`). Sin esas plantillas aprobadas en Meta Business Manager y sin esas env vars, el envío fuera de ventana falla con un mensaje de error explícito registrado en `whatsapp_messages` (status `fallido`).
- Precios de Meta (per-message desde jul-2025, no por conversación): las plantillas **Marketing se cobran siempre** al enviarse, sin excepción por ventana de 24h abierta. Solo las plantillas **Utility** y los mensajes de **texto libre** (`type: text`) son gratis dentro de la ventana de servicio al cliente. El ahorro de costo real en `agenda_diaria_staff` (Marketing) no viene de la plantilla en sí, sino de que `isWithinCustomerServiceWindow()` evita usarla por completo (envía texto libre gratis) mientras el staff siga respondiendo dentro de las 24h.
- El enlace `wa.me` incluido en el resumen diario de agenda abre WhatsApp con el chat del **paciente** (`appointment.phone`, extraído de la descripción del evento de Google Calendar), no del número de la clínica; permite que el staff envíe un recordatorio personalizado directo al paciente desde su propio WhatsApp, sin pasar por la API de Meta ni requerir plantilla.
- `api/sendEmail.js` exige sesión administrativa y deriva clínica, usuario OAuth y teléfono de notificación desde esa sesión; no confía en esos identificadores enviados por el cliente. `WHATSAPP_APP_SECRET` debe existir en Production para aceptar eventos reales de Meta.

## 7. Riesgos abiertos

1. El lint global falla y mantiene deuda previa del frontend.
2. El rate limiting de `middleware.js` vive en memoria y no persiste entre instancias Edge.
3. La CSP permite `unsafe-inline` y `unsafe-eval`; debe revisarse contra el bundle y una estrategia de nonce/hash antes de endurecerla.
4. La validación de magic bytes y dimensiones reales de imágenes todavía no está implementada (solo se valida `Content-Type` declarado y tamaño).
5. No debe prometerse object versioning, cifrado en reposo, backups automáticos, alta disponibilidad o cumplimiento legal específico sin evidencia de proveedor/configuración.
6. La firma digital está implementada como captura y persistencia de firma/declaraciones; su validez jurídica depende del marco legal y del procedimiento de la clínica.
7. El bucket `bioskin-fotos` quedó vacío tras el reset del 2026-09-07; cualquier foto clínica anterior a esa fecha debe volver a subirse.

## 8. Comandos de validación ejecutados

- `npm run build` — pasa; Vite genera `dist/` con advertencia de chunks grandes.
- `npm run lint` — falla en línea base con 471 errores y 54 warnings.
- `node --check api/records.js` — pasa.
- `node --check lib/neon-clinical-db.js` — pasa.
- `node --check lib/r2-service.js` — pasa.
- `npx eslint api/records.js lib/neon-clinical-db.js lib/r2-service.js` — pasa.
- `npm run test:security` — 13 pruebas pasan tras integrar la auditoría de WhatsApp.
- `npm run build` — pasa con la vista CRM de WhatsApp y su ruta master.
- `node scripts/apply-migrations.mjs` — creó las tablas e índices CRM en Neon; consulta posterior confirmó `whatsapp_contacts`, `whatsapp_messages` y sus índices.
- Prueba negativa sin `NEON_APP_URL` — pasa; no hay fallback a `neondb_owner`.
- Generación local de URLs R2 con credenciales sintéticas — pasa; endpoint, clave, algoritmo y TTL esperados.
- Prueba RLS conectada con dos clínicas — pasa; 7 filas propias para una clínica, 0 para la otra y 0 sin contexto.
- Migración idempotente `scripts/init-schema.mjs` — pasa; creó `external_finance_records` y aplicó RLS/políticas.
- Vercel CLI — proyecto y nombres de variables confirmados sin revelar valores.
- Cloudflare MCP/Wrangler — bucket y reglas CORS confirmados.
- Reset real de R2: `DELETE` de 47/47 objetos vía API de Cloudflare — confirmado `count: 0`.
- Limpieza real de Neon: `DELETE FROM clinical_photos` — 46/46 filas eliminadas, confirmado `count: 0`.
- Rotación de credenciales R2: nuevo Access Key ID (32 hex) y Secret Access Key (64 hex) cargados en Vercel Production y Preview.
- Prueba funcional real end-to-end (`scripts/verify-r2-e2e.mjs`) contra Production — pasa: PUT, GET (200, contenido íntegro), DELETE, GET posterior (404).
- Redeploy de Production tras cada cambio de variables de entorno R2 — `Ready` ambas veces.
