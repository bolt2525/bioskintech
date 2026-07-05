---
name: vercel-operations
description: 'Diagnostica despliegues y producción en Vercel. Úsala para build errors, logs, variables de entorno, serverless functions, rutas SPA, límites de funciones y troubleshooting operativo con evidencia.'
argument-hint: 'Describe el error de deploy, entorno o producción a revisar'
user-invocable: true
---

# Vercel Operations

## Cuándo usar esta skill
- Fallos de **deploy** o **build** en Vercel.
- Problemas de **runtime** en funciones serverless.
- Revisión de `vercel.json`, rewrites, rutas SPA o assets.
- Validación de **variables de entorno**, secretos y configuración operativa.

## Procedimiento recomendado
1. Confirmar el síntoma exacto con logs o salida del build.
2. Revisar configuración crítica: `vercel.json`, `package.json`, scripts y `api/`.
3. Verificar límites del proyecto, especialmente número de funciones serverless.
4. Confirmar que los secretos viven en variables de entorno seguras, nunca en frontend.
5. Ejecutar validación local relevante (`build`, pruebas o script de diagnóstico).
6. Aplicar el ajuste mínimo viable y volver a verificar con evidencia fresca.

## Checklist operativo
- `vercel.json` coherente con SPA y rutas actuales
- Scripts de `build` y dependencias válidas
- Variables de entorno requeridas configuradas
- Funciones serverless consolidadas y dentro del límite
- Logs revisados antes de proponer solución
- Estado final validado con salida real

## Resultado esperado
Entregar siempre:
- causa raíz probable o confirmada
- cambio aplicado o recomendado
- evidencia de validación
- riesgos operativos pendientes
