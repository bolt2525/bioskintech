# Revisión de seguridad: registro y purga de clínicas

Fecha: 2026-10-23  
Alcance: autenticación, baja/purga de clínicas, registro público y atribución de teléfonos WhatsApp.

La revisión estática y las pruebas locales encontraron cinco hallazgos. Los tres primeros se corrigieron en los cambios locales pendientes de publicación. Los dos últimos siguen abiertos; no se implementaron porque se eligió documentar y comprometer el resumen, no aplicar esos endurecimientos adicionales.

## Hallazgos

### 1. Enlaces de configuración de contraseña después de la baja

- **Severidad:** Media
- **Confianza:** 9/10
- **Evidencia:** `api/admin-auth.js` (`generateSetupTokenFn`, `claimSetupTokenFn`); `lib/clinic-purge.js` (`revokeClinicAccess`).
- **Riesgo:** Un enlace válido podía cambiar la contraseña después de desactivar la clínica. Si la clínica se reactivaba, esa contraseña podía quedar vigente; una carrera también podía escribir durante la purga.
- **Estado:** Corregido en el cambio local. Generación y consumo del token se serializan con el lifecycle, vuelven a validar el estado del usuario y la clínica, y la baja/purga revoca tokens. La reactivación no restaura enlaces.
- **Verificación:** pruebas de cuenta activa/inactiva, tombstones, carreras y rollback en `tests/admin-auth-atomicity.test.mjs` y `tests/clinic-purge.test.mjs`.

### 2. Alta pública no atómica ante colisiones concurrentes

- **Severidad:** Media
- **Confianza:** 9/10
- **Evidencia:** `api/admin-auth.js` (`registerClinic`, `registerClinicTransaction`).
- **Riesgo:** Una carrera de unicidad podía consumir un código de registro y crear una clínica sin administrador si fallaba una inserción posterior.
- **Estado:** Corregido en el cambio local. La disponibilidad, el reclamo del código/pago y la creación de clínica, usuario y configuración ocurren en una transacción; los correos se envían después del commit.
- **Verificación:** pruebas de rollback por fallos en cada etapa y de registros concurrentes en `tests/admin-auth-atomicity.test.mjs`.

### 3. Teléfono histórico aceptado para el bot aunque sus mensajes se descartaran

- **Severidad:** Media
- **Confianza:** 8/10
- **Evidencia:** `api/admin-auth.js` (validación de teléfonos en alta, edición, perfil y habilitación del bot); `api/whatsapp-chatbot.js` (resolución de atribución entrante).
- **Riesgo:** Un teléfono retenido por una cuenta inactiva o por conversaciones históricas podía aceptarse como teléfono del bot de otra clínica, aunque el receptor luego descartara mensajes por la atribución anterior.
- **Estado:** Corregido en el cambio local. Las escrituras rechazan teléfonos retenidos o con conversaciones atribuibles a otra clínica; no se reasignan contactos ni historial.
- **Verificación:** pruebas para teléfonos primarios/alternativos, cuentas activas/inactivas, atribución global y rutas de escritura en `tests/admin-auth-atomicity.test.mjs`.

### 4. Reserva de teléfono vulnerable a concurrencia entre clínicas

- **Severidad:** Media
- **Confianza:** 9/10
- **Evidencia:** `api/admin-auth.js` (`isPhoneAvailable` y sus consumidores); índice `uq_clinic_users_whatsapp_staff_phone`.
- **Riesgo:** Dos altas o cambios de clínicas distintas pueden superar simultáneamente la consulta de disponibilidad y guardar el mismo número. El índice actual solo cubre usuarios activos con bot habilitado y no impone la reserva de todos los números históricos.
- **Estado:** Abierto. La comprobación actual falla de forma segura ante conflictos observados, pero no serializa globalmente la reserva y el índice no cubre toda la política.
- **Impacto:** Puede crear atribución ambigua y hacer que los mensajes se descarten o requieran revisión. No se observó una ruta de acceso automático a datos de otra clínica.

### 5. Correo de configuración enviado antes del commit externo

- **Severidad:** Baja
- **Confianza:** 9/10
- **Evidencia:** `api/admin-auth.js` (`withAuthTransaction`, `generateSetupTokenFn`, `createUser`).
- **Riesgo:** Cuando la generación del token reutiliza la transacción externa de `createUser`, el mensaje puede enviarse antes de que esa transacción confirme. Un fallo del commit dejaría un enlace que no existe en la base de datos.
- **Estado:** Abierto. La operación de credenciales puede revertirse correctamente, pero el envío de correo no está diferido hasta el commit externo en todos los callers.
- **Impacto:** Enlace de configuración inválido; no se encontró evidencia de que permita acceso sin una credencial válida.

## Validación y límites

- Pruebas focales locales: **66/66 aprobadas** con `node --experimental-test-module-mocks --test tests/admin-auth-atomicity.test.mjs tests/clinic-purge.test.mjs tests/purge-whatsapp.test.mjs tests/admin-clinic-purge-ui.test.mjs`.
- ESLint focal de los archivos backend y pruebas: aprobado.
- `npm run build`: aprobado; Vite emitió su advertencia habitual de chunks grandes.
- `git diff --check`: aprobado.
- La revisión y las pruebas de código no accedieron a Neon, Cloudflare R2 ni producción. No se ejecutó ninguna purga.
- Este informe distingue los tres arreglos locales de los dos hallazgos abiertos; no certifica despliegue ni elimina las garantías de retención/atribución.
