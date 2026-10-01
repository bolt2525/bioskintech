import React, { useState, useEffect, useMemo } from 'react';
import { Package, Plus, CheckCircle, Activity, Calendar, Search, RefreshCw, Archive, BarChart3 } from 'lucide-react';
import recordsFetch from "../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import AdminLayout from '../components/layout/AdminLayout';
import InventoryProductCard from '../components/admin/inventory/InventoryProductCard';
import InventoryProductDrawer from '../components/admin/inventory/InventoryProductDrawer';
import InventoryAlerts from '../components/admin/inventory/InventoryAlerts';
import InventoryForm from '../components/admin/inventory/InventoryForm';
import StockMovementModal from '../components/admin/inventory/StockMovementModal';
import ConsumeModal from '../components/admin/inventory/ConsumeModal';
import InventoryMovements from '../components/admin/inventory/InventoryMovements';
import InventoryBatches from '../components/admin/inventory/InventoryBatches';
import InventoryOverview from '../components/admin/inventory/InventoryOverview';
import InventorySales from '../components/admin/inventory/InventorySales';
import { useAuth } from '../context/AuthContext';
import { useMasterView } from '../context/MasterViewContext';

interface InventoryItem {
  id: number;
  sku: string;
  name: string;
  brand?: string;
  category: string;
  group_name?: string;
  unit_of_measure: string;
  total_stock: number;
  expired_stock?: number;
  total_initial?: number;
  batch_count?: number;
  preferred_display_unit?: 'absolute' | 'percentage';
  min_stock_level: number;
  next_expiry: string;
  requires_cold_chain: boolean;
  sanitary_registration?: string;
  description?: string;
  cost_price?: number | null;
  sale_price?: number | null;
  is_archived?: boolean;
  archive_reason?: string | null;
  created_by_user_name?: string;
}

interface InventoryItemDraft {
  id?: number;
  sku?: string;
  [key: string]: string | number | boolean | null | undefined;
}

type InventoryStockInput = Record<string, string | number | boolean | null | undefined>;
interface InventoryStats {
  total_items?: number;
  archived_items_count?: number;
}

export default function AdminInventory() {
  const { user } = useAuth();
  const masterView = useMasterView();
  const isAdmin = user?.role === 'clinic_admin' || user?.role === 'master_admin';
  const [activeTab, setActiveTab] = useState<'inventory' | 'batches' | 'movements' | 'sales'>('inventory');
  const [productView, setProductView] = useState<'active' | 'archived'>('active');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  // Categories from clinic settings (fallback to categories from existing items)
  const [settingsCategories, setSettingsCategories] = useState<string[]>([]);
  const [groupNames, setGroupNames] = useState<{ category: string; name: string }[]>([]);
  const [groupLoadError, setGroupLoadError] = useState(false);

  // Search & filter state
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'out' | 'low' | 'expired'>('all');

  // Modal / drawer state
  const [showForm, setShowForm] = useState(false);
  const [showStockModal, setShowStockModal] = useState(false);
  const [showConsumeModal, setShowConsumeModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [drawerItem, setDrawerItem] = useState<InventoryItem | null>(null);

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<InventoryItem | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveError, setArchiveError] = useState('');
  // Filtro por profesional (solo admins)
  const [filterUserId, setFilterUserId] = useState<number | ''>('');
  const [clinicUsers, setClinicUsers] = useState<{ id: number; username: string; full_name: string }[]>([]);

  useEffect(() => { fetchInventory(); fetchStats(); fetchGroups(); }, [filterUserId, productView, user?.clinic_id, masterView.clinicId]);

  // Cargar categorías y settings de inventario desde configuración de clínica
  useEffect(() => {
    const cid = user?.clinic_id;
    if (!cid) return;
    fetch(`/api/admin-auth?action=getClinicSettings&clinicId=${cid}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` }
    }).then(r => r.json()).then(d => {
      const cats = d.settings?.inventario?.categories;
      if (Array.isArray(cats) && cats.length > 0) setSettingsCategories(cats);
    }).catch(() => {});
  }, [user?.clinic_id]);

  // Cargar usuarios de la clínica para el filtro (solo admins)
  useEffect(() => {
    if (isAdmin) {
      setClinicUsers([]);
      recordsFetch('/api/records?action=listClinicUsers')
        .then(r => r.json())
        .then(d => Array.isArray(d) ? setClinicUsers(d) : null)
        .catch(() => null);
    }
  }, [isAdmin, masterView.clinicId, user?.clinic_id]);

  useEffect(() => { setFilterUserId(''); setCategoryFilter('all'); setProductView('active'); }, [masterView.clinicId, user?.clinic_id]);

  useEffect(() => {
    if (successMessage) {
      const t = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMessage]);

  const fetchInventory = async () => {
    setLoading(true);
    try {
      const url = filterUserId
        ? `/api/records?action=inventoryListItems&status=${productView}&filterByUserId=${filterUserId}`
        : `/api/records?action=inventoryListItems&status=${productView}`;
      const res = await recordsFetch(url);
      if (res.ok) setItems(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchGroups = async () => {
    setGroupNames([]);
    try {
      const res = await recordsFetch('/api/records?action=inventoryListGroups');
      if (!res.ok) throw new Error('Error al cargar subcategorías');
      setGroupNames(await res.json());
      setGroupLoadError(false);
    } catch {
      setGroupNames([]);
      setGroupLoadError(true);
    }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const res = await recordsFetch('/api/records?action=inventoryStats');
      if (res.ok) setStats(await res.json());
    } catch (e) { console.error(e); }
    finally { setStatsLoading(false); }
  };

  const refresh = () => { fetchInventory(); fetchStats(); fetchGroups(); };

  const getApiErrorMessage = async (res: Response, fallback: string) => {
    try {
      const data = await res.json();
      return data?.error || fallback;
    } catch {
      return fallback;
    }
  };

  // â”€â”€ Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const handleCreateItem = async (data: InventoryItemDraft) => {
    const action = data.id ? 'inventoryUpdateItem' : 'inventoryCreateItem';
    const res = await recordsFetch(`/api/records?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      throw new Error(await getApiErrorMessage(res, data.id ? 'Error al actualizar' : 'Error al crear producto'));
    }
    const saved = await res.json();
    setSuccessMessage(data.id ? 'Producto actualizado' : 'Producto creado');
    refresh();
    return saved;
  };

  const handleCreateWithStock = async (itemData: InventoryItemDraft, stockData: InventoryStockInput) => {
    // Step 1: create item
    const itemRes = await recordsFetch('/api/records?action=inventoryCreateItem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(itemData)
    });
    if (!itemRes.ok) throw new Error(await getApiErrorMessage(itemRes, 'Error al crear producto'));
    const newItem = await itemRes.json();

    // Step 2: add initial batch
    const batchRes = await recordsFetch('/api/records?action=inventoryAddBatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stockData, item_id: newItem.id, user_id: user?.id })
    });
    if (!batchRes.ok) {
      refresh(); // el item ya fue creado aunque el batch falle
      throw new Error(`Producto creado, pero no se registró el stock inicial: ${await getApiErrorMessage(batchRes, 'Error de lote')}`);
    }
    setSuccessMessage('Producto creado con stock inicial');
    refresh();
  };

  const handleArchiveItem = (item: InventoryItem) => { setArchiveTarget(item); setArchiveReason(''); setArchiveError(''); };

  const confirmArchive = async () => {
    if (!archiveTarget || archiveReason.trim().length < 8) return;
    try {
      const res = await recordsFetch('/api/records?action=inventoryArchiveItem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: archiveTarget.id, reason: archiveReason.trim() })
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'No se pudo archivar el producto'));
      setArchiveTarget(null);
      setArchiveReason('');
      setDrawerItem(null);
      setProductView('active');
      setSuccessMessage('Producto archivado; historial conservado');
      refresh();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'No se pudo archivar el producto');
    }
  };

  const handleRestoreItem = async (item: InventoryItem) => {
    try {
      const res = await recordsFetch('/api/records?action=inventoryRestoreItem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id })
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'No se pudo restaurar el producto'));
      setDrawerItem(null);
      setProductView('active');
      setSuccessMessage('Producto restaurado al inventario activo');
      refresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'No se pudo restaurar el producto');
    }
  };

  const handleAddStock = async (data: InventoryStockInput) => {
    const res = await recordsFetch('/api/records?action=inventoryAddBatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, user_id: user?.id })
    });
    if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Error al agregar stock'));
    setSuccessMessage('Stock ingresado');
    refresh();
    setShowStockModal(false);
  };

  const handleConsumeStock = async (data: InventoryStockInput) => {
    const res = await recordsFetch('/api/records?action=inventoryConsume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, user_id: user?.id })
    });
    if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Error al registrar consumo'));
    setSuccessMessage('Consumo registrado');
    refresh();
    setShowConsumeModal(false);
  };

  // â”€â”€ Filtered items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const filteredItems = useMemo(() => {
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
    const terms = normalize(search.trim()).split(/\s+/).filter(Boolean);
    return items.filter(item => {
      const searchable = normalize([item.name, item.sku, item.brand, item.category, item.group_name].filter(Boolean).join(' '));
      const matchSearch = terms.every(term => searchable.includes(term));
      const matchCat = categoryFilter === 'all' || item.category?.trim() === categoryFilter;
      const stock = Number(item.total_stock);
      const matchStock = stockFilter === 'all' || (stockFilter === 'out' && stock === 0)
        || (stockFilter === 'low' && stock > 0 && stock <= Number(item.min_stock_level))
        || (stockFilter === 'expired' && Number(item.expired_stock) > 0);
      return matchSearch && matchCat && matchStock;
    });
  }, [items, search, categoryFilter, stockFilter]);

  const stockCounts = useMemo(() => ({
    out: items.filter(item => Number(item.total_stock) === 0).length,
    low: items.filter(item => Number(item.total_stock) > 0 && Number(item.total_stock) <= Number(item.min_stock_level)).length,
    expired: items.filter(item => Number(item.expired_stock) > 0).length,
  }), [items]);

  const categories = useMemo(() => {
    return Array.from(new Set(items.map(item => item.category?.trim()).filter(Boolean))).sort() as string[];
  }, [items]);

  const formCategories = useMemo(() => Array.from(new Set([
    'Consumibles', 'Inyectable', 'Equipamiento', 'Venta',
    ...settingsCategories, ...categories, ...groupNames.map(group => group.category).filter(Boolean)
  ])).sort(), [categories, settingsCategories, groupNames]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, Map<string, { name: string; items: InventoryItem[] }>>();
    filteredItems.forEach(item => {
      const category = item.category?.trim() || 'Sin categoría';
      const name = item.group_name?.trim().replace(/\s+/g, ' ') || 'Otros';
      const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
      if (!groups.has(category)) groups.set(category, new Map());
      const categoryGroups = groups.get(category)!;
      if (!categoryGroups.has(key)) categoryGroups.set(key, { name, items: [] });
      categoryGroups.get(key)!.items.push(item);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'es'))
      .map(([category, subgroups]) => [category, Array.from(subgroups.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'))] as const);
  }, [filteredItems]);

  const suggestedSku = useMemo(() => {
    const numericSkus = items
      .map(i => String(i?.sku ?? '').trim())
      .filter(s => /^\d+$/.test(s))
      .map(s => parseInt(s, 10));

    const next = (numericSkus.length > 0 ? Math.max(...numericSkus) : items.length) + 1;
    return String(next).padStart(3, '0');
  }, [items]);

  const TABS = [
    { id: 'inventory' as const, label: 'Inventario', hint: 'Stock actual', icon: Package },
    { id: 'batches' as const, label: 'Lotes', hint: 'Caducidad', icon: Calendar },
    { id: 'movements' as const, label: 'Movimientos', hint: 'Trazabilidad', icon: Activity },
    { id: 'sales' as const, label: 'Ventas', hint: 'Rendimiento', icon: BarChart3 },
  ];

  const handleOverviewMetric = (metric: 'products' | 'lowStock' | 'batches' | 'movements') => {
    if (metric === 'batches' || metric === 'movements') {
      setActiveTab(metric);
      return;
    }
    setProductView('active');
    setStockFilter(metric === 'lowStock' ? 'low' : 'all');
  };

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return (
    <AdminLayout title="Inventario Clínico" subtitle="Gestión de productos, stock y trazabilidad">

      {/* Toast success */}
      <AnimatePresence>
        {successMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="fixed top-20 right-4 z-50 bg-emerald-600 text-white px-4 py-3 rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-200"
          >
            <CheckCircle className="w-4 h-4" />
            {successMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Consola de navegación */}
      <section className="mb-5 overflow-hidden rounded-2xl border border-emerald-950/15 bg-[#172522] shadow-xl shadow-emerald-950/10" aria-label="Centro de control de inventario">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2.5 sm:px-5">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-300">Centro de control</h2>
          <p className="hidden text-xs text-gray-400 sm:block">Stock, trazabilidad y rendimiento</p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-white/10 lg:grid-cols-4" role="group" aria-label="Secciones de inventario">
          {TABS.map((tab, index) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
                aria-pressed={selected}
                className={`admin-focus-ring group flex min-h-16 items-center gap-3 bg-[#172522] px-4 py-3 text-left transition-[background-color,color] duration-200 hover:bg-white/10 ${selected ? 'bg-white text-gray-950' : 'text-white'}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold ${selected ? 'border-amber-300 bg-amber-100 text-amber-900' : 'border-white/15 bg-white/5 text-amber-300'}`}>
                  <tab.icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className={`block text-[10px] font-medium tabular-nums ${selected ? 'text-gray-500' : 'text-gray-400'}`}>0{index + 1}</span>
                  <span className="block truncate text-sm font-semibold">{tab.label}</span>
                  <span className={`hidden text-[11px] sm:block ${selected ? 'text-gray-600' : 'text-gray-400'}`}>{tab.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* â”€â”€ INVENTORY TAB â”€â”€ */}
      {activeTab === 'inventory' && (
        <div className="space-y-5">
          {/* KPI Overview */}
          {productView === 'active' && <InventoryOverview stats={stats} loading={statsLoading} onSelectMetric={handleOverviewMetric} />}

          {/* Alerts banner */}
          {productView === 'active' && (stats?.alert_batches?.length > 0 || stats?.out_of_stock_count > 0 || stats?.low_stock_count > 0) ? (
            <InventoryAlerts
              alertBatches={stats?.alert_batches || []}
              outOfStockCount={stats?.out_of_stock_count || 0}
              lowStockCount={stats?.low_stock_count || 0}
            />
          ) : null}

          {/* Toolbar */}
          <div className="space-y-3 rounded-2xl border border-white/70 bg-white/95 p-3 shadow-xl shadow-black/10 sm:p-4">
            <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
              {/* Filtro por profesional — solo admins */}
              {isAdmin && user?.inventory_scope !== 'own' && clinicUsers.length > 0 && (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <label htmlFor="inventory-professional" className="text-xs font-medium text-gray-600">Profesional</label>
                  <select
                    id="inventory-professional"
                    value={filterUserId}
                    onChange={e => setFilterUserId(e.target.value ? Number(e.target.value) : '')}
                    className="admin-focus-ring min-h-10 min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm lg:flex-none"
                  >
                    <option value="">Todos</option>
                    {clinicUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Search */}
              <div className="relative min-w-0 flex-1">
                <label htmlFor="inventory-search" className="sr-only">Buscar productos</label>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4 pointer-events-none" />
                <input
                  id="inventory-search"
                  type="search"
                  placeholder="Buscar producto, marca, grupo o SKU…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="admin-focus-ring min-h-10 w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-4 text-sm"
                />
              </div>
              {/* Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <motion.button
                  whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                  onClick={refresh}
                  className="admin-focus-ring min-h-10 min-w-10 rounded-xl border border-gray-200 p-2.5 text-gray-500 transition-colors hover:bg-amber-50 hover:text-amber-800"
                  title="Actualizar"
                  aria-label="Actualizar inventario"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => { setSelectedItem(null); setShowForm(true); }}
                  disabled={productView === 'archived'}
                  className="admin-focus-ring flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gray-700 disabled:opacity-50 lg:flex-none"
                >
                  <Plus className="w-4 h-4" />
                  Nuevo Producto
                </motion.button>
              </div>
            </div>
            {isAdmin && <div className="inline-flex max-w-full items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1" role="group" aria-label="Estado de productos">
              {([
                ['active', 'Activos', stats?.total_items ?? 0],
                ['archived', 'Archivados', stats?.archived_items_count ?? 0],
              ] as const).map(([view, label, count]) => (
                <button key={view} type="button" aria-pressed={productView === view}
                  onClick={() => { setProductView(view); setCategoryFilter('all'); setStockFilter('all'); }}
                  className={`admin-focus-ring rounded-md px-3 py-2 text-xs font-semibold transition-colors ${productView === view ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:bg-white/70'}`}>
                  {label} <span className="ml-1 text-gray-500 tabular-nums">{count}</span>
                </button>
              ))}
            </div>}
            {productView === 'archived' && <div className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Productos fuera del stock activo. Sus ventas y movimientos se conservan; restáuralos para volver a operar.
            </div>}
            {/* Category filter chips */}
            <div className="flex w-full items-center gap-1.5 flex-wrap" role="group" aria-label="Filtrar por categoría">
              <button
                type="button"
                onClick={() => setCategoryFilter('all')}
                aria-pressed={categoryFilter === 'all'}
                className={`admin-focus-ring rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  categoryFilter === 'all'
                    ? 'bg-amber-100 text-amber-950 ring-1 ring-amber-300'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Todos
              </button>
              {categories.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  aria-pressed={categoryFilter === cat}
                  className={`admin-focus-ring rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                    categoryFilter === cat
                      ? 'bg-amber-100 text-amber-950 ring-1 ring-amber-300'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            {productView === 'active' && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por estado de stock">
              {([
                ['all', 'Todo el stock', items.length],
                ['out', 'Agotados', stockCounts.out],
                ['low', 'Bajo stock', stockCounts.low],
                ['expired', 'Con vencidos', stockCounts.expired],
              ] as const).map(([key, label, count]) => (
                <button key={key} type="button" onClick={() => setStockFilter(key)} aria-pressed={stockFilter === key}
                  className={`admin-focus-ring rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${stockFilter === key ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}>
                  {label} <span className={stockFilter === key ? 'text-amber-300' : 'text-gray-500'}>{count}</span>
                </button>
              ))}
            </div>}
          </div>

          {/* Product grid */}
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-52 bg-white rounded-2xl border border-gray-100 animate-pulse" />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-gray-100 text-gray-700">
              <Package className="w-12 h-12 mb-3 opacity-30" />
              <p className="font-medium">{productView === 'archived' ? 'No hay productos archivados' : 'No se encontraron productos'}</p>
              {search && <p className="text-sm mt-1">Prueba con otro término de búsqueda</p>}
            </div>
          ) : (
            <div className="space-y-7">
              {groupedItems.map(([category, subgroups]) => (
                <section key={category} aria-labelledby={`inventory-category-${category.replace(/\W+/g, '-').toLowerCase()}`}>
                  <div className="mb-3 flex items-center gap-2 border-b border-gray-200 pb-2">
                    <h2 id={`inventory-category-${category.replace(/\W+/g, '-').toLowerCase()}`} className="text-sm font-semibold text-gray-900">
                      {category}
                    </h2>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">{subgroups.reduce((total, group) => total + group.items.length, 0)}</span>
                  </div>
                  <div className="space-y-5">
                    {subgroups.map(group => (
                      <div key={group.name}>
                        <h3 className="mb-2 text-xs font-semibold text-gray-700">{group.name} <span className="text-gray-500">({group.items.length})</span></h3>
                        <motion.div layout className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          <AnimatePresence>
                            {group.items.map((item, idx) => (
                              <div key={item.id}>
                                <InventoryProductCard
                                  item={item}
                                  index={idx}
                                  showOwner={isAdmin}
                                  onSelect={(i) => setDrawerItem(i)}
                                  onAddStock={(i) => { setSelectedItem(i); setShowStockModal(true); }}
                                  onConsume={(i) => { setSelectedItem(i); setShowConsumeModal(true); }}
                                  onEdit={(i) => { setSelectedItem(i); setShowForm(true); }}
                                  onArchive={handleArchiveItem}
                                  onRestore={handleRestoreItem}
                                  canArchive={isAdmin}
                                />
                              </div>
                            ))}
                          </AnimatePresence>
                        </motion.div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* â”€â”€ BATCHES TAB â”€â”€ */}
      {activeTab === 'batches' && (
        <div className="animate-enter">
          <InventoryBatches canDelete={isAdmin} />
        </div>
      )}

      {/* â”€â”€ MOVEMENTS TAB â”€â”€ */}
      {activeTab === 'movements' && (
        <div className="animate-enter">
          <InventoryMovements canDelete={isAdmin} canClear={user?.role === 'master_admin'} />
        </div>
      )}

      {activeTab === 'sales' && (
        <InventorySales categories={categories} filterUserId={user?.inventory_scope === 'own' ? '' : filterUserId}
          clinicKey={String(masterView.clinicId ?? user?.clinic_id ?? '')} />
      )}

      {/* â”€â”€ DRAWER â”€â”€ */}
      <InventoryProductDrawer
        item={drawerItem}
        onClose={() => setDrawerItem(null)}
        onEdit={(i) => { setDrawerItem(null); setSelectedItem(i); setShowForm(true); }}
        onAddStock={(i) => { setSelectedItem(i); setShowStockModal(true); }}
        onConsume={(i) => { setSelectedItem(i); setShowConsumeModal(true); }}
        onArchive={handleArchiveItem}
        onRestore={handleRestoreItem}
        canArchive={isAdmin}
      />

      {/* â”€â”€ MODALS â”€â”€ */}
      {showForm && (
        <InventoryForm
          initialData={selectedItem}
          suggestedSku={selectedItem?.id ? undefined : suggestedSku}
          categories={formCategories.length > 0 ? formCategories : undefined}
          groupNames={groupNames}
          groupLoadError={groupLoadError}
          onClose={() => { setShowForm(false); setSelectedItem(null); }}
          onSave={handleCreateItem}
          onSaveWithStock={selectedItem?.id ? undefined : handleCreateWithStock}
        />
      )}
      {showStockModal && selectedItem && (
        <StockMovementModal
          item={selectedItem}
          onClose={() => { setShowStockModal(false); setSelectedItem(null); }}
          onSave={handleAddStock}
        />
      )}
      {showConsumeModal && selectedItem && (
        <ConsumeModal
          item={selectedItem}
          onClose={() => { setShowConsumeModal(false); setSelectedItem(null); }}
          onSave={handleConsumeStock}
        />
      )}

      {/* ── CONFIRM ARCHIVE MODAL ── */}
      <AnimatePresence>
        {archiveTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => { setArchiveTarget(null); setArchiveError(''); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 bg-amber-50 rounded-full flex items-center justify-center">
                  <Archive className="w-7 h-7 text-amber-800" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Archivar producto</h3>
                  <p className="text-sm text-gray-700 mt-1">
                    <span className="font-semibold text-gray-900">{archiveTarget.name}</span> dejará de aparecer en el inventario activo y no permitirá entradas ni salidas. Sus lotes y ventas se conservarán; puedes restaurarlo después.
                  </p>
                </div>
                {(Number(archiveTarget.total_stock) > 0 || Number(archiveTarget.expired_stock) > 0) && <p className="w-full border-l-2 border-amber-500 bg-amber-50 p-2 text-left text-xs text-amber-950">
                  Se conservan {Number(archiveTarget.total_stock) || 0} {archiveTarget.unit_of_measure} disponibles y {Number(archiveTarget.expired_stock) || 0} vencidas. No se borran y no podrán moverse mientras esté archivado.
                </p>}
                <label htmlFor="inventory-archive-reason" className="w-full text-left text-xs font-semibold text-gray-700">
                  Motivo del archivo (obligatorio)
                  <textarea id="inventory-archive-reason" maxLength={300} rows={3} value={archiveReason}
                    onChange={event => { setArchiveReason(event.target.value); setArchiveError(''); }}
                    placeholder="Ej. Producto descontinuado por el proveedor"
                    className="mt-1.5 w-full resize-y rounded-md border border-gray-300 p-2.5 text-sm font-normal text-gray-900 placeholder:text-gray-500 focus:border-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-700/25" />
                  <span className="mt-1 block font-normal text-gray-600">{archiveReason.trim().length}/300 (mínimo 8 caracteres)</span>
                </label>
                {archiveError && <p role="alert" className="w-full text-left text-sm font-medium text-red-700">{archiveError}</p>}
                <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end mt-2">
                  <button
                    type="button"
                    onClick={() => { setArchiveTarget(null); setArchiveError(''); }}
                    className="px-4 py-2.5 rounded-md border border-gray-300 text-gray-800 font-medium text-sm hover:bg-gray-50 transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={confirmArchive}
                    disabled={archiveReason.trim().length < 8}
                    className="px-4 py-2.5 rounded-md bg-amber-800 hover:bg-amber-900 text-white font-semibold text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Archivar y conservar historial
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </AdminLayout>
  );
}
