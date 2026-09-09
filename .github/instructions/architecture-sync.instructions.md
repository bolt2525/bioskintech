---
description: "Use siempre que un cambio modifique la estructura, arquitectura o capas del sistema: nuevas tablas o migraciones, nuevas funciones API, nuevos módulos, nuevas integraciones externas, cambios en RLS/tenancy, o cambios en el flujo de datos entre capas. Aplica a TODOS los agentes (frontend, backend, seguridad, QA, DevOps, auditor), sin importar qué archivos toquen. Mantiene ARCHITECTURE.md y PROGRESS.md como fuente de verdad sincronizada con el código real."
name: "Architecture Sync — Documentación Obligatoria"
applyTo:
  "**"
---
# Architecture Sync — Documentación Obligatoria

Esta instrucción **no se debe pasar por alto** y aplica a **cualquier agente**, sin importar su especialidad (frontend, backend, seguridad, QA, DevOps, auditor) ni qué archivos haya modificado. Aplica cada vez que un cambio afecte la estructura o la arquitectura por capas del proyecto.

## Qué cuenta como cambio de arquitectura
- Nueva tabla, columna, índice, política RLS o migración en Neon.
- Nueva función serverless en `api/`, o cambio en el conteo/propósito de las existentes.
- Nueva integración externa (Cloudflare R2, Google, PayPhone, OpenAI/Gemini, etc.) o cambio en cómo se autentica/consume.
- Nuevo módulo o cambio relevante en `lib/` que altere el flujo entre capas (presentación → edge → funciones → datos → almacenamiento → integraciones).
- Cambios en aislamiento multi-tenant, roles o scopes de acceso.
- Cambios en variables de entorno críticas para la infraestructura.

## Obligación al cerrar la tarea
1. Actualizar **[ARCHITECTURE.md](../../ARCHITECTURE.md)**: la sección afectada (infraestructura, capas de datos, RLS, seguridad, riesgos) debe reflejar el estado real y verificado, no el planeado.
2. Actualizar **[PROGRESS.md](../../PROGRESS.md)**: agregar una línea fechada describiendo el cambio.
3. Si el cambio agrega o elimina una función serverless, agente, skill o convención citada en **AGENTS.md** o **.github/copilot-instructions.md**, actualizar esos archivos también.
4. No declarar la tarea cerrada sin esta actualización — es parte de la definición de "hecho", igual que el build o los tests.
5. Preferir evidencia verificada (comandos ejecutados, consultas reales) sobre descripciones planeadas o supuestas.

## Coordinación recomendada
- Usa **`Auditor de Código`** o **`DevOps y Vercel`** si la actualización requiere reconciliar documentación con infraestructura real (Vercel, Neon, Cloudflare).
- Usa **`QA y Testing`** para confirmar que la documentación no contradice el comportamiento real antes de cerrar.
