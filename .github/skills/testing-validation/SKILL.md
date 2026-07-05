---
name: testing-validation
description: 'Valida cambios con QA real. Úsala para reproducir bugs, ejecutar build/lint/tests, smoke tests, regresión y comprobar correcciones con evidencia verificable.'
argument-hint: 'Describe el bug, flujo o validación que quieres comprobar'
user-invocable: true
---

# Testing Validation

## Cuándo usar esta skill
- Para **reproducir bugs** antes de corregirlos.
- Para validar cambios con **build, lint, tests** y smoke tests.
- Para comprobar que un fix no rompe flujos cercanos.

## Procedimiento recomendado
1. Definir el caso de prueba y el resultado esperado.
2. Reproducir el problema o confirmar el estado inicial.
3. Ejecutar la validación más directa y confiable.
4. Registrar evidencia concreta: salida de comandos, conteos de tests o errores.
5. Tras el cambio, repetir la misma validación y comparar resultados.
6. Reportar éxito o fallo con datos reales, no con suposiciones.

## Checklist de QA
- pasos de reproducción claros
- build/lint/tests relevantes ejecutados
- revisión de regresión básica
- validación de estados de error, carga y éxito
- evidencia final antes de cerrar la tarea

## Principios obligatorios
- No declarar "funciona" sin prueba fresca.
- Probar comportamiento real, no solo mocks.
- Si algo falla, reportar el fallo real y su impacto.
