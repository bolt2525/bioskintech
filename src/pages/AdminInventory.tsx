import React, { useState, useEffect, useMemo } from 'react';
import { Package, Plus, CheckCircle, Activity, Calendar, Search, RefreshCw, LayoutGrid, List, Filter } from 'lucide-react';
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
import { useAuth } from '../context/AuthContext';

export default function AdminInventory() {
  const { username } = useAuth();
  const [activeTab, setActiveTab] = useState<'inventory' | 'batches' | 'movements'>('inventory');
  const [items, setItems] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loading, setLoading] = useState(true);

  // Search & filter state
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Modal / drawer state
  const [showForm, setShowForm] = useState(false);
  const [showStockModal, setShowStockModal] = useState(false);
  const [showConsumeModal, setShowConsumeModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [drawerItem, setDrawerItem] = useState<any>(null);

  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => { fetchInventory(); fetchStats(); }, []);

  useEffect(() => {
    if (successMessage) {
      const t = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMessage]);

  const fetchInventory = async () => {
    setLoading(true);
    try {
      const res = await recordsFetch('/api/records?action=inventoryListItems');
      if (res.ok) setItems(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const res = await recordsFetch('/api/records?action=inventoryStats');
      if (res.ok) setStats(await res.json());
    } catch (e) { console.error(e); }
    finally { setStatsLoading(false); }
  };

  const refresh = () => { fetchInventory(); fetchStats(); };

  const getApiErrorMessage = async (res: Response, fallback: string) => {
    try {
      const data = await res.json();
      return data?.error || fallback;
    } catch {
      return fallback;
    }
  };

  // â”€â”€ Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const handleCreateItem = async (data: any) => {
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

  const handleCreateWithStock = async (itemData: any, stockData: any) => {
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
      body: JSON.stringify({ ...stockData, item_id: newItem.id, user_id: username })
    });
    if (!batchRes.ok) throw new Error('Producto creado pero error al registrar stock inicial');
    setSuccessMessage('Producto creado con stock inicial');
    refresh();
  };

  const handleDeleteItem = async (item: any) => {
    if (!window.confirm(`¿Eliminar "${item.name}"? Esta acción no se puede deshacer.`)) return;
    const res = await recordsFetch(`/api/records?action=inventoryDeleteItem&id=${item.id}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); alert(e.error || 'Error al eliminar'); return; }
    setDrawerItem(null);
    setSuccessMessage('Producto eliminado');
    refresh();
  };

  const handleAddStock = async (data: any) => {
    const res = await recordsFetch('/api/records?action=inventoryAddBatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, user_id: username })
    });
    if (!res.ok) throw new Error('Error al agregar stock');
    setSuccessMessage('Stock ingresado');
    refresh();
    setShowStockModal(false);
  };

  const handleConsumeStock = async (data: any) => {
    const res = await recordsFetch('/api/records?action=inventoryConsume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, user_id: username })
    });
    if (!res.ok) throw new Error('Error al registrar consumo');
    setSuccessMessage('Consumo registrado');
    refresh();
    setShowConsumeModal(false);
  };

  // â”€â”€ Filtered items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchSearch = !search
        || item.name.toLowerCase().includes(search.toLowerCase())
        || (item.sku || '').toLowerCase().includes(search.toLowerCase());
      const matchCat = categoryFilter === 'all' || item.category === categoryFilter;
      return matchSearch && matchCat;
    });
  }, [items, search, categoryFilter]);

  const categories = useMemo(() => {
    const cats = Array.from(new Set(items.map(i => i.category).filter(Boolean)));
    return cats.sort();
  }, [items]);

  const suggestedSku = useMemo(() => {
    const numericSkus = items
      .map(i => String(i?.sku ?? '').trim())
      .filter(s => /^\d+$/.test(s))
      .map(s => parseInt(s, 10));

    const next = (numericSkus.length > 0 ? Math.max(...numericSkus) : items.length) + 1;
    return String(next).padStart(3, '0');
  }, [items]);

  const TABS = [
    { id: 'inventory' as const, label: 'Inventario', icon: Package },
    { id: 'batches' as const, label: 'Lotes', icon: Calendar },
    { id: 'movements' as const, label: 'Movimientos', icon: Activity },
  ];

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

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 p-1 bg-gray-100/80 rounded-2xl w-fit">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-white text-[#b8905a] shadow-sm ring-1 ring-gray-200'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200/50'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* â”€â”€ INVENTORY TAB â”€â”€ */}
      {activeTab === 'inventory' && (
        <div className="space-y-5">
          {/* KPI Overview */}
          <InventoryOverview stats={stats} loading={statsLoading} />

          {/* Alerts banner */}
          {stats?.alert_batches?.length > 0 || stats?.out_of_stock_count > 0 || stats?.low_stock_count > 0 ? (
            <InventoryAlerts
              alertBatches={stats?.alert_batches || []}
              outOfStockCount={stats?.out_of_stock_count || 0}
              lowStockCount={stats?.low_stock_count || 0}
            />
          ) : null}

          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4 pointer-events-none" />
              <input
                type="text"
                placeholder="Buscar por nombre o SKU..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887] focus:border-[#deb887] outline-none bg-white"
              />
            </div>
            {/* Category filter chips */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setCategoryFilter('all')}
                className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                  categoryFilter === 'all'
                    ? 'bg-[#deb887] text-white shadow-sm'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Todos
              </button>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                    categoryFilter === cat
                      ? 'bg-[#deb887] text-white shadow-sm'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <motion.button
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                onClick={refresh}
                className="p-2.5 rounded-xl text-gray-400 hover:text-[#b8905a] hover:bg-[#deb887]/10 transition-colors border border-gray-200"
                title="Actualizar"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={() => { setSelectedItem(null); setShowForm(true); }}
                className="flex items-center gap-2 bg-[#deb887] text-white px-4 py-2.5 rounded-xl hover:bg-[#c5a075] transition-colors text-sm font-semibold shadow-sm shadow-[#deb887]/30"
              >
                <Plus className="w-4 h-4" />
                Nuevo Producto
              </motion.button>
            </div>
          </div>

          {/* Product grid */}
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-52 bg-white rounded-2xl border border-gray-100 animate-pulse" />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-gray-100 text-gray-400">
              <Package className="w-12 h-12 mb-3 opacity-30" />
              <p className="font-medium">No se encontraron productos</p>
              {search && <p className="text-sm mt-1">Prueba con otro tÃ©rmino de bÃºsqueda</p>}
            </div>
          ) : (
            <motion.div
              layout
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
            >
              <AnimatePresence>
                {filteredItems.map((item, idx) => (
                  <InventoryProductCard
                    key={item.id}
                    item={item}
                    index={idx}
                    onSelect={(i) => setDrawerItem(i)}
                    onAddStock={(i) => { setSelectedItem(i); setShowStockModal(true); }}
                    onConsume={(i) => { setSelectedItem(i); setShowConsumeModal(true); }}
                    onEdit={(i) => { setSelectedItem(i); setShowForm(true); }}
                    onDelete={handleDeleteItem}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      )}

      {/* â”€â”€ BATCHES TAB â”€â”€ */}
      {activeTab === 'batches' && (
        <div className="animate-enter">
          <InventoryBatches />
        </div>
      )}

      {/* â”€â”€ MOVEMENTS TAB â”€â”€ */}
      {activeTab === 'movements' && (
        <div className="animate-enter">
          <InventoryMovements />
        </div>
      )}

      {/* â”€â”€ DRAWER â”€â”€ */}
      <InventoryProductDrawer
        item={drawerItem}
        onClose={() => setDrawerItem(null)}
        onEdit={(i) => { setDrawerItem(null); setSelectedItem(i); setShowForm(true); }}
        onAddStock={(i) => { setSelectedItem(i); setShowStockModal(true); }}
        onConsume={(i) => { setSelectedItem(i); setShowConsumeModal(true); }}
        onDelete={handleDeleteItem}
      />

      {/* â”€â”€ MODALS â”€â”€ */}
      {showForm && (
        <InventoryForm
          initialData={selectedItem}
          suggestedSku={selectedItem?.id ? undefined : suggestedSku}
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
    </AdminLayout>
  );
}
