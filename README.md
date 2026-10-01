# BIOSKIN Admin Panel

Panel multi-tenant de gestión para clínicas de estética médica. El frontend es una SPA
React 18 + TypeScript + Vite + TailwindCSS; las funciones de `/api/` se despliegan en
Vercel y la persistencia usa Neon PostgreSQL. Cloudflare R2 almacena fotografías y
respaldos cifrados.

## Desarrollo local

```bash
npm install
npm run dev
```

`npm run dev` sirve la SPA, pero no ejecuta las funciones serverless. Para probar el
flujo completo (SPA + `/api/`), usa `vercel dev` con las variables de `.env.local`.
No commits `.env`, `.env.local` ni credenciales.

## Comandos de validación

```bash
npm run build
npm run lint
npm run test:security
```

Las comprobaciones de aislamiento RLS requieren una conexión Neon configurada:

```bash
npm run test:rls
```

## Persistencia y seguridad

- Neon PostgreSQL es la única base de datos; no se deben crear archivos `.db`.
- `getPool()` (`NEON_DATABASE_URL`/`POSTGRES_URL`) se reserva para migraciones,
  inicialización y operaciones administrativas.
- Las consultas clínicas deben usar `getAppPool()` (`NEON_APP_URL`) con RLS y contexto
  de tenant.
- Las claves server-side no llevan prefijo `VITE_`; consulta `.env.example` para los
  nombres esperados.

## Rutas principales

- `/` — landing pública.
- `/reservar/:clinicSlug` — agendamiento público por clínica y profesional.
- `/gestionestetica/admin/**` — panel autenticado.
- `/consent-signing/:token` — firma pública de consentimientos.
- `/medical-finance` — gestión médica externa.

Actualmente hay 11 funciones serverless en `/api/`. Antes de añadir otra, revisa el
límite del plan de Vercel y si puede incorporarse a una función existente mediante
`action`.

## Scripts de base de datos

Los scripts de `scripts/` usan `node --env-file=.env.local scripts/<nombre>.mjs`.
`init-schema.mjs`, `apply-migrations.mjs`, `setup-bioskin-role.mjs` y `seed-data.mjs`
preparan una instalación; `reset-database.mjs` elimina tablas y solo debe usarse con
datos de prueba. Las migraciones son idempotentes: revisa el script y el esquema real
antes de ejecutarlas en producción.

La estructura detallada y el inventario verificado de APIs están en
[`ARCHITECTURE.md`](ARCHITECTURE.md); las reglas para agentes están en
[`AGENTS.md`](AGENTS.md).
