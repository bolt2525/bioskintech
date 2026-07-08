# Ponytail — Lazy Senior Dev Mode

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does the standard library already do this? Use it.
3. Does a native platform feature cover it? Use it.
4. Does an already-installed dependency solve it? Use it.
5. Can this be one line? Make it one line.
6. Only then: write the minimum code that works.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size — lazy means less code, not the flimsier algorithm.
- Mark intentional simplifications with a `ponytail:` comment. If the shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), the comment names the ceiling and the upgrade path.

Not lazy about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested. Non-trivial logic leaves ONE runnable check behind — the smallest thing that fails if the logic breaks. Trivial one-liners need no test.

---

# BIOSKIN Admin Panel — AI Developer Guide (v2.0)

## Project Overview
**BIOSKIN_2.0** es el panel de administración multi-tenant para clínicas de estética médica.
Construido con **React 18 + TypeScript + Vite + TailwindCSS** (frontend) y **Vercel Serverless Functions + Neon PostgreSQL** (backend).

Este proyecto es el **panel admin exclusivo** — NO contiene páginas públicas del sitio web.

## Architecture & Key Patterns

### Core Structure
- **Frontend**: React SPA con HashRouter (requerido para Vercel SPA sin SSR)
- **Backend**: Vercel serverless functions en `/api/`
- **Base de datos**: **Neon PostgreSQL ÚNICAMENTE** — no hay SQLite ni otra BD
- **Auth**: Multi-tenant con roles (master_admin → clinic_admin → clinic_user)
- **Styling**: TailwindCSS con tema dorado (`#deb887`) y fuentes Poppins/Playfair Display
- **State Management**: React Context (AuthContext) + component-level state

### ⚠️ REGLAS CRÍTICAS DE BASE DE DATOS
- **UNA SOLA BASE DE DATOS**: Neon PostgreSQL vía `NEON_DATABASE_URL` o `POSTGRES_URL`
- **NO crear nuevas bases de datos** ni archivos `.db`
- **DOS clientes disponibles**:
  - `getPool()` de `lib/neon-clinical-db.js` — para fichas clínicas (driver `pg`, tiene type parsers de fechas)
  - `sql` de `@vercel/postgres` — para auth, bot, finanzas (template literal)
- **Ver** `lib/db/index.js` para el punto de entrada unificado

### Estructura de Módulos del Proyecto
```
lib/
├── db/                    ← Capa de DB unificada (ver lib/db/index.js)
├── modules/
│   ├── fichas-clinicas/   ← Antecedentes, recetas, tratamientos, inyectables, consentimientos
│   ├── agenda/            ← Google Calendar, bloqueo de horarios
│   ├── finanzas/          ← Ingresos, egresos, reportes
│   ├── ia/                ← Diagnóstico IA, protocolos, asistente Gema
│   ├── inventario/        ← Stock, lotes, vencimientos
│   ├── bot-interno/       ← Bot WhatsApp staff, agenda diaria
│   └── tecnico/           ← Reparaciones, informes BioskinTech
├── admin-auth.js          ← Helper de auth para APIs
├── neon-clinical-db.js    ← Pool pg con type parsers de fechas
└── neon-chatbot-db.js     ← Tablas del bot (internal_bot_*, chatbot_*)
```

### 🚨 **CRITICAL VERCEL CONSTRAINTS**

#### **Serverless Functions Limit**
- **MÁXIMO 12 funciones** en Vercel Hobby plan
- **Inventario actual** de `/api/`:
  ```
  admin-auth.js, backup.js, calendar.js, external-finance.js,
  internal-bot-api.js, records.js, search.js, sendEmail.js,
  system-status.js, technical-service.js, whatsapp-internal.js
  ```
  → **11 funciones usadas, 1 disponible**
- **Regla**: Antes de crear una nueva función, verificar si se puede agregar a una existente

#### **Vercel Storage**
- Filesystem: read-only (excepto `/tmp` — 500MB, temporal)
- **NO escribir archivos en Vercel** — usar Neon PostgreSQL
- Proyecto ID: configurar en nueva cuenta Vercel

#### **Database Management**
- **SINGLE DATABASE ONLY**: Use existing SQLite database at `data/blogs.db`
- **NO additional databases**: Don't create new DB files or external databases
- **Schema expansion**: Add tables to existing database using `lib/database.js`
- **Migrations**: Use existing initialization scripts in `init-database.js`

### Critical File Organization
```
src/
├── types/index.ts            # Interfaces TypeScript centralizadas
├── constants/
│   ├── features.ts           # MODULE_CONFIG unificado (admin modules)
│   └── theme.ts              # Design tokens: colores gold, role-colors
├── context/AuthContext.tsx   # Auth multi-tenant (JWT + roles)
├── hooks/useAuth.ts          # Re-exporta useAuth del contexto
├── components/
│   ├── layout/AdminLayout.tsx # Layout base de todas las páginas admin
│   ├── ui/                   # Primitivos: Select, Skeleton, Toggle, Tooltip
│   └── admin/
│       ├── ficha-clinica/    # Pacientes, antecedentes, recetas, tratamientos
│       ├── inventory/        # Inventario: lotes, movimientos, alertas
│       └── technical/        # Servicio técnico: documentos e informes
├── pages/                    # Solo páginas admin (no hay páginas públicas)
└── utils/slugify.ts
api/                          # Vercel serverless functions (11 funciones)
lib/
├── db/index.js               # Punto de entrada unificado de DB
├── modules/                  # Módulos organizados por dominio
│   ├── fichas-clinicas/      # Antecedentes, recetas, tratamientos, inyectables
│   ├── agenda/               # Google Calendar
│   ├── finanzas/             # Finance db + AI
│   ├── ia/                   # AI diagnóstico, protocolos, asistente
│   ├── inventario/           # (doc — lógica en api/records.js)
│   ├── bot-interno/          # WhatsApp staff bot
│   └── tecnico/              # (doc — lógica en api/technical-service.js)
├── neon-clinical-db.js       # Pool pg con type parsers de fechas
└── neon-chatbot-db.js        # Tablas bot (internal_bot_*, chatbot_*)
```

### Fichas Clínicas — Sub-módulos
El módulo más importante. Acciones en `api/records.js`:
- **Pacientes**: listPatients, createPatient, updatePatient, deletePatient
- **Expediente**: listRecords, createRecord, getRecordData
- **Antecedentes**: saveHistory
- **Consulta**: saveConsultation, deleteConsultationHistory
- **Examen físico**: savePhysicalExam
- **Diagnóstico**: saveDiagnosis, getDiagnosisContext, generateDiagnosisAI
- **Tratamientos**: addTreatment, updateTreatment, deleteTreatment, generateTreatmentAI
- **Inyectables**: addInjectable, updateInjectable (toxina, rellenos)
- **Recetas**: createPrescription, listPrescriptions, getTemplates
- **Consentimientos**: saveConsent, generateSigningToken, submitSignature

### Auth Multi-Tenant
- Roles: `master_admin` (global) > `clinic_admin` (clínica) > `clinic_user` (limitado)
- Tokens: PBKDF2+salt via Node crypto (sin deps extra)
- Rate limit: 5 intentos → bloqueo 15 min
- `hasFeature(feature)` controla acceso a módulos por clínica

### Integration Points

#### Google Services Integration
- **Calendar API**: `/api/getEvents.js` - fetches occupied time slots
- **Email**: `/api/sendEmail.js` - sends confirmation emails and WhatsApp notifications
- **Environment**: Requires `GOOGLE_CREDENTIALS_BASE64` and email credentials

#### WhatsApp Integration Pattern
Email API automatically generates WhatsApp messages with this format:
```javascript
const whatsappMessage = `Hola ${paciente}, ¡gracias por agendar tu cita en BIOSKIN! 🧴✨\n` +
  `Hemos recibido tu solicitud para el servicio "${tratamiento}".\n`;
```

### Component Patterns

#### ImageCarousel Component
Standardized carousel for product/service images with consistent `height` prop:
```tsx
<ImageCarousel images={images} folderPath="" height="h-48" />
```

#### Responsive Design
Uses TailwindCSS with mobile-first approach and custom container class `container-custom`.

### Build & Deployment
- **Dev**: `npm run dev` (Vite dev server)
- **Build**: `npm run build` (outputs to `dist/`)
- **Deploy**: Vercel with SPA routing via `vercel.json` rewrites
- **Linting**: ESLint with React hooks and TypeScript rules

## 🎯 **RESOURCE MANAGEMENT GUIDELINES**

### **Vercel Serverless Functions - STRICT LIMITS**
**CRITICAL**: Vercel Hobby plan allows MAXIMUM 12 serverless functions

#### **Current Function Inventory (Monitor Before Adding New)**
```
/api/
├── ai-blog/generate-production.js  # AI blog generation
├── blogs/index.js                  # Blog listing endpoint  
├── blogs/[slug].js                 # Individual blog endpoint
├── blogs/static.js                 # Static fallback
├── getEvents.js                    # Google Calendar integration
└── sendEmail.js                    # Email/WhatsApp notifications
```

#### **Function Development Rules**
1. **Before creating ANY new function**: Count existing functions in `/api/`
2. **Combine related functionality** into single endpoints
3. **Use query parameters** instead of separate endpoints when possible
4. **Delete unused functions** immediately
5. **Prefer client-side logic** when security allows

#### **Function Consolidation Strategies**
- ✅ Use `/api/blogs/index.js?action=list|get|search` instead of separate endpoints
- ✅ Combine CRUD operations in single function with method switching
- ✅ Use dynamic routes `[...params].js` for multiple related endpoints
- ❌ Don't create separate functions for similar operations

### **Database Management - SINGLE SOURCE (Neon PostgreSQL)**
**CRÍTICO**: Usar ÚNICAMENTE Neon PostgreSQL. No hay SQLite, no hay otros archivos `.db`.

#### **Reglas de base de datos**
1. **NO nuevos archivos de base de datos**: No crear archivos `.db`
2. **NO bases de datos adicionales**: Todo en Neon PostgreSQL
3. **Expansión de esquema**: Agregar tablas con `CREATE TABLE IF NOT EXISTS`
4. **Usar los pools existentes**: `lib/neon-clinical-db.js` (pg) o `@vercel/postgres` (sql)
5. **Migraciones**: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (idempotente)

#### **Agregar nuevas tablas**
```javascript
// En lib/neon-clinical-db.js — agregar a initClinicalDatabase()
await pool.query(`
  CREATE TABLE IF NOT EXISTS nueva_tabla (
    id SERIAL PRIMARY KEY,
    clinic_id INTEGER,
    -- ... campos
    created_at TIMESTAMP DEFAULT NOW()
  )
`);
```

## Configuración de OpenAI (API Key)
- Variable requerida: `OPENAI_API_KEY` (NO usar prefijo `VITE_` — solo server-side).
- Dónde se usa: `lib/ai-service.js` y `lib/chatbot-*-ai-service.js` vía `process.env.OPENAI_API_KEY`.

### Local (desarrollo)
- Copiar `.env.example` → `.env` y completar todas las variables.
- Usar `vercel dev` para levantar las funciones serverless localmente.
- El Vite dev server no ejecuta las APIs — las variables solo se consumen en los handlers de `/api/*`.

### Producción (Vercel)
- Vercel Dashboard → Project → Settings → Environment Variables
- Variables requeridas: ver `.env.example` en la raíz del proyecto.
- Re-deploy después de agregar variables.

### Seguridad
- No exponer claves en el frontend (sin prefijo `VITE_`).
- `.gitignore` ya excluye `.env`.

### Variables de entorno requeridas (resumen)
```
NEON_DATABASE_URL       — Neon PostgreSQL (ÚNICO DB)
GOOGLE_CREDENTIALS_BASE64 — Google Calendar service account
EMAIL_USER / EMAIL_PASS — SMTP para emails
OPENAI_API_KEY          — IA diagnóstico, protocolos, asistente
GEMINI_API_KEY          — Análisis de imágenes (Gemini)
WHATSAPP_TOKEN          — Bot WhatsApp interno
MASTER_ADMIN_USERNAME / MASTER_ADMIN_PASSWORD — Usuario master
ADMIN_USERNAME / ADMIN_PASSWORD — Admin de clínica BIOSKIN
ADMIN_SETUP_SECRET      — Protege /api/admin-auth?action=initMultiTenant
```

### Vercel Extension Integration
Usar la extensión Vercel de VSCode para diagnosticar deploys, ver logs y gestionar variables de entorno.

#### **Critical Vercel Storage Facts**
- **Filesystem**: Read-only con `/tmp` escribible (500MB, temporal)
- **NO SQLite en producción**: Usar Neon PostgreSQL para toda persistencia
- **Functions**: Máximo 12 en Hobby plan
- **Project**: Enlazar con nueva cuenta Vercel al hacer deploy

### Git Workflow
**OBLIGATORIO** — después de CADA cambio en el código, ejecutar siempre estos comandos:
```bash
git add .
git commit -m "descripción concisa del cambio"
git push
```
**Repositorio remoto**: `https://github.com/bolt2525/bioskintech.git` (cuenta: bolt2525, privado).
- No cerrar ninguna tarea sin hacer commit + push al repo.
- No declarar éxito sin evidencia de que el push fue exitoso.

### Spanish Language
All user-facing content is in Spanish. Maintain Spanish naming conventions for components, routes, and content.

**IMPORTANT**: Always respond to the user in Spanish, as this is a Spanish-language project for a medical clinic in a Spanish-speaking region.

### Critical Dependencies
- `react-router-dom ^7.6.0` with HashRouter
- `lucide-react` for icons (excluded from Vite optimization)
- `googleapis` for Google Calendar/Email integration
- `nodemailer` for email sending

When adding new products, update `src/data/products.ts` and ensure images follow the established directory structure.

## ⚠️ **MANDATORY VALIDATION CHECKLIST**

### **Before Creating Any New API Function**
1. ✅ Count existing functions in `/api/` directory (must be < 12)
2. ✅ Check if functionality can be added to existing endpoint
3. ✅ Consider using query parameters instead of new function
4. ✅ Document function purpose and ensure it's essential
5. ✅ If creating new function, delete unused ones first

### **Before Adding Data Storage**
1. ✅ Verificar si los datos caben en tablas existentes de Neon PostgreSQL
2. ✅ Agregar nuevas tablas con `CREATE TABLE IF NOT EXISTS` en `lib/neon-clinical-db.js`
3. ✅ Usar migraciones incrementales `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
4. ✅ **NUNCA** crear archivos `.db` o bases de datos adicionales
5. ✅ Respetar el tenant (`clinic_id`) en todas las tablas de datos de clínica

### **Function Efficiency Rules**
- **Combine**: Related operations in single function
- **Parameterize**: Use query params for variations
- **Reuse**: Extend existing functions when possible
- **Document**: Clear purpose for each function
- **Monitor**: Keep track of total function count

## 📚 Documentation Management Protocol

### **Automatic Documentation Updates**
**MANDATORY**: After completing ANY file creation, modification, or feature implementation, you MUST update the following documentation files:

#### **1. PROGRESS.md Updates**
Add a brief entry (1-3 lines) to the current phase section:
```markdown
- ✅ [Date] Brief description of change/addition
```
**Example**: `- ✅ Oct 16 Added documentation management protocol`

#### **2. ARCHITECTURE.md Updates**
Update relevant sections if structural changes were made:
- **File additions**: Update directory structure
- **New components**: Add to component library section
- **API changes**: Update endpoints section
- **Database changes**: Update database layer section

#### **Documentation Update Rules**
1. **Be Concise**: Use 3-5 words maximum per entry
2. **Be Specific**: Mention exact feature/file affected
3. **Use Consistent Format**: Follow existing patterns
4. **Update Both Files**: Progress for timeline, Architecture for structure
5. **Mark Complete**: Use ✅ for finished items

#### **When to Update Documentation**
- ✅ New file creation
- ✅ Component modifications
- ✅ API endpoint changes
- ✅ Database schema updates
- ✅ Configuration changes
- ✅ Feature implementations
- ✅ Bug fixes that affect structure

#### **Documentation Workflow**
```
1. Complete development work
2. Test functionality
3. Update PROGRESS.md (add to current phase)
4. Update ARCHITECTURE.md (if structural changes)
5. Git commit with descriptive message
6. Git push
```

**Remember**: Documentation is NOT optional - it's part of the development process and must be updated with every change.
