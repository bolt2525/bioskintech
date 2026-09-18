# Progreso de BioSkinTech App

## Auditoría integral

- ✅ 2026-09-07 Confirmado stack real: React/Vite, Vercel, Neon y Cloudflare R2.
- ✅ 2026-09-07 Corregido inventario documental de APIs y eliminado referencias SQLite/legacy.
- ✅ 2026-09-07 Neon falla cerrado sin `NEON_APP_URL`; no usa el pool administrador como fallback.
- ✅ 2026-09-07 Reforzado aislamiento de fotos por expediente y clínica.
- ✅ 2026-09-07 Limitado el proxy de fotos a 4 MB y validado el tipo de foto.
- ✅ 2026-09-07 Firmada la longitud máxima de 4 MB en subidas directas R2.
- ✅ 2026-09-07 Corregido IDOR en finanzas externas y whitelist de actualizaciones SQL.
- ✅ 2026-09-07 Creada `external_finance_records` con `clinic_id UUID` y RLS real.
- ✅ 2026-09-07 Validado RLS conectado con dos clínicas reales.
- ✅ 2026-09-07 Añadidos 5 tests nativos de seguridad.
- ✅ 2026-09-07 Confirmados en Vercel los nombres cifrados de variables críticas.
- ✅ 2026-09-07 Confirmados bucket `bioskin-fotos` y CORS en Cloudflare.
- ✅ 2026-09-07 Detectado (por consulta real, no por documento) que `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` en Production eran un placeholder roto (`[REDACTED]`, 11 chars).
- ✅ 2026-09-07 Vaciado el bucket `bioskin-fotos` (47→0 objetos) y limpiadas las 46 filas huérfanas de `clinical_photos` (etapa de pruebas, autorizado explícitamente).
- ✅ 2026-09-07 Revisado línea por línea `deletePhoto`: confirmado correcto, no genera huérfanos (borra R2 antes que la fila en Neon).
- ✅ 2026-09-07 Generado token R2 real en Cloudflare y cargadas credenciales reales en Vercel (Production y Preview) tras varios intentos fallidos por: variables marcadas "Sensitive" que `--force` no sobreescribe, y comas sin comillas interpretadas como array por PowerShell.
- ✅ 2026-09-07 Verificado con round-trip real (PUT→GET→DELETE→GET) que R2 es funcional end-to-end en Production.
- ✅ 2026-09-07 Redeploy de Production tras cada cambio de variables R2.
- ✅ 2026-09-07 Creada instrucción obligatoria `.github/instructions/architecture-sync.instructions.md` para mantener ARCHITECTURE.md/PROGRESS.md sincronizados con cualquier cambio de estructura o capas.
- ✅ 2026-09-09 Desactivados por defecto módulos IA, 3D y vista de tratamiento.
- ✅ 2026-09-09 Corregido frontmatter de instrucción de arquitectura.
- ✅ 2026-09-09 Añadidos modos rutina/receta y revisión previa de impresión.
- ✅ 2026-09-09 Añadidos vigencia, ACESS opcional y firma/sello manual.
- ✅ 2026-09-09 Verificado proyecto Neon BIOSKINTECH, RLS y migración real de recetas/ACESS.
- ✅ 2026-09-09 Actualizadas dependencias runtime; `npm audit --omit=dev` quedó en 0 vulnerabilidades.
- ✅ 2026-09-09 Migrado middleware Vercel a runtime Node.js y verificado deployment Production Ready.
- ✅ 2026-09-09 Tab Tratamientos: agrupación por procedimiento activa por defecto; nuevo modal de parámetros estructurados (equipo/sesión) usando la columna `parameters JSONB` ya existente en `treatments`, con plantillas por tipo de aparatología (láser, RF, HIFU, peeling, corporal) y plantilla "manual/sin aparatología" + campos libres para casos sin equipo.
- ✅ 2026-09-09 Rediseñado el campo "Equipo Utilizado" como lista (chips) que admite múltiples equipos por sesión; cada equipo se registra con botón "Añadir" que abre el modal de parámetros, y al guardar se inserta un resumen legible por equipo en "Notas" (editable). `equipment_used` ampliado de VARCHAR(100) a TEXT.
- ✅ 2026-09-09 Fix de seguridad: `savePhysicalExam`, `saveDiagnosis`, `addTreatment`/`updateTreatment` ya no aceptan `clinic_id` del cliente en el whitelist genérico (causaba `column "clinic_id" specified more than once` al duplicar un tratamiento, y permitía sobreescribir el tenant vía update). `clinic_id` ahora lo fija siempre el servidor.
- ✅ 2026-09-09 "Duplicar" en Tratamientos ahora guarda de inmediato la nueva sesión (POST real, nuevo id), la selecciona y la resalta unos segundos en el historial; grupos por procedimiento inician contraídos por defecto.
- ✅ 2026-09-09 Resalte visual (anillo dorado con pulso, acorde al tema del proyecto) ahora también se aplica al presionar "Guardar" en Tratamientos, Examen Físico, Recetas e Inyectables — resalta el ítem guardado/creado en su historial. `savePhysicalExam` ahora retorna el `id` de la fila creada/actualizada para soportarlo.

- ✅ 2026-09-09 Documentadas CLIs Vercel, Neon y Wrangler instaladas, autenticadas y configuradas.
- ✅ 2026-09-09 Corregido layout responsive y scrollbar visible del listado de medicamentos.
- ✅ 2026-09-09 Corregido envío de alertas de registro y reconexión OAuth inválida.
- ✅ 2026-09-09 Separadas alertas administrativas y bloqueado agendamiento sin Gmail OAuth de clínica.
- ✅ 2026-09-09 Compactado layout visual del tab Recetas.
- ✅ 2026-09-09 Implementadas claves temporales y envío seguro de credenciales.
- ✅ 2026-09-09 Corregidos conteos visuales de módulos opt-in.
- ✅ 2026-09-15 Añadido webhook inicial de WhatsApp Cloud API con verificación de token.
- ✅ 2026-09-15 Conectado envío real de confirmación de cita por WhatsApp Cloud API (opt-in por clínica vía `notificaciones.whatsapp_enabled`).
- ✅ 2026-09-15 Añadido cron diario (Vercel Cron, 7am Ecuador) de recordatorios de cita por WhatsApp; opt-in independiente `agenda.daily_reminder_whatsapp`, requiere Google Calendar conectado.
- ✅ 2026-09-15 Añadida columna `clinic_users.phone` (Mi Información) y campo `agenda.finance_admin_phone`; bot de WhatsApp ahora autoriza por número y responde consultas de citas del día al staff reconocido (base para el módulo de finanzas por chat, pendiente).
- ✅ 2026-09-16 Implementado menú de finanzas en el bot de WhatsApp: selección diaria/semanal/mensual y envío de CSV por Gmail al correo financiero configurado de la clínica; `external_finance_records` queda como flujo legado y no se usa en esta fase.
- ✅ 2026-09-16 Recordatorios WhatsApp reorganizados: resúmenes al staff autorizado a las 07:00 (citas del día) y 19:00 (citas del día siguiente), con enlaces manuales por paciente; teléfonos de usuarios visibles y editables desde gestión de usuarios.
- ✅ 2026-09-16 Endurecido WhatsApp: firma Meta obligatoria, agendamiento autenticado por clínica y autorización del bot con teléfonos normalizados sin coincidencias ambiguas.
- ✅ 2026-09-16 Diagnosticado por qué no llegaban WhatsApp de confirmación de cita: `notificaciones.whatsapp_enabled` estaba en `false` para TODAS las clínicas (solo editable por Master Admin) — sin registro alguno en `whatsapp_messages` porque el código nunca intentaba el envío. Activado para la clínica de prueba. Además, Meta exige plantilla aprobada (HSM) para mensajes iniciados por el negocio fuera de la ventana de 24h de servicio al cliente; añadida `sendWhatsAppTemplate()` e `isWithinCustomerServiceWindow()` con fallback automático texto→plantilla vía `WHATSAPP_TEMPLATE_APPOINTMENT`/`WHATSAPP_TEMPLATE_APPOINTMENT_LANG` (pendiente crear y aprobar la plantilla en Meta Business Manager).
- ✅ 2026-09-16 "Ajustes → Agenda" (dashboard de usuario): el campo `finance_admin_phone` ahora se precarga automáticamente con el teléfono registrado del admin (`clinic_users.phone`) en lugar de mostrarse vacío con solo un placeholder; se puede editar o restaurar con un botón "Usar mi teléfono registrado".
- ✅ 2026-09-16 Movido el toggle `notificaciones.whatsapp_enabled` (confirmación de cita por WhatsApp) también al dashboard de usuario ("Ajustes → Agenda", solo `clinic_admin`), ya no depende exclusivamente de Master Admin. Aplicado el mismo patrón ventana-24h→plantilla al resumen diario de agenda para staff (`WHATSAPP_TEMPLATE_DAILY_SUMMARY`/`_LANG`), que también es un mensaje iniciado por el negocio.
- ✅ 2026-09-16 Plantilla `confirmacion_cita` ampliada a 5 variables (paciente, clínica, usuario que agendó, servicio, fecha/hora) tomadas del modal de agendamiento y de la sesión autenticada. Corregido bug en el enlace `wa.me` del resumen diario: apuntaba al número de la clínica en vez de al del paciente (`appointment.phone`), lo que impedía que el staff enviara el recordatorio personalizado directo al paciente. Creadas en Vercel (Production) las env vars `WHATSAPP_TEMPLATE_APPOINTMENT`, `WHATSAPP_TEMPLATE_APPOINTMENT_LANG`, `WHATSAPP_TEMPLATE_DAILY_SUMMARY`, `WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG` (valores `confirmacion_cita`/`resumen_diario_agenda`/`es_MX`) — pendiente que el usuario cree y apruebe las plantillas homónimas en Meta Business Manager.
- ✅ 2026-09-16 Meta rechazó los parámetros posicionales `{{1}}`/`{{2}}` en el editor nuevo de plantillas (exige `{{nombre_variable}}` en minúscula/guiones bajos). `sendWhatsAppTemplate()` reescrito para enviar `parameter_name` con un objeto de parámetros nombrados en vez de un arreglo posicional.
- ✅ 2026-09-17 Plantilla `resumen_diario_agenda` reclasificada por Meta a Marketing por incluir botón/CTA de confirmación; se creó `recordatorio_citas` (sin CTA) y luego, a pedido explícito, una tercera plantilla `agenda_diaria_staff` como Marketing desde el inicio (con botón "Ver opciones"). Verificado contra la documentación oficial de precios de Meta (per-message, vigente desde jul-2025): las plantillas Marketing **siempre se cobran** al enviarse, sin excepción por ventana de 24h abierta; solo las plantillas Utility y los mensajes de texto libre son gratis dentro de esa ventana. El ahorro real en el código viene de que `isWithinCustomerServiceWindow()` evita la plantilla por completo (usa texto libre) cuando la ventana sigue abierta, no de que la plantilla Marketing se vuelva gratis. `WHATSAPP_TEMPLATE_DAILY_SUMMARY` en Vercel apunta ahora a `agenda_diaria_staff`; `recordatorio_citas` queda sin uso (no se pudo eliminar en Meta por estar en revisión).
- ✅ 2026-09-17 Corregido bug real en `parseAppointmentEvent`: si el evento de Google Calendar no traía "Teléfono:" en la descripción, la cita se omitía por completo del resumen diario en vez de listarse sin el enlace de recordatorio. Ahora toda cita con prefijo "Cita: " se lista siempre; el enlace `wa.me` solo se omite si falta el teléfono del paciente.
- ✅ 2026-09-17 Nuevo flujo del bot de WhatsApp: opción 3) "Consultar agenda de otro día" con máquina de estados (`agendaDateStateByPhone`) que acepta "hoy", "mañana", `DD/MM/AAAA` o `AAAA-MM-DD`, valida fechas reales (rechaza 31/02, etc.) y reintenta si el formato no se reconoce.
- ✅ 2026-09-17 Nuevo canal de soporte técnico interno por WhatsApp para números de staff del sistema (no clinicas/pacientes), separado por completo del bot de clinicas: `WHATSAPP_SYSTEM_STAFF_PHONES` (env var, no hardcodeado) define los números autorizados. Menú propio con estado de servicios (DB/Email/WhatsApp), conteo de clinicas/usuarios, conexiones Google OAuth por clinica, mensajes de WhatsApp fallidos (24h) y una opción de pregunta libre respondida por Gemini usando solo datos reales pre-consultados (sin acceso directo de la IA a la BD).
- ✅ 2026-09-17 Control de habilitación del bot de WhatsApp por usuario: nuevas columnas `clinic_users.whatsapp_bot_enabled` (deshabilitado por defecto, solo `master_admin` lo activa desde un botón en la tabla de usuarios de `/admin/master`), `whatsapp_confirm_enabled`, `whatsapp_summary_7am`, `whatsapp_summary_7pm`, `whatsapp_staff_phone`, `whatsapp_finance_phone`. El bot ahora exige `whatsapp_bot_enabled = true` para responder a cualquier número de staff (antes solo verificaba `clinic_users.phone`). Nuevas acciones `getWhatsAppBotConfig`/`saveWhatsAppBotConfig` (usuario propio, rechazadas con 403 si el bot no está habilitado) y `setWhatsAppBotEnabled` (solo master_admin) en `api/admin-auth.js`.
- ✅ 2026-09-17 Nueva pestaña "Bot de WhatsApp" en el dashboard de usuario (separada de "Agenda"): confirmación de cita al paciente y resúmenes de agenda (7am/7pm, ahora independientes) aparecen bloqueados hasta que master_admin habilite el bot; incluye campos editables (con botón de edición) para el número de staff y el número de finanzas, precargados en gris con el teléfono registrado en BD. Eliminados del dashboard los campos legacy `notificaciones.whatsapp_enabled` y `agenda.finance_admin_phone` (nunca se leían desde el bot; quedaban huérfanos en `clinic_settings`).
- ✅ 2026-09-17 Rediseñada la máquina de estados del bot: una sola opción "Agenda" con submenú (ver citas de hoy, ver citas de otro día, reprogramar cita, eliminar cita). Nuevos flujos multi-paso `rescheduleStateByPhone`/`deleteStateByPhone` sobre Google Calendar (`calendar.events.patch`/`delete`), con `parseFlexibleTime()` para la nueva hora. Todos los listados de citas (interactivos, no solo el resumen cron) ahora incluyen enlaces `wa.me` al paciente cuando hay teléfono registrado.
- ✅ 2026-09-17 Corregido el mensaje de confirmación de cita en texto libre: no incluía el nombre del profesional que agendó (la plantilla de Meta sí lo hacía vía `nombre_usuario`). Ahora ambos canales usan `[gentilicio, full_name]` del usuario autenticado.
- ✅ 2026-09-17 Corregido bug real reportado en producción: el bot perdía el flujo de reprogramar/eliminar cita a mitad de la conversación porque el estado se guardaba en `Map` en memoria (`financeStateByPhone`, `agendaDateStateByPhone`, etc.), y las funciones serverless de Vercel pueden ejecutarse en instancias distintas entre un mensaje y el siguiente. Nueva tabla `whatsapp_bot_state` (una fila por teléfono, `flow` + `data` JSONB) y helper `lib/whatsapp-bot-state.js` reemplazan todos los Maps por estado persistente en Neon.
- ✅ 2026-09-17 El usuario ahora puede escribir `menu` (reinicia al menú principal) o `cancelar` (aborta el flujo activo) en cualquier punto de la conversación; todos los prompts intermedios del bot recuerdan estas dos opciones para que quede claro cómo salir o empezar de nuevo.
- ✅ 2026-09-17 Ampliado el flujo de reprogramar cita: ahora pide explícitamente la duración de la nueva cita (minutos) y si prefiere mañana o tarde, calcula horarios realmente libres ese día/período con `getAvailableSlots()` (evita choques con otros eventos del calendario, incluida la propia cita a mover) y dejaba elegir entre los horarios disponibles en vez de aceptar cualquier hora a ciegas. Corregido además el enlace `wa.me` de aviso al paciente tras reprogramar: antes seguía mostrando la fecha/hora **original** de la cita en vez de la nueva.
- ✅ 2026-09-17 Los enlaces `wa.me` que envía el bot (recordatorios de cita, resumen diario, aviso tras reprogramar) ahora son links cortos propios (`https://<dominio>/r/<código>`) en vez de la URL completa de wa.me con el mensaje precargado en la query string — con 2+ citas en un listado, esas URLs (200+ caracteres cada una) hacían el mensaje ilegible en el chat. Nueva tabla `wa_short_links` (código → URL destino) y `lib/wa-short-link.js#createShortWaLink/resolveShortWaLink`; el propio `api/whatsapp-chatbot.js` resuelve la redirección (`?action=r&c=<código>`, mapeado a `/r/:code` en `vercel.json`).
- ✅ 2026-09-16 Inventario agrupado por categorías con buscador responsive y sugerencias reutilizables.
- ✅ 2026-09-16 Aplicados scopes independientes de pacientes, finanzas e inventario en listados, IDs, estadísticas, exportaciones y mutaciones.
- ✅ 2026-09-16 Migrado Google Calendar/Gmail y bot WhatsApp a identidad por usuario; Neon verificado y suite 13/13.
- ✅ 2026-09-16 Añadido CRM WhatsApp master con historial auditable en Neon.
- ✅ 2026-09-16 Endurecidos reintentos, estados y límite del webhook WhatsApp.

- ✅ 2026-09-18 Excluidos los números de `WHATSAPP_SYSTEM_STAFF_PHONES` de confirmaciones y resúmenes clínicos de WhatsApp; se cubrió la colisión entre staff del sistema y teléfono de paciente con pruebas de seguridad.
- ✅ 2026-09-18 Mejorado CRM WhatsApp master: scroll independiente, categorías de contactos y apertura en el mensaje más reciente.
- ✅ 2026-09-18 Corregido enlace CRM por teléfono canónico: usuarios clínicos y pacientes ahora muestran su clínica real aunque el contacto histórico no tenga `clinic_id`.
- ✅ 2026-09-18 Corregida UI del historial CRM para mensajes largos y añadida clínica de origen a nuevas auditorías salientes.
- ✅ 2026-09-18 Agendada búsqueda inteligente de pacientes por clínica y confirmación explícita del destinatario WhatsApp según permisos del bot.

## Pendientes verificables

- ⏳ Resolver o registrar la deuda de lint global: 471 errores y 54 warnings en la línea base.
- ⏳ Revisar vulnerabilidades restantes exclusivamente en herramientas dev/build; `npm audit --force` propone downgrades incompatibles.
- ⏳ Ampliar pruebas automatizadas a auth y backup.
- ⏳ Volver a subir fotos clínicas reales — el bucket quedó vacío tras el reset de pruebas.
