# Respaldo fotográfico anual — implementación preparada

**6 de octubre de 2026.** Arquitectura aprobada e implementación en repositorio. **Procesamiento desactivado por defecto:** no se contrata Workers Paid ni se crea infraestructura remota automáticamente. El flujo es solicitud de clínica → autorización Master Admin → compilación asíncrona → descarga por la clínica; no requiere que el cliente compile desde su equipo. Migración, cola, Worker, secretos y reglas de limpieza deben verificarse antes de habilitarlo.

**Actualización contractual 7 de octubre:** se asume el compromiso de una entrega gratuita anual bajo solicitud, durante la vigencia o habitualmente al finalizar dentro de 30 días. Si el canal automático no está disponible, el Proveedor debe coordinar entrega asistida privada; no se traslada al cliente la contratación del procesador. Para contratos bajo las Condiciones 2026-10-07-r2, las entregas adicionales requieren cotización aceptada y no tienen tarifa fija publicada. Las tarifas fijas de phase 2 se aplican únicamente a `paid-grace15-recovery30-v1`; no se cobran correcciones por fallos imputables al Proveedor ni se restringen derechos legales.

**Política prospectiva phase 2:** `paid-grace15-recovery30-v1` es un anexo comercial separado para contratos nuevos o adendas firmadas. No cambia automáticamente la versión global 2026-10-07-r2 ni los contratos existentes. Define 15 días de acceso normal, 30 días de recuperación restringida y purga por lotes al día 45; tarifa adicional final con IVA de USD 10/5 GB, USD 20/20 GB, USD 35/50 GB y cotización manual por encima. La coordinación asistida por el Proveedor es la ruta contractual; el Worker permanece apagado y no debe afirmarse que existe compilación fotográfica automática diaria. Esta documentación no autoriza activar infraestructura ni efectuar migraciones.

## 1. Arquitectura observada

- React 18/Vite: módulo de Base de Datos en `src/pages/AdminBackup.tsx`; Master Admin en `src/pages/AdminMasterDashboard.tsx`.
- La exportación JSON del módulo de Base de Datos tiene hoy límites de 50 MiB comprimidos y 200 MiB expandidos; la exportación JSON general por lotes queda para una fase 3 futura y no está implementada. La importación CSV se limita a pacientes, 5 MiB y 5.000 registros; no restaura finanzas. Estos límites del módulo no describen los ZIP separados del flujo anual fotográfico.
- `api/backup.js` autentica sesiones mediante `lib/admin-auth.js`; no usa OAuth Google como identidad del respaldo. OAuth se reserva a integraciones Google. Solo administradores gestionan el respaldo.
- Neon guarda datos, historial y metadatos `clinical_photos`; los originales R2 no están en el JSON. El nuevo flujo añade originales ZIP, JSON/CSV y copias clínicas HTML a partir del mismo snapshot.
- `lib/backup-service.js` materializa tablas en memoria y falla sobre 50.000 filas. El helper de R2 que devuelve un Buffer materializa el objeto entero: no sirve para un ZIP masivo.
- `api/backup.js` tiene `maxDuration: 60` en `vercel.json`. Se cuentan 11 funciones locales. La inspección Vercel de solo lectura confirmó el proyecto y Node 24, no plan ni Fluid Compute.
- La inspección R2 de solo lectura confirmó lock 30 días solo bajo `backups/` y lifecycle 35 días para ese prefijo; no se modificaron reglas remotas.
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
Administrador de clínica -> sesión -> api/backup?action=requestPhotoBackup
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

### Contenido portable

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

JSON, CSV e historias que superan el tamaño por documento se fragmentan por filas; `LEAME.html` enumera todos los documentos. Los JSON numerados se restauran en orden ascendente: primero pacientes y luego sus relaciones. Un registro individual excesivo falla explícitamente y requiere exportación asistida; no se recorta su contenido.

## 4. Presigned URLs y entrega

R2 soporta presigned GET de 1 segundo a 7 días; **24 horas = 86.400 s es válido**. Reutilizar AWS SDK v3 y `getSignedUrl` ya instalados; credenciales solo server-side, `region: auto`, endpoint S3 R2 y `GetObjectCommand` para una clave previamente autorizada.

Se recomienda **derecho de descarga de 24 horas**, no necesariamente un presigned de 24 horas: correo con enlace opaco de la aplicación, sesión/reautenticación del administrador solicitante, token aleatorio guardado solo como hash y GET firmado de aproximadamente 5 minutos al canjearlo. Enlace revocable en Neon, ventana y clínica verificadas en cada emisión. Tokens de correo no confieren facultades de aprobar.

La implementación usa el panel con sesión ya existente y el identificador UUID de solicitud: el UUID no autoriza descargas por sí mismo. No es necesario introducir otro token en el correo. `photoBackupDownload` verifica tenant, rol, estado completo y ventana restante antes de emitir el GET firmado.

Una presigned URL es un bearer token: quien la recibe puede usarla durante su vigencia; no es de un solo uso ni comprueba la sesión del receptor. Una URL ya emitida sigue válida hasta expirar salvo medidas sobre el objeto/credenciales; revocar el token de aplicación solo impide nuevas emisiones. No registrar la URL completa, ni incluir analytics en la página de canje. Configurar `no-store`, política de referrer restrictiva y nombre de descarga sin datos personales. CORS no es autorización.

## Costos y decisión de operación

Fuente oficial: [R2 Pricing](https://developers.cloudflare.com/r2/pricing/) y [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/), consultadas el 6 de octubre de 2026.

- R2 no cobra transferencia de salida a Internet, incluida la descarga de fotografías o ZIP. No equivale a una exportación sin costos.
- Standard: USD 0,015/GB-mes de almacenamiento; operaciones A USD 4,50/millón y B USD 0,36/millón. Sin cargo de recuperación Standard. Franquicia publicada: 10 GB-mes, 1 millón A y 10 millones B; comprobar el consumo total de la cuenta.
- Infrequent Access añade USD 0,01/GB de recuperación; no elegir esa clase para originales que se leerán ni ZIP temporales sin evaluar el costo.
- ZIP temporales duplican almacenamiento mientras existen. Multipart, lectura, colas, CPU y reintentos también cuentan; 24 horas de acceso no eliminan objetos automáticamente.
- Workers Paid tiene un mínimo de **USD 5 por mes de cuenta mientras esté activo**, incluso sin respaldos. No es pago por ZIP ni por aprobación. Los límites gratuitos no permiten prometer procesamiento masivo; no se confirmó que el plan efectivo soporte los lotes.

Workers es un entorno de ejecución, no una ampliación del almacenamiento R2. La suscripción puede aprovecharse para tareas de fondo, limpieza, notificaciones, procesamiento de archivos y webhooks, con cuotas y cargos de los servicios asociados; no implica servicios ilimitados ni necesidad de migrar Neon o las APIs existentes. Una opción sin mensualidad de procesamiento es un ejecutor Node supervisado en un equipo administrado por BIOSKINTECH, leyendo R2 en streaming y subiendo ZIP privados por partes. Ese ejecutor no está implementado; requiere protección del equipo, credenciales server-side, mínimo almacenamiento temporal, reanudación, comprobación de integridad y limpieza. Siguen existiendo costos de almacenamiento/operaciones R2 y operación humana. No reutilizar el navegador del cliente para obligarlo a compilar sus datos.
- El usuario no autorizó un cargo fijo: dejar preparado el Worker, sin cambiar planes ni activar procesamiento. En el futuro verificar facturación y capacidad y obtener autorización antes de habilitar. No prometer prorrateo o un único cargo por activarlo temporalmente sin comprobar condiciones de la cuenta.

## Superficies implementadas y habilitación futura

- UI: `AnnualPhotoBackupPanel` en Base de Datos y tab Respaldos anuales en Master Admin. Períodos explícitos de doce meses, solicitudes, aprobación/rechazo, errores visibles y descarga por partes.
- Backend consolidado: `api/backup.js` y `lib/annual-photo-backup.js`. No aumenta las 11 funciones Vercel.
- Neon: migración explícita `scripts/migrate-annual-photo-backup.mjs`, con cuotas, requests, partes, notificaciones y RLS. No se ejecuta desde un request.
- Documentación portable: `lib/portable-clinical-export.js`, snapshot coherente, sin tokens de firma ni activos externos, HTML escapado y CSV protegido contra fórmulas. Límite explícito de 4 MiB por documento y 128 MiB total; 50.000 filas por tabla del recolector existente. Un exceso falla, no trunca ni presenta una copia parcial como completa. Es un límite técnico de esta implementación, no una promesa comercial de volumen ilimitado. Las firmas se compactan solo en HTML; los originales permanecen en JSON. Una historia sintética de 20 consultas pesa aproximadamente 30 KiB sin fotografías.
- Worker: `workers/annual-photo-backup/`, ZIP STORE/ZIP64 streaming por lotes y multipart. Los IDs en cola no contienen fichas ni nombres de pacientes.
- Estado remoto verificado de solo lectura: sin colas registradas; `bioskin-fotos` tiene lock solo en `backups/`, no en todo el bucket. Las reglas actuales eliminan `backup-tmp/` al día y `backups/` a los 35 días, pero no cubren `annual-photo-backups/`. Agregar su limpieza temporal sin modificar las reglas anteriores y comprobar bucket privado antes de habilitar.
- `ANNUAL_PHOTO_BACKUP_ENABLED=false` mantiene el sistema cerrado: no prometer correos ni preparar entregas hasta que exista configuración funcional. No se consumen cuotas por una entrega fallida.

Validar antes de habilitar: migration/RLS y unicidad concurrente; SMTP/outbox; Worker y callbacks autenticados; ZIP real, ausencia/cambio de objetos, recuperación de leases y repetición idempotente; todos los archivos esperados; descarga con sesión correcta y expiración. Hacer una entrega end-to-end con datos ficticios antes de comunicar disponibilidad.

Mantenimiento: el Worker incluye cron horario que llama a `photoBackupWorkerMaintenance` con secreto y timeout de 55 s. Resultados parciales/fallos se registran y fallan explícitamente, sin bucles de reintento dentro del cron. Antes de activarlo verificar ejecuciones y alertas. La limpieza de huérfanos requiere lifecycle independiente bajo `annual-photo-backups/` (retención temporal aprobada, por ejemplo siete días); no aplicar esa regla a originales ni a `backups/`. La expiración del enlace no equivale a borrado.

Las fuentes sin entrega completada caducan a los seis días para dejar margen frente al lifecycle de siete días. Una solicitud caducada no reutiliza sus claves: el cliente debe coordinar con soporte una nueva entrega autorizada. El mantenimiento reserva las filas, invalida leases, purga snapshots y borra fuentes/partes; un error conserva la reserva y no declara limpieza exitosa.

Validación local: `npm run test:backup` (Node 24, mocks de módulos experimentales) y `npx tsc --noEmit --project workers/annual-photo-backup/tsconfig.json`. Los tipos runtime provienen de `@cloudflare/workers-types`; `worker-configuration.d.ts` conserva bindings generados con Wrangler. En este equipo Windows, generar runtime mediante workerd produjo un access violation; el bundle `wrangler deploy --dry-run` y la comprobación TypeScript pueden ejecutarse sin desplegar.

Separar: ventana de canje, duración del GET, fecha de borrado del archivo y periodo postcontrato. No borrar mientras una descarga permitida esté en curso; lifecycle es una red de seguridad, no eliminación exacta al segundo. Un enlace caducado puede renovarse dentro de la ventana autorizada sin compilar de nuevo ni consumir otra cuota.

## 5. Neon, permisos y estados

- Solicitudes con UUID, `clinic_id`, solicitante, aprobador, periodo de derecho, estado, clave de idempotencia, fecha de corte, intentos, lease/heartbeat, recuentos, bytes, hashes, claves R2, expiración y códigos de error seguros.
- Año **por clínica/cuenta y periodo contractual de 12 meses**, no por usuario, para evitar multiplicar cuotas con cuentas. Requiere acordar definición y persistir periodos estables; no calcular únicamente con el vencimiento actual editable.
- Estados: `PENDING -> APPROVED -> PROCESSING -> READY -> EXPIRED`; salidas `REJECTED`, `CANCELLED`, `FAILED`.
- Restricción para máximo una reserva activa o entrega consumida por clínica/periodo; transacciones y compare-and-swap impiden doble solicitud/aprobación. Rechazo o fallo no consumen cuota; reintento continúa la misma solicitud. Consumo al validar `READY`, no al enviar correo.
- Outbox transaccional para solicitud, ejecución y disponibilidad; eventos únicos, reintentos, backoff y estado visible. SMTP no es exactamente una vez: limitar duplicados, no prometer su ausencia absoluta. Un fallo SMTP no recompila ni consume otra cuota.
- `clinic_admin` solicita solo para su clínica; `master_admin` aprueba/rechaza y no acepta un tenant arbitrario como autorización. Worker/callback con autenticación de servicio, protección de replay y validación de transición/tenant.
- Usar cliente de aplicación con RLS para consultas clínicas nuevas, contexto tenant validado y filtros explícitos. Operaciones administrativas globales acotadas al master/ejecutor autorizado; no copiar el uso de pool owner del respaldo legacy como patrón general.
- Devolución postcontrato: procedimiento exclusivamente manual por canales oficiales dentro de 30 días; verificar identidad/autorización, registrar solicitud, cuota y entrega privada. No reactivar cuenta, restauración, edición ni IA. El botón anual exige período vigente y no implementa esa gestión manual.

## 6. Archivos preparados y pendientes de habilitación

1. Backend: `lib/annual-photo-backup.js`, acciones consolidadas en `api/backup.js`; períodos, snapshot, bundles documentales, leases, partes y SMTP/outbox.
2. Migración explícita: `scripts/migrate-annual-photo-backup.mjs` y privilegios en `scripts/setup-bioskin-role.mjs`. Pendiente de aplicar y comprobar en Neon antes de activar.
3. Documentos: `lib/portable-clinical-export.js`; bundles temporales privados bajo `annual-photo-backups/<clinic>/<request>/source/`. Worker valida hash y extrae cada documento al ZIP; el cliente no recibe el JSON del bundle.
4. Ejecutor: `workers/annual-photo-backup/`; cola/DLQ, callbacks, ZIP streaming, multipart y abort. Configuración local preparada, sin recursos remotos creados.
5. Interfaz: `AnnualPhotoBackupPanel` en Base de Datos y tab Master, tipos en `src/types/index.ts`; autorización y límites dependen del servidor.
6. Habilitación separada: plan/recursos Cloudflare aprobados, secretos, SMTP, limpieza, migración y entrega integrada ficticia. No habilitar el flag antes de estos controles.
7. Pruebas locales cubren ZIP real, hashes, callback/reintento, archivos ausentes, bundles y documentos escapados. No equivalen a una prueba productiva de concurrencia RLS, SMTP y expiración.

El generador no guarda contratos: hay que definir una fuente de vigencia contractual verificable para la cuota. No crear todo un sistema de firma/contratos si una tabla mínima de derechos respaldada por los registros actuales resuelve ese requisito.

## 7. Decisiones y pruebas de aceptación

Aprobado: período registrado de 12 meses, una entrega por clínica, solicitud exclusiva de `clinic_admin`, autorización Master, partes ZIP independientes y ventana de descarga de 24 horas. Se mantiene retención postcontrato de 30 días. No contratar infraestructura ni activar planes automáticamente; el Worker queda preparado. Extensiones y una segunda entrega requieren acuerdo, sin obstaculizar derechos legales de devolución.

Antes de producción: medir conjunto representativo con datos ficticios, consumo pico, CPU y duración por lote; verificar margen frente a límites; comprobar archivo con herramienta ZIP independiente y hashes; ejecutar restauración/lectura de datos estructurados y HTML; demostrar dos solicitudes y aprobaciones concurrentes no duplican cuota; comprobar que clínica A nunca obtiene objetos de B; provocar objeto faltante y error SMTP sin éxito falso; ensayar expiración/revocación y purga postcontrato.

Para prevenir pérdida fotográfica real se necesita una estrategia DR independiente (copias periódicas, credenciales/retención adecuadas y pruebas de restauración), que es un alcance distinto del archivo anual entregado al cliente.

## Fuentes técnicas oficiales

- [Vercel Functions: límites](https://vercel.com/docs/functions/limitations).
- [Workers: límites](https://developers.cloudflare.com/workers/platform/limits/).
- [Queues: límites](https://developers.cloudflare.com/queues/platform/limits/).
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- [R2: límites](https://developers.cloudflare.com/r2/platform/limits/).
