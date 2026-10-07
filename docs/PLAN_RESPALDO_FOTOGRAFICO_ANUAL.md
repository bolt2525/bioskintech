# Plan de respaldo fotográfico anual — pendiente de aprobación

**6 de octubre de 2026.** No se implementó la función, no se crearon tablas, workers, buckets, colas ni reglas de almacenamiento. Los ajustes legales autorizados son una entrega separada. Este plan no constituye un compromiso de disponibilidad, volumen o entrega.

## 1. Arquitectura observada

- React 18/Vite: módulo de Base de Datos en `src/pages/AdminBackup.tsx`; Master Admin en `src/pages/AdminMasterDashboard.tsx`.
- `api/backup.js` autentica sesiones mediante `lib/admin-auth.js`; no usa OAuth Google como identidad del respaldo. OAuth se reserva a integraciones Google. Solo administradores gestionan el respaldo.
- Neon guarda datos, historial y metadatos `clinical_photos`; los originales R2 no están en el JSON. Se exportan JSON, CSV y consentimientos HTML legibles. No existe exportación completa de historias clínicas legibles.
- `lib/backup-service.js` materializa tablas en memoria y falla sobre 50.000 filas. El helper de R2 que devuelve un Buffer materializa el objeto entero: no sirve para un ZIP masivo.
- `api/backup.js` tiene `maxDuration: 60` en `vercel.json`. Se cuentan 11 funciones locales. La inspección Vercel de solo lectura confirmó el proyecto y Node 24, no plan ni Fluid Compute.
- La documentación registra snapshots cifrados, lock 30 días y lifecycle 35 días bajo `backups/`; no se revalidaron remotamente las reglas R2 durante esta tarea.
- El generador de contratos no persiste historial: no inferir el año contractual a partir de un PDF, el año calendario o una fecha de vencimiento aislada.
- La suscripción vencida restringe acceso y hay limpieza de fotos a los 30 días. La devolución postcontrato necesita autorización limitada, no una reapertura de todos los módulos.

## 2. Memoria, CPU y duración

| Alternativa | Límites/riesgos | Criterio |
|---|---|---|
| ZIP completo en Vercel, con buffers o `/tmp` | 60 s configurados; memoria proporcional al volumen; filesystem efímero; respuesta/request con límite 4,5 MB | Descartada |
| Streaming ZIP durante petición Vercel | Reduce memoria, pero sigue sujeto a duración, desconexión y fallos sin checkpoint | No usar como proceso masivo |
| Worker HTTP tras responder o `waitUntil` | No es una cola durable; también tiene límites y depende del ciclo de ejecución | No usar como garantía de trabajo completado |
| Worker con cola y ZIP streaming por lotes | Workers: 128 MB; CPU Paid configurable hasta 5 min; consumidores Queues hasta 15 min wall time | Recomendado si cada lote cabe con margen y pruebas |
| Workflow o ejecutor efímero de contenedor | Orquesta/reintenta etapas; mayor complejidad o coste. Un workflow no elimina límites de memoria/CPU de cada paso | Alternativa si los volúmenes no caben en Worker |

Vercel con Fluid publica Hobby 2 GB/1 vCPU y 300 s máximos; Pro/Enterprise hasta 4 GB/2 vCPU y 800 s, con extensión Beta hasta 1800 s bajo requisitos. No son los límites efectivos comprobados de esta cuenta, ni reemplazan los 60 s configurados.

Fotos JPEG/PNG/WebP ya comprimidas: usar ZIP STORE y ZIP64, conservando originales; comprimir texto si aporta valor. Medir CPU de checksums y metadatos, no solo compresión. Streaming mantiene memoria acotada por buffers y concurrencia, pero el índice ZIP también crece con el número de entradas.

## 3. Estrategia recomendada

```text
Administrador de clínica -> sesión -> api/backup?action=requestAnnualPhotoBackup
  -> transacción Neon: solicitud PENDING + aviso outbox
Master Admin -> sesión -> aprobación condicionada
  -> transacción Neon: APPROVED + evento durable de procesamiento
Dispatcher -> cola/worker autenticado
  -> manifiesto por clínica -> lotes de originales -> ZIP streaming -> multipart R2 privado
  -> validación de integridad/completitud -> READY + consumo de cuota + correo outbox
Usuario -> sesión/reautenticación -> enlace vigente -> presigned GET breve -> R2
```

Neon sigue siendo la única base de datos de la aplicación. Si se usa Cloudflare Queues/Workflows, es infraestructura de ejecución y entrega, no un segundo sistema de registro de cuota/tenancy. No introducir D1, SQLite o archivos `.db`.

### Lotes y consistencia

1. Capturar un snapshot coherente de metadatos y datos estructurados. Paginar por clave estable; no mantener una transacción Neon abierta durante horas de descarga.
2. Registrar lista esperada, fecha de corte, claves inmutables, tamaños y versiones/checksums verificables. No usar un URL aportado por el usuario ni listar todo el bucket indiscriminadamente.
3. Proteger los originales seleccionados frente a la limpieza durante el trabajo; coordinar borrado y retención con la solicitud. Un manifiesto en Neon no impide por sí solo que el objeto R2 desaparezca.
4. Hacer **ZIP independientes por lote**, no un ZIP único que se pretenda concatenar/reanudar tras un fallo. Cada lote debe ser verificable y reiniciable. Si se exige un ZIP único enorme, usar ejecutor efímero idóneo o diseñar persistencia explícita del estado ZIP.
5. Empezar con concurrencia baja y ajustar mediante mediciones; presupuesto de memoria/CPU y tiempo con margen. No fijar un límite comercial por una estimación sin medir.
6. Multipart R2: persistir intentos, upload IDs y partes; abortar cargas huérfanas; respetar límites de parte y 10.000 partes. Un multipart no hace durable el estado interno del ZIP.
7. Guardar ZIP en prefijo temporal fuera de `backups/`; si el lock abarca todo el bucket, usar bucket de entrega separado **privado**. El nombre del prefijo no es una ACL.
8. Fallar explícitamente ante una foto ausente o cambiada; no enviar archivo parcial como respaldo completo. Toda excepción requiere informe visible y aceptación explícita.

### Contenido portable propuesto

```text
respaldo-<request-id>/
  LEAME.html
  manifest.json
  datos/backup.json
  datos/*.csv
  historias/<patient-id>.html
  consentimientos/<patient-id>/<consent-id>.html
  fotografias/<record-id>/<photo-id>.<extension-original>
```

Historias HTML legibles e imprimibles, sin depender de sesión ni llamadas externas. Recoger consultas, antecedentes/versiones, diagnósticos, tratamientos, inyectables, recetas, marcaciones y consentimientos/evidencias disponibles. No inventar PDF para papel no digitalizado. JSON y CSV siguen para portabilidad técnica; HTML resuelve lectura humana. Sanitizar/escapar contenido y rutas, impedir `../`, rutas absolutas e inclusión de secretos/tokens de firma. Nunca nombres de pacientes en keys, correo o logs.

## 4. Presigned URLs y entrega

R2 soporta presigned GET de 1 segundo a 7 días; **24 horas = 86.400 s es válido**. Reutilizar AWS SDK v3 y `getSignedUrl` ya instalados; credenciales solo server-side, `region: auto`, endpoint S3 R2 y `GetObjectCommand` para una clave previamente autorizada.

Se recomienda **derecho de descarga de 24 horas**, no necesariamente un presigned de 24 horas: correo con enlace opaco de la aplicación, sesión/reautenticación del administrador solicitante, token aleatorio guardado solo como hash y GET firmado de aproximadamente 5 minutos al canjearlo. Enlace revocable en Neon, ventana y clínica verificadas en cada emisión. Tokens de correo no confieren facultades de aprobar.

Una presigned URL es un bearer token: quien la recibe puede usarla durante su vigencia; no es de un solo uso ni comprueba la sesión del receptor. Una URL ya emitida sigue válida hasta expirar salvo medidas sobre el objeto/credenciales; revocar el token de aplicación solo impide nuevas emisiones. No registrar la URL completa, ni incluir analytics en la página de canje. Configurar `no-store`, política de referrer restrictiva y nombre de descarga sin datos personales. CORS no es autorización.

Separar: ventana de canje, duración del GET, fecha de borrado del archivo y periodo postcontrato. No borrar mientras una descarga permitida esté en curso; lifecycle es una red de seguridad, no eliminación exacta al segundo. Un enlace caducado puede renovarse dentro de la ventana autorizada sin compilar de nuevo ni consumir otra cuota.

## 5. Neon, permisos y estados propuestos

- Solicitudes con UUID, `clinic_id`, solicitante, aprobador, periodo de derecho, estado, clave de idempotencia, fecha de corte, intentos, lease/heartbeat, recuentos, bytes, hashes, claves R2, expiración y códigos de error seguros.
- Año **por clínica/cuenta y periodo contractual de 12 meses**, no por usuario, para evitar multiplicar cuotas con cuentas. Requiere acordar definición y persistir periodos estables; no calcular únicamente con el vencimiento actual editable.
- Estados: `PENDING -> APPROVED -> PROCESSING -> READY -> EXPIRED`; salidas `REJECTED`, `CANCELLED`, `FAILED`.
- Restricción para máximo una reserva activa o entrega consumida por clínica/periodo; transacciones y compare-and-swap impiden doble solicitud/aprobación. Rechazo o fallo no consumen cuota; reintento continúa la misma solicitud. Consumo al validar `READY`, no al enviar correo.
- Outbox transaccional para solicitud, ejecución y disponibilidad; eventos únicos, reintentos, backoff y estado visible. SMTP no es exactamente una vez: limitar duplicados, no prometer su ausencia absoluta. Un fallo SMTP no recompila ni consume otra cuota.
- `clinic_admin` solicita solo para su clínica; `master_admin` aprueba/rechaza y no acepta un tenant arbitrario como autorización. Worker/callback con autenticación de servicio, protección de replay y validación de transición/tenant.
- Usar cliente de aplicación con RLS para consultas clínicas nuevas, contexto tenant validado y filtros explícitos. Operaciones administrativas globales acotadas al master/ejecutor autorizado; no copiar el uso de pool owner del respaldo legacy como patrón general.
- Acceso postcontrato: permiso exclusivo de devolución hasta 30 días, sin restauración, edición ni IA; por canales oficiales hoy, módulo limitado si se implementa.

## 6. Modificaciones futuras, en orden

1. `lib/neon-clinical-db.js`: esquema/migración idempotente de solicitudes, periodos de derecho y outbox; UUID y tenant. Primero confirmar tablas existentes reutilizables.
2. `scripts/`: migración y actualización de `TENANT_TABLES` en `setup-bioskin-role.mjs`; políticas y privilegios RLS comprobados. No ejecutar en esta fase.
3. `api/backup.js`: elegibilidad, solicitar, listar estado, cancelar, aprobar/rechazar master y canjear descarga. No nueva función Vercel.
4. Nuevo servicio acotado en `lib/modules/` o extensión de `lib/backup-service.js`: estados/cuota, manifest y recopilación portable. Evitar introducir un framework de trabajos.
5. `lib/r2-service.js`: lectura streaming, multipart, verificación, abort y limpieza; no convertir ZIP completo a Buffer.
6. Worker/cola Cloudflare con configuración aislada, o ejecutor alternativo aprobado: procesar un lote por mensaje, persistir progreso, autenticarse y reportar resultado.
7. Extraer/reutilizar transporte SMTP de `api/sendEmail.js` en helper server-side si no existe uno equivalente. Correo master con enlace al panel; correo cliente HTML y texto con expiración, advertencia y CTA; sin pacientes ni adjuntos masivos.
8. `src/pages/AdminBackup.tsx`: botón “Solicitar Respaldo Anual”, elegibilidad de servidor, explicación de alcance, progreso y errores; desactivar duplicados como UX, nunca como único control de cuota.
9. `src/pages/AdminMasterDashboard.tsx`: tab de solicitudes y componente acotado con clínica, volumen estimado, cuota, estado, aprobar/rechazar y auditoría. Carga bajo demanda.
10. `src/types/index.ts`: tipos compartidos del flujo; reutilizar feature `backup` si permite el alcance, sin duplicar módulo.
11. `tests/backup.test.mjs` y pruebas de worker: concurrencia, aislamiento, fallos de objetos/SMTP, expiración, ZIP íntegro, recuperación de lotes, borrado y salida postcontrato.
12. Actualizar Condiciones, Política, generador y arquitectura **solo después** de probar la entrega; no anunciar protección fotográfica automática si únicamente existe exportación anual bajo solicitud.

El generador no guarda contratos: hay que definir una fuente de vigencia contractual verificable para la cuota. No crear todo un sistema de firma/contratos si una tabla mínima de derechos respaldada por los registros actuales resuelve ese requisito.

## 7. Cuestiones a aprobar y pruebas de aceptación

Decidir: año contractual, una entrega por clínica, política de exportación final, volúmenes comerciales, almacenamiento temporal, ejecución Cloudflare Paid vs alternativa y precio de extensiones. Recomendación: **una entrega gratuita por año contractual, más salida final razonable**, sin equiparar esto a un DR fotográfico diario.

Antes de producción: medir conjunto representativo con datos ficticios, consumo pico, CPU y duración por lote; verificar margen frente a límites; comprobar archivo con herramienta ZIP independiente y hashes; ejecutar restauración/lectura de datos estructurados y HTML; demostrar dos solicitudes y aprobaciones concurrentes no duplican cuota; comprobar que clínica A nunca obtiene objetos de B; provocar objeto faltante y error SMTP sin éxito falso; ensayar expiración/revocación y purga postcontrato.

Para prevenir pérdida fotográfica real se necesita una estrategia DR independiente (copias periódicas, credenciales/retención adecuadas y pruebas de restauración), que es un alcance distinto del archivo anual entregado al cliente.

## Fuentes técnicas oficiales

- [Vercel Functions: límites](https://vercel.com/docs/functions/limitations).
- [Workers: límites](https://developers.cloudflare.com/workers/platform/limits/).
- [Queues: límites](https://developers.cloudflare.com/queues/platform/limits/).
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- [R2: límites](https://developers.cloudflare.com/r2/platform/limits/).
