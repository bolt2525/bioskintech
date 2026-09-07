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

## Pendientes verificables

- ⏳ Resolver o registrar la deuda de lint global: 471 errores y 54 warnings en la línea base.
- ⏳ Ampliar pruebas automatizadas a auth y backup.
