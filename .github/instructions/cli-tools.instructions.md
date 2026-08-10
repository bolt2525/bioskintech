---
description: "CLIs disponibles para operaciones DevOps en BIOSKIN_2.0: Vercel, Neon (Node.js scripts), Cloudflare Wrangler. Cargua esta instrucción antes de cualquier tarea de deployment, DB, variables de entorno o almacenamiento cloud."
name: "CLI Tools — Vercel, Neon, Cloudflare"
applyTo:
  - "scripts/**"
  - "api/**"
  - "lib/**"
---

# CLI Tools disponibles en BIOSKIN_2.0

## 1. Vercel CLI

**Estado**: Instalado y autenticado como `bolt2525-7925` / equipo `bioskintech (BIOSKINTECH)`.

**Comandos más usados:**
```bash
vercel whoami                              # Verificar sesión activa
vercel ls --limit 5                        # Ver últimos deploys
vercel --prod --yes                        # Deploy a producción (sin confirmar)
vercel env ls                              # Ver variables de entorno
vercel env add NOMBRE production --force   # Agregar/actualizar var (stdin = valor)
vercel inspect <url> --logs               # Ver logs de un deploy específico
```

**Patrón para agregar env vars via pipeline:**
```powershell
echo "valor_secreto" | vercel env add NOMBRE_VAR production --force
echo "valor_secreto" | vercel env add NOMBRE_VAR preview --force
```

**URL de producción**: `https://bioskintech.vercel.app`  
**Proyecto**: `bioskintech/bioskintech`

---

## 2. Neon PostgreSQL (vía scripts Node.js)

**No existe CLI nativa de Neon instalada.** Todo acceso a Neon se hace vía scripts Node.js que leen credenciales del `.env.local`.

**Patrón de ejecución:**
```bash
node --env-file=.env.local scripts/<nombre>.mjs
```

**Scripts disponibles en `scripts/`:**

| Script | Propósito |
|--------|-----------|
| `reset-database.mjs` | DROP de todas las tablas en orden FK inverso. Solo para datos de prueba. |
| `init-schema.mjs` | Crea schema auth (UUID) + schema clínico (UUID) desde cero. |
| `setup-bioskin-role.mjs` | Crea rol `bioskin_app` + FORCE RLS + 4 políticas por tabla clínica. Requiere `BIOSKIN_APP_PASSWORD`. |
| `seed-data.mjs` | Crea clínica BIOSKIN + master_admin + clinic_admin desde env vars. |

**Ejemplo: secuencia completa de reset + reinit:**
```powershell
# 1. Borrar tablas
node --env-file=.env.local scripts/reset-database.mjs

# 2. Recrear schema UUID
node --env-file=.env.local scripts/init-schema.mjs

# 3. Crear rol bioskin_app + RLS (generar password seguro)
$env:BIOSKIN_APP_PASSWORD = node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"
node --env-file=.env.local scripts/setup-bioskin-role.mjs

# 4. Sembrar datos iniciales
node --env-file=.env.local scripts/seed-data.mjs
```

**Pool neondb_owner** (admin): `NEON_DATABASE_URL` / `POSTGRES_URL`  
**Pool bioskin_app** (app con RLS): `NEON_APP_URL`  
**Dos clientes:**
- `getPool()` desde `lib/neon-clinical-db.js` → neondb_owner, bypasea RLS, solo para migrations
- `getAppPool()` desde `lib/neon-clinical-db.js` → bioskin_app, RLS enforced, para todas las queries clínicas

---

## 3. Cloudflare Wrangler

**Estado**: Instalado globalmente (v4.120.1). Autenticado con la cuenta `bolt2525@gmail.com` (Account ID: `9ea0b8c60134a90584195bf8954ad235`).

**Comandos R2 más usados:**
```bash
wrangler --version
wrangler r2 bucket list                           # Listar buckets
wrangler r2 bucket cors list bioskin-fotos        # Ver CORS del bucket
wrangler r2 bucket cors set bioskin-fotos --file r2-cors.json   # Deployer CORS
wrangler r2 bucket cors delete bioskin-fotos      # Borrar CORS
wrangler r2 object list bioskin-fotos             # Listar objetos
```

**Bucket de producción**: `bioskin-fotos`  
**Endpoint S3 del bucket**: `https://9ea0b8c60134a90584195bf8954ad235.r2.cloudflarestorage.com`  
**Archivo de reglas CORS**: `r2-cors.json` en la raíz del proyecto

---

## 4. Variables de entorno críticas

| Variable | Pool / Uso | Scope Vercel |
|----------|-----------|-------------|
| `NEON_DATABASE_URL` | neondb_owner (admin/master) | Dev, Preview, Prod |
| `POSTGRES_URL` | neondb_owner (alias) | Dev, Preview, Prod |
| `NEON_APP_URL` | bioskin_app (RLS enforced) | Preview, Prod |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 API token | Preview, Prod |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 API secret | Preview, Prod |
| `R2_BUCKET_NAME` | `bioskin-fotos` | Preview, Prod |
| `MASTER_LOGIN_KEY` | 3er factor de login master_admin | Preview, Prod |

---

## 5. Reglas de uso

- **Nunca crear un nuevo archivo `.db`** — toda persistencia va a Neon PostgreSQL.
- **Nunca usar `neondb_owner` en queries clínicas** — usar siempre `getAppPool()` + RLS.
- **Antes de agregar nuevas tablas clínicas**: agregarlas también a la lista `TENANT_TABLES` en `scripts/setup-bioskin-role.mjs` y volver a ejecutar el script.
- **Después de agregar variables de entorno**: siempre hacer `vercel --prod --yes` para que el deploy las recoja.
