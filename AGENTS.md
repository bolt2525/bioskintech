# Project Guidelines — BIOSKIN Admin Panel v2.0

## Ponytail — Lazy Senior Dev Mode (Activo)

Todos los agentes siguen el principio Ponytail: **el mejor código es el que nunca se escribe**.

Antes de escribir código, detente en el primer nivel que aguante:
1. ¿Necesita existir esto? (YAGNI)
2. ¿Lo hace la stdlib? Úsala.
3. ¿Lo cubre una feature nativa? Úsala.
4. ¿Lo resuelve una dependencia ya instalada? Úsala.
5. ¿Cabe en una línea? Hazlo en una línea.
6. Solo entonces: el mínimo que funcione.

- Sin abstracciones no pedidas. Sin boilerplate. Sin dependencias nuevas si se puede evitar.
- Marca simplificaciones con `// ponytail: <ceiling> → <upgrade path>`.
- No lazy en: validación en trust boundaries, seguridad, manejo de errores que previene pérdida de datos.

---

## 📐 Documentación de Arquitectura (Obligatorio para TODOS los agentes)
Cualquier agente — `Experto Frontend`, `Experto Backend`, `Guardián de Seguridad`, `Auditor de Código`, `DevOps y Vercel`, `QA y Testing` o el agente principal — que realice un cambio mayor en la estructura, arquitectura por capas, esquema de datos o integraciones externas **debe** actualizar `ARCHITECTURE.md` y `PROGRESS.md` como parte de esa misma tarea, siguiendo `.github/instructions/architecture-sync.instructions.md`. No se considera la tarea cerrada sin esa actualización, sin importar qué archivos haya tocado el agente.

## Agent Orchestration
Usa el agente más especializado posible según el tipo de tarea:

- **`Experto Frontend`**: cambios en `src/**`, UI/UX, React, Tailwind, accesibilidad y responsive design.
- **`Experto Backend`**: trabajo en `api/**`, `lib/**`, integraciones server-side, validaciones, endpoints y lógica de negocio.
- **`Guardián de Seguridad`**: datos sensibles, credenciales, contraseñas, autenticación, autorización, secretos, `api/**` y hardening.
- **`Auditor de Código`**: limpieza de código legacy, código no usado, errores, duplicación y refactorización segura.
- **`DevOps y Vercel`**: deploys, Vercel, producción, logs, variables de entorno y troubleshooting operativo.
- **`QA y Testing`**: reproducción de bugs, smoke tests, regresión, build/lint/tests y verificación final con evidencia.

## Collaboration Rules
- Si una tarea toca **seguridad**, prioriza `Guardián de Seguridad`.
- Si una tarea toca **backend** y además involucra datos sensibles, coordina `Experto Backend` + `Guardián de Seguridad`.
- Si una tarea modifica `api/**` o `lib/**`, debe pasar revisión de **seguridad** y **QA** antes de considerarse cerrada.
- Si una tarea afecta producción o deployment, usa `DevOps y Vercel`.
- Si se va a eliminar o simplificar código, valida primero con `Auditor de Código` y luego verifica con `QA y Testing`.
- Si una tarea cambia la estructura, arquitectura por capas, esquema de datos o integraciones externas, aplica **obligatoriamente** `.github/instructions/architecture-sync.instructions.md` — actualizar `ARCHITECTURE.md`/`PROGRESS.md` no es opcional.

## Skill Routing (Obligatorio)
Antes de buscar, editar o ejecutar comandos, carga las skills cuyo disparador coincida con la tarea. Si una tarea cruza categorías, combina las skills; no elijas solo una por conveniencia. La matriz completa vive en `.github/instructions/skill-routing.instructions.md`.

- **`vercel-operations`**: despliegues, producción, logs y Vercel.
- **`testing-validation`**: build, lint, tests, regresión y validación real.
- **`code-cleanup-audit`**: auditoría técnica, legacy y limpieza de código.
- **`web-design-guidelines`**: auditoría de UI, UX y accesibilidad.
- **`building-components`**: componentes accesibles, tokens y APIs componibles.
- **`vercel-react-best-practices`**: rendimiento React y optimización de bundle.
- **`vercel-composition-patterns`**: refactorización de componentes extensos; aplicar solo patrones compatibles con React 18.
- **`vercel-cli`**: comandos oficiales para inspeccionar y operar el proyecto Vercel.
- **`agent-browser`**: navegación, screenshots y smoke tests visuales.

Los agentes especializados deben aplicar estas combinaciones:
- **Frontend**: `building-components` + `vercel-react-best-practices`; sumar `web-design-guidelines` para auditoría y `vercel-composition-patterns` para refactorización estructural.
- **QA**: `testing-validation`; sumar `agent-browser` para flujos reales del navegador.
- **DevOps/Vercel**: `vercel-cli` + `vercel-operations` + `cli-tools.instructions.md`.

### Compatibilidad frontend de las skills
- El stack verificado es **React 18 + Vite**, sin Next.js. No aplicar reglas de Next.js, RSC ni APIs exclusivas de React 19.
- React 19 requiere una migración independiente y validación de los visores 3D: `@react-three/fiber@8` y `@react-three/drei@9` declaran React 18.
- Las skills externas se copian en `.agents/skills/` y se registran en `skills-lock.json`; no forman parte del bundle ni del runtime de producción.

### Uso seguro de Agent Browser
- Cargar primero `agent-browser skills get core` y cerrar la sesión al terminar.
- Usar cuentas de prueba y datos ficticios o anonimizados; no capturar pacientes, fichas clínicas, consentimientos, tokens, cookies ni credenciales reales.
- En producción, limitarse por defecto a recorridos de solo lectura. Cualquier alta, edición, eliminación, envío o pago requiere autorización explícita del usuario.
- Validar al menos desktop y móvil, sin confundir una captura visual con una prueba funcional completa.

## Build and Test
- `npm run build` para validación global del frontend.
- Usa scripts o pruebas relevantes antes de afirmar que un fix funciona.
- No declares éxito sin evidencia fresca.

## Búsqueda de Código
- Usa `rg --files -g '*.tsx'` para localizar archivos y `rg -n 'patrón' src api lib` para buscar texto con líneas; limita rutas y patrones para evitar resultados irrelevantes.
- En Windows, instala Ripgrep con `winget install --id BurntSushi.ripgrep.MSVC --exact --scope user --accept-package-agreements --accept-source-agreements` si no está disponible; abre una terminal nueva para actualizar `PATH` y comprueba con `rg --version`.
- Si `rg` no está instalado o no hay gestor disponible, usa la búsqueda de VS Code o `Select-String` en PowerShell; no bloquees la tarea por esta herramienta.

## Git Workflow (Obligatorio)
- Después de CADA cambio en el código, ejecutar siempre: `git add .`, `git commit -m "..."`, `git push`.
- **Repositorio**: `https://github.com/bolt2525/bioskintech.git` (cuenta bolt2525, privado).
- No cerrar una tarea con cambios en archivos sin commit/push.
- No declarar éxito sin evidencia de push exitoso.

## Project Conventions
- **Base de datos**: ÚNICAMENTE Neon PostgreSQL. No SQLite, no otros archivos `.db`.
- **Clientes de DB**: `getAppPool()` (lib/neon-clinical-db.js) para queries clínicas con RLS; `getPool()` solo para migraciones, inicialización y operaciones administrativas; `sql` (@vercel/postgres) para auth/bot.
- **Módulos**: Ver `lib/modules/` para la estructura de dominio.
- **Fichas Clínicas**: Sub-módulos (antecedentes, recetas, tratamientos, inyectables, consentimientos) en `api/records.js`.
- **Auth multi-tenant**: `master_admin` → `clinic_admin` → `clinic_user`. Siempre pasar por `lib/admin-auth.js`.
- **Design tokens**: Colores y roles en `src/constants/theme.ts`. No hardcodear `#deb887` en nuevos archivos.
- **Features**: Agregar nuevos módulos a `src/constants/features.ts` y a `ALL_FEATURES` en `api/admin-auth.js`.
- **Vercel Functions**: Límite 12 según el plan documentado. El repositorio contiene 11 archivos de función en `api/`; confirmar el límite y funciones efectivas en el proyecto Vercel antes de crear otra.
- **Rutas públicas**: El panel es el núcleo administrativo, pero también existen landing, reserva pública, firma de consentimientos y gestión médica externa; no añadir páginas públicas fuera de ese alcance sin documentarlas.
