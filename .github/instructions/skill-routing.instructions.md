---
name: "Skill Routing - Uso Obligatorio"
description: "Carga obligatoriamente las skills instaladas cuando una tarea coincida con sus disparadores: UI, React, Vercel, navegación web, QA visual o refactorización de componentes. Aplica a todos los agentes."
applyTo: "**"
---
# Skill Routing - Uso Obligatorio

Antes de buscar, editar o ejecutar comandos, identifica si la tarea coincide con una skill instalada y carga su `SKILL.md`. No basta con conocer su nombre ni con haberla usado en otra conversación.

## Matriz obligatoria

- **Crear o modificar UI/componentes React:** `building-components` + `vercel-react-best-practices`.
- **Auditar diseño, UX, responsive o accesibilidad:** `web-design-guidelines`.
- **Refactorizar componentes grandes, APIs de props o composición:** `vercel-composition-patterns` + `vercel-react-best-practices`.
- **Operar, desplegar o diagnosticar Vercel:** `vercel-cli` + `vercel-operations`; cargar además `cli-tools.instructions.md`.
- **Navegar, interactuar, capturar pantallas o probar la aplicación en navegador:** `agent-browser`; cargar primero `agent-browser skills get core`.
- **Validar cambios o regresiones:** `testing-validation`; combinar con `agent-browser` cuando la prueba requiera comportamiento real del navegador.
- **Auditar o limpiar código:** `code-cleanup-audit`; añadir las skills de React/UI si el alcance toca frontend.

## Reglas

- Combina skills cuando la tarea cruce categorías; una skill no sustituye a otra que cubra un riesgo distinto.
- El proyecto usa React 18 + Vite. Ignora reglas exclusivas de Next.js, RSC o React 19.
- Las skills orientan el trabajo, pero no sustituyen la lectura del código, los tests ni la evidencia fresca.
- Agent Browser debe usar datos ficticios o anonimizados y operar en producción en modo de solo lectura salvo autorización explícita.
- Al cerrar una tarea sustancial, menciona qué skills se aplicaron y la validación ejecutada.