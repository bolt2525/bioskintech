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
- ✅ 2026-09-09 Documentadas CLIs Vercel, Neon y Wrangler instaladas, autenticadas y configuradas.
- ✅ 2026-09-09 Corregido layout responsive y scrollbar visible del listado de medicamentos.
- ✅ 2026-09-09 Corregido envío de alertas de registro y reconexión OAuth inválida.
- ✅ 2026-09-09 Separadas alertas administrativas y bloqueado agendamiento sin Gmail OAuth de clínica.
- ✅ 2026-09-09 Compactado layout visual del tab Recetas.

## Pendientes verificables

- ⏳ Resolver o registrar la deuda de lint global: 471 errores y 54 warnings en la línea base.
- ⏳ Revisar vulnerabilidades restantes exclusivamente en herramientas dev/build; `npm audit --force` propone downgrades incompatibles.
- ⏳ Ampliar pruebas automatizadas a auth y backup.
- ⏳ Volver a subir fotos clínicas reales — el bucket quedó vacío tras el reset de pruebas.
