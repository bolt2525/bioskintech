/**
 * @file lib/modules/inventario/index.js
 * @description Módulo de Inventario — control de stock, lotes y vencimientos.
 *
 * ─── Funcionalidades ─────────────────────────────────────────────────────────
 *  - CRUD de productos/items de inventario
 *  - Gestión de lotes con fechas de vencimiento
 *  - Movimientos de stock (entradas, salidas, consumos)
 *  - Alertas de stock mínimo y vencimientos próximos
 *
 * ─── Base de datos ───────────────────────────────────────────────────────────
 * Tablas en Neon PostgreSQL:
 *   inventory_categories, suppliers, inventory_items, inventory_batches
 *
 * ─── Frontend ────────────────────────────────────────────────────────────────
 * @see src/components/admin/inventory/  — Componentes React
 * @see src/pages/AdminInventory.tsx     — Página principal
 *
 * ─── Backend ─────────────────────────────────────────────────────────────────
 * @see api/records.js  — Handler HTTP (acciones con prefijo 'inventory')
 */

// El inventario está manejado directamente en api/records.js
// (acciones con prefijo 'inventory*'). No hay lib separada.
// Este archivo sirve como documentación del módulo.
