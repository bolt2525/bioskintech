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
- ✅ 2026-09-16 Inventario agrupado por categorías con buscador responsive y sugerencias reutilizables.
- ✅ 2026-09-16 Aplicados scopes independientes de pacientes, finanzas e inventario en listados, IDs, estadísticas, exportaciones y mutaciones.
- ✅ 2026-09-16 Migrado Google Calendar/Gmail y bot WhatsApp a identidad por usuario; Neon verificado y suite 13/13.
- ✅ 2026-09-16 Añadido CRM WhatsApp master con historial auditable en Neon.
- ✅ 2026-09-16 Endurecidos reintentos, estados y límite del webhook WhatsApp.

## Pendientes verificables

- ⏳ Resolver o registrar la deuda de lint global: 471 errores y 54 warnings en la línea base.
- ⏳ Revisar vulnerabilidades restantes exclusivamente en herramientas dev/build; `npm audit --force` propone downgrades incompatibles.
- ⏳ Ampliar pruebas automatizadas a auth y backup.
- ⏳ Volver a subir fotos clínicas reales — el bucket quedó vacío tras el reset de pruebas.
