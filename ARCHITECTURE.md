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
- `system-status.js`: diagnósticos de servicios.

El repositorio contiene 9 archivos de función bajo `/api/`. El límite efectivo de Vercel debe confirmarse contra el plan activo antes de crear nuevas rutas.

## 4. Capas de datos

### Auth y tenancy

La inicialización de `api/admin-auth.js` crea las tablas de clínicas, usuarios, sesiones, features, configuración, OAuth, OTP, dispositivos confiables, invitaciones, suscripciones y notificaciones. Los roles principales son `master_admin`, `clinic_admin` y `clinic_user`, con scopes de acceso que pueden limitarse a datos propios.

El restablecimiento administrativo genera una clave temporal criptográfica en el servidor, reemplaza inmediatamente el hash anterior, elimina OTP de login pendientes y revoca todas las sesiones del usuario. `clinic_users.must_change_password` mantiene un aviso en el panel principal hasta que el usuario completa su cambio personal con verificación OTP. La clave temporal solo se devuelve en la respuesta no-cache del reset y puede enviarse al correo registrado mediante `sendResetCredentials`, que vuelve a verificar que la clave siga vigente antes de enviarla.

Las clínicas nuevas reciben deshabilitadas por defecto `treatment_notes_view`, `ai_consultation` y `clinical_3d`; el Master Admin debe activarlas explícitamente desde la configuración de módulos.

Estas tres features son opt-in: una fila ausente en `clinic_features` también equivale a deshabilitada y solo `enabled=true` concede acceso. Los contadores, tarjetas y toggles del Master Admin aplican la misma regla efectiva que `getFeatures()`; las features normales permanecen activas salvo un `enabled=false` explícito.

Los avisos administrativos al desarrollador cubren registro público, invitaciones, creación/edición de clínicas, conexión/desconexión Gmail y fallos completos de agendamiento; las citas exitosas no generan avisos al desarrollador. Calendar y correo de agendamiento requieren OAuth válido de la clínica, sin fallback a service account o SMTP global. Las conexiones OAuth inválidas se limpian al detectar `401` y se marcan para reconexión.

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
- `npm run test:security` — 5 pruebas pasan.
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
