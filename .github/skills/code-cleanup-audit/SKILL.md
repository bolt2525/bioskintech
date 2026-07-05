---
name: code-cleanup-audit
description: 'Audita y limpia código con seguridad. Úsala para detectar código no usado, legacy, pruebas temporales, scripts obsoletos, duplicación y oportunidades de refactorización con verificación de impacto.'
argument-hint: 'Describe el área o tipo de limpieza técnica que quieres revisar'
user-invocable: true
---

# Code Cleanup Audit

## Cuándo usar esta skill
- Para buscar **código no usado** o **obsoleto**.
- Para revisar scripts temporales, restos de pruebas o archivos legacy.
- Para encontrar duplicación y oportunidades de refactorización segura.

## Procedimiento recomendado
1. Buscar referencias reales del símbolo, archivo o flujo sospechoso.
2. Separar qué es productivo, qué es temporal y qué es legacy.
3. Medir el impacto antes de eliminar o simplificar.
4. Hacer cambios pequeños y reversibles.
5. Verificar con referencias, build, lint o tests.

## Checklist de auditoría
- imports sin uso
- funciones/componentes no referenciados
- código comentado innecesario
- duplicación evitable
- scripts de prueba temporales
- archivos que solo agregan ruido o deuda técnica

## Resultado esperado
Un resumen con:
- hallazgo concreto
- evidencia encontrada
- acción recomendada o aplicada
- verificación posterior
