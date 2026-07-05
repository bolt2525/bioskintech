---
description: "Use when changing `api/**` or `lib/**` files, especially for backend, secrets, auth, user data, validation, server-side logic, or sensitive flows. Requires a security review and QA validation before closing the task."
name: "API Security and QA Gate"
applyTo:
  - "api/**"
  - "lib/**"
---
# API Security and QA Gate

Aplica estas reglas cada vez que se cree o modifique código en `api/**` o `lib/**`.

## Revisión de seguridad obligatoria
- Validar entradas y normalizar datos antes de procesarlos.
- No exponer contraseñas, tokens, API keys o secretos en respuestas, logs o frontend.
- Revisar autenticación, autorización y principio de mínimo privilegio cuando aplique.
- Evitar mensajes de error con detalles sensibles.
- Confirmar que secretos privados usen variables de entorno seguras, nunca `VITE_*`.

## Validación QA obligatoria
- Reproducir el bug o caso de uso antes del cambio cuando sea posible.
- Ejecutar build, script, test, smoke check o validación técnica relevante después del cambio.
- No declarar que algo quedó resuelto sin evidencia fresca.
- Revisar regresiones básicas en el flujo relacionado.

## Coordinación recomendada
- Usa **`Guardián de Seguridad`** si el cambio toca credenciales, acceso, datos sensibles o endpoints críticos.
- Usa **`QA y Testing`** para validar el fix o flujo modificado.
- Usa **`Experto Backend`** como agente principal para la implementación server-side.

## Cierre de tarea
Antes de cerrar, resume:
- riesgo revisado
- validación ejecutada
- evidencia observada
- archivos afectados
