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

### Fichas clínicas

`lib/neon-clinical-db.js` crea tablas para:

- pacientes y expedientes;
- antecedentes, consultas e historial;
- exámenes físicos y mapas JSONB;
- diagnósticos, tratamientos y recetas;
- inyectables y `mapping_data` JSONB;
- consentimientos, tokens y firmas;
- inventario, lotes y movimientos;
- finanzas internas y partidas;
- auditoría, asignaciones y grupos;
- catálogos globales;
- `clinical_photos` con `r2_key` y metadatos.

Hay migraciones idempotentes embebidas en la inicialización. El código conserva migraciones históricas que intentan agregar `clinic_id` como `INTEGER` en algunas tablas, mientras el esquema actual declara `UUID`; esta compatibilidad debe auditarse sobre la base real antes de eliminarla.

### Fotos clínicas

El flujo actual tiene dos caminos:

1. `uploadPhotoProxy`: recibe base64, valida MIME permitido, limita el buffer a 4 MB, sube a R2 y registra metadatos.
2. `getPhotoUploadUrl` + `confirmPhotoUpload`: genera una URL PUT firmada, el cliente sube a R2 y luego confirma la metadata en Neon.

Las lecturas generan URLs firmadas temporales. El código no demuestra object versioning, cifrado de aplicación ni un límite máximo efectivo para la subida directa PUT; esos puntos requieren configuración o prueba real de R2.

## 5. RLS y aislamiento

`scripts/setup-bioskin-role.mjs` configura el rol `bioskin_app`, habilita `FORCE ROW LEVEL SECURITY` y crea políticas por `clinic_id` para tablas clínicas. `withTenantContext()` usa una transacción y `set_config(..., true)`.

La comprobación conectada del 2026-09-07 confirmó RLS habilitado y forzado para `patients`, `clinical_photos`, `financial_records` y `external_finance_records`, con políticas separadas de `SELECT`, `INSERT`, `UPDATE` y `DELETE` para `bioskin_app`. Una prueba de solo lectura con dos clínicas confirmó que cada tenant solo ve sus propias filas y que sin contexto no se devuelven filas clínicas.

Durante esta auditoría se corrigió un riesgo importante: `getAppPool()` ya no degrada silenciosamente a `neondb_owner` cuando falta `NEON_APP_URL`; devuelve `null` y obliga al endpoint a fallar cerrado. La prueba conectada con dos tenants confirmó el aislamiento real.

Las operaciones de fotos también validan que el expediente pertenezca al tenant efectivo y que las lecturas se filtren por `record_id` y `clinic_id`. Las claves R2 confirmadas deben pertenecer al prefijo de la clínica y expediente, y el proxy rechaza imágenes vacías o mayores de 4 MB.

## 6. Seguridad confirmada en código

- Contraseñas con PBKDF2 y salt usando Node crypto.
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
4. La validación de magic bytes y dimensiones reales de imágenes todavía no está implementada.
5. No debe prometerse object versioning, cifrado en reposo, backups automáticos, alta disponibilidad o cumplimiento legal específico sin evidencia de proveedor/configuración.
6. La firma digital está implementada como captura y persistencia de firma/declaraciones; su validez jurídica depende del marco legal y del procedimiento de la clínica.

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
