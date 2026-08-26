
import { useState, useEffect, useCallback } from 'react';
import recordsFetch from "../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Calendar, DollarSign, TrendingUp, TrendingDown, 
  Trash2, Edit2, Check, X, FileText, PieChart, BarChart2, Search, Filter, Info, Plus,
  Download, ChevronDown, ChevronUp, Package, Calculator
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer 
} from 'recharts';
import { useAuth } from '../hooks/useAuth';

interface FinanceRecord {
  id: number;
  date: string;
  invoice_number?: string;
  entity: string;
  description?: string;
  type: 'ingreso' | 'egreso';
  subtotal: number | string;
  tax: number | string;
  total: number | string;
  registered_by?: string;
}

interface FinanceUser {
  id: number;
  username: string;
  full_name: string;
  role: string;
  finance_visible: boolean;
}

interface FinanceItem {
  id?: number;
  description: string;
  quantity: number;
  unit_price: number;
  iva_rate: number;
  subtotal: number;
  tax: number;
  total: number;
}

// Calcula totales de un item dado sus campos base
const calcItem = (it: Partial<FinanceItem>, defaultIva = 15): FinanceItem => {
  const qty     = parseFloat(String(it.quantity  ?? 1));
  const uprice  = parseFloat(String(it.unit_price ?? 0));
  const ivaRate = parseFloat(String(it.iva_rate   ?? defaultIva));
  const subtotal = parseFloat((qty * uprice).toFixed(2));
  const tax      = parseFloat((subtotal * ivaRate / 100).toFixed(2));
  return { description: it.description || '', quantity: qty, unit_price: uprice, iva_rate: ivaRate, subtotal, tax, total: parseFloat((subtotal + tax).toFixed(2)) };
};

// Si el usuario ingresa el TOTAL, calcula subtotal e IVA
const calcFromTotal = (total: number, ivaRate: number): { subtotal: number; tax: number } => {
  const subtotal = parseFloat((total / (1 + ivaRate / 100)).toFixed(2));
  const tax      = parseFloat((total - subtotal).toFixed(2));
  return { subtotal, tax };
};

// Normaliza separadores decimales: acepta tanto punto como coma
const parseAmount = (v: string): number => parseFloat(String(v).replace(',', '.')) || 0;

const EMPTY_FORM = { date: new Date().toISOString().split('T')[0], invoice_number: '', entity: '', description: '', type: 'ingreso' as const, subtotal: '', tax: '', total: '' };
const EMPTY_ITEM = (ivaRate = 15): FinanceItem => ({ description: '', quantity: 1, unit_price: 0, iva_rate: ivaRate, subtotal: 0, tax: 0, total: 0 });

// ── Exportar CSV desde los registros actuales ──────────────────────────────
const exportCSV = (records: FinanceRecord[], filename = 'finanzas') => {
  const headers = ['Fecha', 'N° Factura', 'Entidad', 'Descripción', 'Tipo', 'Subtotal', 'IVA', 'Total', 'Registrado por'];
  const rows = records.map(r => [
    String(r.date || '').split('T')[0],
    r.invoice_number || '',
    r.entity,
    r.description || '',
    r.type,
    parseFloat(String(r.subtotal || 0)).toFixed(2),
    parseFloat(String(r.tax || 0)).toFixed(2),
    parseFloat(String(r.total || 0)).toFixed(2),
    r.registered_by || ''
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click(); URL.revokeObjectURL(url);
};

const AdminFinance = () => {
  const { user } = useAuth();
  const [records, setRecords] = useState<FinanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // Multi-selección de usuarios — Set vacío = Vista Global (todos)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [financeUsers, setFinanceUsers] = useState<FinanceUser[]>([]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [taxRate, setTaxRate] = useState(15); // % IVA desde settings de clínica
  const [clinicTaxRate, setClinicTaxRate] = useState(15); // valor original inmutable del settings
  const [taxRateEditing, setTaxRateEditing] = useState(false); // campo IVA editable en el form
  const [currencySymbol, setCurrencySymbol] = useState('$');
  const [invoicePrefix, setInvoicePrefix] = useState('FAC');
  // Items del formulario nuevo
  const [newItems, setNewItems] = useState<FinanceItem[]>([]);
  const [showItems, setShowItems] = useState(false);
  // Modal de desglose para registros existentes
  const [desgModal, setDesgModal] = useState<{ open: boolean; record: FinanceRecord | null; items: FinanceItem[]; loading: boolean; updateRecord: boolean }>({ open: false, record: null, items: [], loading: false, updateRecord: false });

  // Cargar settings de finanzas de la clínica
  useEffect(() => {
    const cid = user?.clinic_id;
    if (!cid) return;
    fetch(`/api/admin-auth?action=getClinicSettings&clinicId=${cid}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` }
    }).then(r => r.json()).then(d => {
      const fin = d.settings?.finanzas ?? {};
      const taxPct = parseFloat(String(fin.tax_percent ?? 15));
      if (!isNaN(taxPct)) { setTaxRate(taxPct); setClinicTaxRate(taxPct); }
      setCurrencySymbol(fin.currency_symbol || '$');
      setInvoicePrefix(fin.invoice_prefix || 'FAC');
    }).catch(() => {});
  }, [user?.clinic_id]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'ingreso' | 'egreso'>('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFormData, setEditFormData] = useState<Partial<FinanceRecord>>({});

  // carga usuarios al montar (solo admin o master)
  useEffect(() => {
    if (user?.role === 'clinic_admin' || user?.role === 'master_admin') {
      recordsFetch('/api/records?action=financeUsers')
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setFinanceUsers(d); })
        .catch(() => {});
    }
  }, [user?.role]);

  useEffect(() => {
    fetchData();
  }, [selectedUsers, dateRange]);

  // Derived State
  const filteredRecords = records.filter(record => {
    const searchLower = searchTerm.toLowerCase();
    const searchMatch = 
        record.entity.toLowerCase().includes(searchLower) ||
        (record.description || '').toLowerCase().includes(searchLower) ||
        (record.invoice_number || '').toLowerCase().includes(searchLower);
        
    const typeMatch = typeFilter === 'all' || record.type === typeFilter;
    
    return searchMatch && typeMatch;
  });

  const toggleSelection = (id: number) => {
    setSelectedIds(prev => 
        prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedIds.length === filteredRecords.length) {
        setSelectedIds([]);
    } else {
        setSelectedIds(filteredRecords.map(r => r.id));
    }
  };

  const getSelectionMetrics = () => {
    const selected = records.filter(r => selectedIds.includes(r.id));
    
    // Función auxiliar para sumar campos por tipo
    const sum = (type: 'ingreso' | 'egreso', field: keyof FinanceRecord) => 
        selected
            .filter(r => r.type === type)
            .reduce((s, r) => s + parseFloat(String(r[field] || 0)), 0);

    const subtotal = sum('ingreso', 'subtotal') - sum('egreso', 'subtotal');
    const tax = sum('ingreso', 'tax') - sum('egreso', 'tax');
    const total = sum('ingreso', 'total') - sum('egreso', 'total');

    return { subtotal, tax, total, count: selected.length };
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      // Set vacío = Global (todos); Set con usuarios = filtrar por esos usuarios
      const registeredBy = selectedUsers.size === 0
        ? 'all'
        : Array.from(selectedUsers).join(',');
      const queryParams = new URLSearchParams({
        action: 'financeList',
        registered_by: registeredBy,
        startDate: dateRange.start || '',
        endDate: dateRange.end || ''
      });
      const recordsRes = await recordsFetch(`/api/records?${queryParams.toString()}`);
      const recordsData = await recordsRes.json();
      if (Array.isArray(recordsData)) setRecords(recordsData);
    } catch (error) {
      console.error('Error fetching finance data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newForm.entity.trim()) return;
    setSaving(true);
    try {
      // Si hay items, los totales se calculan de ellos
      let sub  = parseFloat(String(newForm.subtotal || 0));
      let taxV = parseFloat(String(newForm.tax  || 0));
      let tot  = parseFloat(String(newForm.total || 0));

      if (showItems && newItems.length > 0) {
        sub  = parseFloat(newItems.reduce((s, it) => s + it.subtotal, 0).toFixed(2));
        taxV = parseFloat(newItems.reduce((s, it) => s + it.tax, 0).toFixed(2));
        tot  = parseFloat(newItems.reduce((s, it) => s + it.total, 0).toFixed(2));
      } else if (!tot && (sub || taxV)) {
        tot = parseFloat((sub + taxV).toFixed(2));
      }

      if (tot === 0 && !window.confirm('El valor total es $0.00.\n¿Desea guardar este registro como referencia sin valor contable?')) {
        setSaving(false);
        return;
      }

      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'financeCreate', ...newForm, subtotal: sub, tax: taxV, total: tot })
      });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json();

      // Guardar items si los hay
      if (showItems && newItems.length > 0 && created.id) {
        const itemsRes = await recordsFetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'financeItemsSave', record_id: created.id, items: newItems })
        });
        if (!itemsRes.ok) {
          const errData = await itemsRes.json().catch(() => ({}));
          throw new Error(errData.error || `Error al guardar desglose (${itemsRes.status})`);
        }
      }

      setNewForm(EMPTY_FORM); setNewItems([]); setShowItems(false); setShowNewForm(false);
      fetchData();
    } catch (e: any) {
      alert('Error al guardar: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  // Normaliza campos NUMERIC de PostgreSQL que llegan como strings
  const normalizeItem = (it: any): FinanceItem => ({
    ...it,
    quantity:   parseFloat(it.quantity   ?? 1),
    unit_price: parseFloat(it.unit_price ?? 0),
    iva_rate:   parseFloat(it.iva_rate   ?? 0),
    subtotal:   parseFloat(it.subtotal   ?? 0),
    tax:        parseFloat(it.tax        ?? 0),
    total:      parseFloat(it.total      ?? 0),
  });

  const openDesglose = async (record: FinanceRecord) => {
    setDesgModal({ open: true, record, items: [], loading: true, updateRecord: false });
    try {
      const res  = await recordsFetch(`/api/records?action=financeItemsGet&record_id=${record.id}`);
      const data = await res.json();
      setDesgModal(prev => ({ ...prev, items: Array.isArray(data) ? data.map(normalizeItem) : [], loading: false }));
    } catch {
      setDesgModal(prev => ({ ...prev, items: [], loading: false }));
    }
  };

  const saveDesglose = async () => {
    if (!desgModal.record) return;
    setSaving(true);
    try {
      await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'financeItemsSave', record_id: desgModal.record.id, items: desgModal.items })
      });
      if (desgModal.updateRecord) {
        const rec = desgModal.record;
        const iSub = parseFloat(desgModal.items.reduce((s, it) => s + parseFloat(String(it.subtotal || 0)), 0).toFixed(2));
        const iTax = parseFloat(desgModal.items.reduce((s, it) => s + parseFloat(String(it.tax || 0)), 0).toFixed(2));
        const iTot = parseFloat(desgModal.items.reduce((s, it) => s + parseFloat(String(it.total || 0)), 0).toFixed(2));
        await recordsFetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'financeUpdate', id: rec.id, date: rec.date, invoice_number: rec.invoice_number, entity: rec.entity, description: rec.description, type: rec.type, subtotal: iSub, tax: iTax, total: iTot })
        });
      }
      setDesgModal({ open: false, record: null, items: [], loading: false, updateRecord: false });
      fetchData();
    } catch (e: any) {
      alert('Error al guardar desglose: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('¿Estás seguro de eliminar este registro?')) return;
    try {
      await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'financeDelete', id })
      });
      fetchData();
    } catch (e) {
      alert('Error al eliminar');
    }
  };

  const getMetrics = () => {
    const sourceRecords = filteredRecords;
    
    // Función auxiliar para sumar campos
    const sum = (type: 'ingreso' | 'egreso', field: keyof FinanceRecord) => 
      sourceRecords
        .filter(r => r.type === type)
        .reduce((s, r) => s + parseFloat(String(r[field] || 0)), 0);

    const totalIngresos = sum('ingreso', 'total');
    const totalEgresos = sum('egreso', 'total');
    
    // Cálculo de valores específicos para SRI
    const ivaIngresos = sum('ingreso', 'tax');
    const ivaEgresos = sum('egreso', 'tax');
    const subtotalIngresos = sum('ingreso', 'subtotal');
    const subtotalEgresos = sum('egreso', 'subtotal');

    // Cálculo Neto: (Ingresos) - (Egresos)
    const totalIVA = ivaIngresos - ivaEgresos;
    const totalSubtotal = subtotalIngresos - subtotalEgresos;
    const balanceTotal = totalIngresos - totalEgresos;

    return { 
        totalIngresos, totalEgresos, 
        ivaIngresos, ivaEgresos, 
        subtotalIngresos, subtotalEgresos,
        balanceTotal, totalIVA 
    };
  };

  const metrics = getMetrics();

  const graphData = [
    { name: 'Ingresos', value: metrics.totalIngresos, fill: '#10b981' },
    { name: 'Egresos', value: metrics.totalEgresos, fill: '#ef4444' }
  ];

  /* 
   * REMOVED: Broken Pie Chart Visualization 
   * REPLACED WITH: SRI Fiscal Analysis Card
   */

  const startEdit = (record: FinanceRecord) => {
    setEditingId(record.id);
    setEditFormData({ ...record });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditFormData({});
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      setLoading(true);
      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'financeUpdate', 
          ...editFormData 
        })
      });
      
      if (!res.ok) throw new Error(await res.text());
      
      alert("✅ Registro actualizado correctamente");
      fetchData(); // Refresh data
      setEditingId(null);
    } catch(e) {
      console.error(e);
      alert('Error updating record: ' + e);
    } finally {
      setLoading(false);
    }
  };

  const handleEditChange = (field: keyof FinanceRecord, value: any) => {
    setEditFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-gradient-to-r from-gray-900 to-gray-800 text-white pt-12 pb-24 px-4 shadow-xl">
        <div className="container-custom mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-center mb-6">
            <div>
              <h1 className="text-3xl font-serif font-bold mb-2 flex items-center gap-3">
                <DollarSign className="text-yellow-500" /> Finanzas & Facturas
              </h1>
              <p className="opacity-70">
                {user?.role === 'clinic_user'
                  ? 'Mis registros de ingresos y egresos'
                  : selectedUsers.size === 0
                    ? 'Vista global de ingresos y egresos'
                    : selectedUsers.size === 1
                      ? `Finanzas de: ${financeUsers.find(u => u.username === Array.from(selectedUsers)[0])?.full_name ?? Array.from(selectedUsers)[0]}`
                      : `${selectedUsers.size} usuarios seleccionados`
                }
              </p>
            </div>
            
            {/* ── Filtro de usuario (solo admin/master) ── */}
            {(user?.role === 'clinic_admin' || user?.role === 'master_admin') && financeUsers.length > 0 && (
              <div className="mt-4 md:mt-0 flex flex-col items-end gap-1.5">
                <select
                  value={selectedUsers.size === 0 ? '__global__' : (selectedUsers.size === 1 ? Array.from(selectedUsers)[0] : '__multi__')}
                  onChange={e => {
                    const val = e.target.value;
                    if (val === '__global__') { setSelectedUsers(new Set()); return; }
                    // Selección individual desde el dropdown → Set de 1
                    setSelectedUsers(new Set([val]));
                  }}
                  className="px-4 py-2 bg-gray-800/60 border border-gray-600 text-white rounded-xl text-sm focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 outline-none cursor-pointer backdrop-blur min-w-[180px]"
                >
                  <option value="__global__">🌐 Vista Global</option>
                  <optgroup label="── Usuarios ──">
                    {financeUsers.map(fu => (
                      <option
                        key={fu.username}
                        value={fu.username}
                        disabled={!fu.finance_visible}
                        className={!fu.finance_visible ? 'text-gray-500' : ''}
                      >
                        {!fu.finance_visible ? '🔒 ' : ''}{fu.full_name}
                      </option>
                    ))}
                  </optgroup>
                </select>

                {/* Multi-selección: checkboxes desplegables cuando hay >1 usuario */}
                {financeUsers.filter(fu => fu.finance_visible).length > 1 && (
                  <div className="flex flex-wrap gap-1 justify-end max-w-xs">
                    {financeUsers.filter(fu => fu.finance_visible).map(fu => {
                      const isOn = selectedUsers.has(fu.username);
                      return (
                        <button
                          key={fu.username}
                          onClick={() => setSelectedUsers(prev => {
                            const next = new Set(prev);
                            if (next.has(fu.username)) next.delete(fu.username);
                            else next.add(fu.username);
                            return next;
                          })}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all border ${
                            isOn
                              ? 'bg-yellow-500 text-gray-900 border-yellow-500'
                              : 'text-gray-400 border-gray-600 hover:border-gray-400'
                          }`}
                        >
                          {isOn ? '✓ ' : ''}{fu.full_name.split(' ')[0]}
                        </button>
                      );
                    })}
                    {selectedUsers.size > 0 && (
                      <button onClick={() => setSelectedUsers(new Set())} className="px-2 py-0.5 rounded-full text-[10px] text-gray-500 border border-gray-600 hover:text-white">✕ limpiar</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="container-custom mx-auto -mt-16 px-4">

        {/* ── Barra superior: botones nuevo registro + export ── */}
        <div className="flex justify-between items-center mb-3">
          <button
            onClick={() => setShowNewForm(v => !v)}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-500 hover:bg-yellow-400 text-gray-900 font-semibold rounded-xl shadow-md text-sm transition-all"
          >
            <Plus size={16} /> Nuevo Registro
          </button>
          <button
            onClick={() => exportCSV(filteredRecords, `finanzas${selectedUsers.size === 1 ? '_'+Array.from(selectedUsers)[0] : ''}`)}
            disabled={filteredRecords.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm transition-all disabled:opacity-40"
          >
            <Download size={15} /> Exportar CSV ({filteredRecords.length})
          </button>
        </div>

        {/* ── Formulario de nuevo registro ── */}
        <AnimatePresence>
          {showNewForm && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="bg-white rounded-2xl shadow-lg border border-yellow-200 p-5 mb-6"
            >
              <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><Plus size={14} className="text-yellow-500" /> Nueva Factura / Registro</h3>

              {/* Campos principales */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Fecha</label>
                  <input type="date" value={newForm.date} onChange={e => setNewForm(p => ({...p, date: e.target.value}))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Nº Factura</label>
                  <input type="text" value={newForm.invoice_number} onChange={e => setNewForm(p => ({...p, invoice_number: e.target.value}))} placeholder={`${invoicePrefix}-001`} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none" />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-gray-500 mb-1 block">Entidad / Cliente *</label>
                  <input type="text" value={newForm.entity} onChange={e => setNewForm(p => ({...p, entity: e.target.value}))} placeholder="Nombre de empresa o persona" className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Descripción general</label>
                  <input type="text" value={newForm.description} onChange={e => setNewForm(p => ({...p, description: e.target.value}))} placeholder="Ej: Compra de insumos, Venta de tratamiento..." className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none" />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 mb-1 block">Tipo</label>
                    <select value={newForm.type} onChange={e => setNewForm(p => ({...p, type: e.target.value as any}))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none">
                      <option value="ingreso">Ingreso</option>
                      <option value="egreso">Egreso</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-500 mb-1 block">IVA %</label>
                    {!taxRateEditing ? (
                      <div className="flex items-center gap-1.5 px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg cursor-pointer group"
                        onClick={() => setTaxRateEditing(true)}
                        title="Click para editar el IVA de este registro">
                        <span className="text-sm text-gray-400 font-mono flex-1">{taxRate}%</span>
                        <Edit2 size={12} className="text-gray-300 group-hover:text-yellow-500 transition-colors flex-shrink-0" />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input
                          type="number" autoFocus
                          value={taxRate}
                          onChange={e => setTaxRate(parseFloat(e.target.value) || 0)}
                          min={0} max={100} step={0.5}
                          className="w-full px-3 py-2 border border-yellow-400 rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none font-mono"
                          onBlur={() => setTaxRateEditing(false)}
                          onKeyDown={e => e.key === 'Enter' && setTaxRateEditing(false)}
                        />
                        <button onClick={() => { setTaxRate(clinicTaxRate); setTaxRateEditing(false); }}
                          title="Restaurar IVA de la clínica"
                          className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
                          <X size={13}/>
                        </button>
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400 mt-0.5">Por defecto: {clinicTaxRate}% (MasterAdmin)</p>
                  </div>
                </div>
              </div>

              {/* Totales directos cuando NO hay desglose */}
              {!showItems && (
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Subtotal</label>
                    <input type="text" inputMode="decimal" value={newForm.subtotal} onChange={e => {
                      const sub = parseAmount(e.target.value);
                      const tax = parseFloat((sub * taxRate / 100).toFixed(2));
                      setNewForm(p => ({...p, subtotal: e.target.value, tax: String(tax), total: String(parseFloat((sub+tax).toFixed(2)))}));
                    }} placeholder="0.00" className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none text-right" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">IVA</label>
                    <input type="text" inputMode="decimal" value={newForm.tax} onChange={e => setNewForm(p => ({...p, tax: e.target.value}))} placeholder="0.00" className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none text-right" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block flex items-center gap-1"><Calculator size={11}/> Total (calcular desde total)</label>
                    <input type="text" inputMode="decimal" value={newForm.total} onChange={e => {
                      const tot = parseAmount(e.target.value);
                      const { subtotal, tax } = calcFromTotal(tot, taxRate);
                      setNewForm(p => ({...p, total: e.target.value, subtotal: String(subtotal), tax: String(tax)}));
                    }} placeholder="0.00" className="w-full px-3 py-2 border border-yellow-300 rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none text-right font-bold" />
                  </div>
                </div>
              )}

              {/* Toggle desglose */}
              <button type="button"
                onClick={() => { setShowItems(v => !v); if (!showItems && newItems.length === 0) setNewItems([EMPTY_ITEM(taxRate)]); }}
                className="flex items-center gap-1.5 text-xs text-yellow-600 font-medium hover:text-yellow-800 mb-3 transition-colors"
              >
                <Package size={13} />
                {showItems ? 'Ocultar desglose de ítems' : 'Agregar desglose de ítems (líneas de factura)'}
                {showItems ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
              </button>

              {/* Items desglose */}
              {showItems && (
                <div className="border border-yellow-100 rounded-xl p-3 mb-3 bg-yellow-50/30">
                  <div className="grid grid-cols-12 gap-1 text-[10px] font-semibold text-gray-400 uppercase px-1 mb-1">
                    <span className="col-span-4">Descripción</span><span className="col-span-1 text-right">Cant.</span>
                    <span className="col-span-2 text-right">P. Unit.</span><span className="col-span-1 text-right">IVA%</span>
                    <span className="col-span-2 text-right">Subtotal</span><span className="col-span-1 text-right">Total</span><span className="col-span-1"/>
                  </div>
                  {newItems.map((it, idx) => (
                    <ItemRow key={idx} item={it} taxRate={taxRate} currencySymbol={currencySymbol}
                      onChange={updated => setNewItems(prev => prev.map((x, i) => i === idx ? updated : x))}
                      onRemove={() => setNewItems(prev => prev.filter((_, i) => i !== idx))}
                    />
                  ))}
                  <button onClick={() => setNewItems(prev => [...prev, EMPTY_ITEM(taxRate)])}
                    className="mt-2 text-xs text-yellow-600 hover:text-yellow-800 flex items-center gap-1 font-medium">
                    <Plus size={12}/> Agregar línea
                  </button>
                  {newItems.length > 0 && (
                    <div className="mt-3 pt-2 border-t border-yellow-200 text-right text-xs text-gray-600 space-y-0.5">
                      <div>Subtotal: <span className="font-mono font-semibold">{currencySymbol}{newItems.reduce((s,it)=>s+it.subtotal,0).toFixed(2)}</span></div>
                      <div>IVA ({taxRate}%): <span className="font-mono font-semibold text-yellow-700">{currencySymbol}{newItems.reduce((s,it)=>s+it.tax,0).toFixed(2)}</span></div>
                      <div className="text-base font-bold text-gray-800">Total: <span className="font-mono">{currencySymbol}{newItems.reduce((s,it)=>s+it.total,0).toFixed(2)}</span></div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowNewForm(false); setNewForm(EMPTY_FORM); setNewItems([]); setShowItems(false); }} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
                <button onClick={handleCreate} disabled={saving || !newForm.entity.trim()} className="px-5 py-2 bg-yellow-500 text-gray-900 font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-yellow-400 transition-colors">
                  {saving ? 'Guardando…' : 'Guardar Registro'}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="bg-white p-4 rounded-xl shadow-lg border border-gray-100 mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-gray-500">
            <Calendar size={18} />
            <span className="font-medium text-sm">Fecha:</span>
          </div>
          <input 
            type="date" 
            value={dateRange.start}
            onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
            className="px-3 py-1.5 bg-gray-50 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
          />
          <span className="text-gray-300">→</span>
          <input 
            type="date" 
            value={dateRange.end}
            onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
            className="px-3 py-1.5 bg-gray-50 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
          />

          <div className="h-6 w-px bg-gray-200 mx-2"></div>

          <div className="flex items-center gap-2 text-gray-500">
            <Filter size={18} />
            <span className="font-medium text-sm">Tipo:</span>
          </div>
          <select 
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            className="px-3 py-1.5 bg-gray-50 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
          >
            <option value="all">Todos</option>
            <option value="ingreso">Ingresos</option>
            <option value="egreso">Egresos</option>
          </select>

          <div className="h-6 w-px bg-gray-200 mx-2"></div>

          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input 
              type="text" 
              placeholder="Buscar por cliente, descripción, factura..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 bg-gray-50 border rounded-lg text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
            />
          </div>
        </div>

        {/* Floating Summary Bar */}
        {selectedIds.length > 0 && (
          <motion.div 
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-6 py-4 rounded-full shadow-2xl z-50 flex items-center gap-8 border border-gray-700 backdrop-blur-md bg-opacity-95"
          >
            <div className="flex items-center gap-3 border-r border-gray-700 pr-6">
              <span className="bg-yellow-500 text-black text-xs font-bold px-2 py-1 rounded-full">{selectedIds.length}</span>
              <span className="text-sm font-medium text-gray-300">Seleccionados</span>
            </div>
            
            <div className="flex gap-6 text-sm">
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">Subtotal</p>
                <p className="font-mono font-bold">{currencySymbol}{getSelectionMetrics().subtotal.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">IVA</p>
                <p className="font-mono font-bold text-yellow-400">{currencySymbol}{getSelectionMetrics().tax.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">Total</p>
                <p className="font-mono font-bold text-xl">{currencySymbol}{getSelectionMetrics().total.toFixed(2)}</p>
              </div>
            </div>

            <button 
              onClick={() => setSelectedIds([])}
              className="ml-2 p-1.5 hover:bg-gray-800 rounded-full text-gray-400 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </motion.div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <MetricCard title="Balance Total" amount={metrics.balanceTotal} icon={DollarSign} color={metrics.balanceTotal >= 0 ? "black" : "red"} currencySymbol={currencySymbol} />
          <MetricCard title="Ingresos" amount={metrics.totalIngresos} icon={TrendingUp} color="green" currencySymbol={currencySymbol} />
          <MetricCard title="Egresos" amount={metrics.totalEgresos} icon={TrendingDown} color="red" currencySymbol={currencySymbol} />
          <MetricCard title="Balance IVA" amount={metrics.totalIVA} icon={PieChart} color={metrics.totalIVA >= 0 ? "orange" : "blue"} currencySymbol={currencySymbol} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
            <h3 className="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
              <BarChart2 size={20} className="text-gray-400" /> Flujo de Caja
            </h3>
            <div className="h-64 cursor-default">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={graphData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} />
                  <YAxis axisLine={false} tickLine={false} />
                  <RechartsTooltip cursor={{fill: 'transparent'}} />
                  <Bar dataKey="value" radius={[10, 10, 0, 0]} barSize={60} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100 relative overflow-hidden">
            
            <h3 className="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
              <PieChart size={20} className="text-gray-400" /> Reporte Fiscal (SRI)
            </h3>
            
            <div className="space-y-6">
              <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                <div>
                  <p className="text-sm text-gray-500 font-medium">IVA Cobrado (Ventas)</p>
                  <p className="text-xs text-gray-400">Débito Fiscal</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-gray-800">{currencySymbol}{metrics.ivaIngresos.toFixed(2)}</p>
                </div>
              </div>

              <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                <div>
                  <p className="text-sm text-gray-500 font-medium">IVA Pagado (Compras)</p>
                  <p className="text-xs text-gray-400">Crédito Tributario</p>
                </div>
                <div className="text-right">
                   <p className="text-lg font-bold text-emerald-600">-{currencySymbol}{metrics.ivaEgresos.toFixed(2)}</p>
                </div>
              </div>

              <div className={`p-4 rounded-xl border ${metrics.totalIVA >= 0 ? 'bg-orange-50 border-orange-100' : 'bg-blue-50 border-blue-100'}`}>
                <div className="flex justify-between items-center mb-1">
                   <p className={`text-sm font-bold ${metrics.totalIVA >= 0 ? 'text-orange-700' : 'text-blue-700'}`}>
                     {metrics.totalIVA >= 0 ? 'IMPUESTO A PAGAR' : 'CRÉDITO A FAVOR'}
                   </p>
                   <p className={`text-2xl font-bold ${metrics.totalIVA >= 0 ? 'text-orange-700' : 'text-blue-700'}`}>
                     {currencySymbol}{Math.abs(metrics.totalIVA).toFixed(2)}
                   </p>
                </div>
                <p className="text-xs opacity-75 leading-tight">
                  {metrics.totalIVA >= 0 
                    ? 'Debes declarar y pagar este valor al SRI.' 
                    : 'Saldo a favor para descontar de impuestos futuros.'}
                </p>
              </div>

              <div className="text-[10px] text-gray-400 bg-gray-50 p-3 rounded-lg leading-relaxed">
                ℹ️ <strong>Nota SRI (Ecuador):</strong> El crédito tributario aplica solo si las compras están vinculadas a ventas gravadas con tarifa 15%. 
                Si tus ventas son 0% (servicios médicos puros), el IVA de compras debe registrarse como "Gasto Deducible" en lugar de crédito.
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-md overflow-hidden border border-gray-100">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-6 py-4 w-10">
                    <input 
                      type="checkbox" 
                      onChange={selectAll}
                      checked={selectedIds.length === filteredRecords.length && filteredRecords.length > 0}
                      className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-500 w-4 h-4 cursor-pointer"
                    />
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Fecha</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Factura</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Entidad / Detalle</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Tipo</th>
                  {/* Columna "Por" solo cuando se ven varios usuarios o global */}
                  {(selectedUsers.size !== 1 && (user?.role === 'clinic_admin' || user?.role === 'master_admin')) && (
                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Por</th>
                  )}
                  <th className="px-6 py-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Subtotal</th>
                  <th className="px-6 py-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">IVA</th>
                  <th className="px-6 py-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Total</th>
                  <th className="px-6 py-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-gray-500">
                      <div className="animate-spin w-6 h-6 border-2 border-yellow-500 border-t-transparent rounded-full mx-auto mb-2"></div>
                      Cargando registros...
                    </td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-gray-500">
                      No hay registros para este filtro.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((record) => (
                    <tr key={record.id} className={`hover:bg-gray-50 transition-colors group ${selectedIds.includes(record.id) ? 'bg-yellow-50/50' : ''}`}>
                      <td className="px-6 py-4 text-center">
                        <input 
                          type="checkbox" 
                          checked={selectedIds.includes(record.id)}
                          onChange={() => toggleSelection(record.id)}
                          className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-500 w-4 h-4 cursor-pointer"
                        />
                      </td>
                      {editingId === record.id ? (
                        <EditRow 
                          data={editFormData} 
                          onChange={handleEditChange} 
                          onSave={saveEdit} 
                          onCancel={cancelEdit} 
                        />
                      ) : (
                        <>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {new Date(record.date).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            <div className="flex items-center gap-2">
                              <FileText size={14} className="text-gray-400" />
                              {record.invoice_number || 'S/N'}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600 max-w-xs group-hover:bg-white transition-colors relative">
                             <div className="font-semibold text-gray-800 truncate">{record.entity}</div>
                             <div className="text-xs text-gray-400 truncate">{record.description}</div>
                             
                             {/* Asesoría fiscal SRI — solo si hay descripción */}
                             {record.type === 'egreso' && record.description && (
                                <div className="mt-0.5">
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-50 text-gray-400 border border-gray-100">
                                    <Info size={9} className="mr-1" /> Egreso
                                  </span>
                                </div>
                             )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                              record.type === 'ingreso' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {record.type === 'ingreso' ? 'Ingreso' : 'Egreso'}
                            </span>
                          </td>
                          {/* Columna "Por" — solo en vista global o multi-usuario */}
                          {(selectedUsers.size !== 1 && (user?.role === 'clinic_admin' || user?.role === 'master_admin')) && (
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-mono">
                                {record.registered_by || '—'}
                              </span>
                            </td>
                          )}
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                            {currencySymbol}{parseFloat(String(record.subtotal || 0)).toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                            {currencySymbol}{parseFloat(String(record.tax || 0)).toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-right text-gray-800">
                            {currencySymbol}{parseFloat(String(record.total || 0)).toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            <div className="flex justify-end gap-2">
                              <button 
                                onClick={() => openDesglose(record)}
                                className="p-1 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-50 rounded"
                                title="Ver / editar desglose de ítems"
                              >
                                <Package size={16} />
                              </button>
                              <button 
                                onClick={() => startEdit(record)}
                                className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                              >
                                <Edit2 size={16} />
                              </button>
                              <button 
                                onClick={() => handleDelete(record.id)}
                                className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {/* ── Modal: Desglose de ítems ── */}
      {desgModal.open && desgModal.record && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="h-0.5 bg-gradient-to-r from-yellow-500 to-yellow-300" />
            <div className="p-5 border-b flex justify-between items-start">
              <div>
                <h3 className="font-bold text-gray-900">Desglose de ítems</h3>
                <p className="text-xs text-gray-400 mt-0.5">{desgModal.record.entity} · {desgModal.record.invoice_number || 'S/N'} · {String(desgModal.record.date).split('T')[0]}</p>
              </div>
              <button onClick={() => setDesgModal({ open: false, record: null, items: [], loading: false, updateRecord: false })} className="text-gray-300 hover:text-gray-500"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              {desgModal.loading ? (
                <div className="flex justify-center py-8 text-gray-400 animate-spin"><FileText className="w-6 h-6" /></div>
              ) : (
                <>
                  <div className="grid grid-cols-12 gap-1 text-[10px] font-semibold text-gray-400 uppercase px-1 mb-1">
                    <span className="col-span-4">Descripción</span><span className="col-span-1 text-right">Cant.</span>
                    <span className="col-span-2 text-right">P. Unit.</span><span className="col-span-1 text-right">IVA%</span>
                    <span className="col-span-2 text-right">Subtotal</span><span className="col-span-1 text-right">Total</span><span className="col-span-1"/>
                  </div>
                  <div className="space-y-1">
                    {desgModal.items.map((it, idx) => (
                      <ItemRow key={idx} item={it} taxRate={taxRate} currencySymbol={currencySymbol}
                        onChange={updated => setDesgModal(prev => ({ ...prev, items: prev.items.map((x,i) => i===idx ? updated : x) }))}
                        onRemove={() => setDesgModal(prev => ({ ...prev, items: prev.items.filter((_,i) => i!==idx) }))}
                      />
                    ))}
                  </div>
                  <button onClick={() => setDesgModal(prev => ({ ...prev, items: [...prev.items, EMPTY_ITEM(taxRate)] }))}
                    className="mt-3 text-xs text-yellow-600 hover:text-yellow-800 flex items-center gap-1 font-medium">
                    <Plus size={12}/> Agregar línea
                  </button>
                  {desgModal.items.length > 0 && (() => {
                    const iSub = desgModal.items.reduce((s,it)=>s+(it.subtotal||0),0);
                    const iTax = desgModal.items.reduce((s,it)=>s+(it.tax||0),0);
                    const iTot = parseFloat(desgModal.items.reduce((s,it)=>s+(it.total||0),0).toFixed(2));
                    const recTot = parseFloat(String(desgModal.record?.total || 0));
                    const diff = parseFloat((iTot - recTot).toFixed(2));
                    const matches = Math.abs(diff) < 0.02;
                    return (
                      <div className="mt-4 pt-3 border-t space-y-2">
                        <div className="flex justify-between items-center text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                          <span className="text-gray-500">Total del registro:</span>
                          <span className="font-mono font-semibold text-gray-700">{currencySymbol}{recTot.toFixed(2)}</span>
                        </div>
                        <div className="text-right text-xs text-gray-600 space-y-0.5">
                          <div>Subtotal desglose: <span className="font-mono font-semibold">{currencySymbol}{iSub.toFixed(2)}</span></div>
                          <div>IVA desglose: <span className="font-mono font-semibold text-yellow-700">{currencySymbol}{iTax.toFixed(2)}</span></div>
                          <div className={`text-base font-bold ${matches ? 'text-green-700' : 'text-red-600'}`}>
                            Total desglose: <span className="font-mono">{currencySymbol}{iTot.toFixed(2)}</span>
                            {matches && <span className="ml-2 text-xs font-normal text-green-600">✓ Coincide</span>}
                          </div>
                        </div>
                        {!matches && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                            <p className="text-amber-800 font-medium">
                              Diferencia de <strong>{currencySymbol}{diff > 0 ? '+' : ''}{diff.toFixed(2)}</strong> con el registro general.
                            </p>
                            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={desgModal.updateRecord}
                                onChange={e => setDesgModal(prev => ({ ...prev, updateRecord: e.target.checked }))}
                                className="rounded border-amber-400 accent-yellow-500"
                              />
                              <span className="text-amber-700 font-medium">Actualizar el registro general con los valores del desglose</span>
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
            <div className="p-5 border-t flex justify-end gap-3">
              <button onClick={() => setDesgModal({ open: false, record: null, items: [], loading: false, updateRecord: false })} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={saveDesglose} disabled={saving} className="px-5 py-2 bg-yellow-500 text-gray-900 font-semibold rounded-lg text-sm disabled:opacity-50 hover:bg-yellow-400">
                {saving ? 'Guardando…' : 'Guardar desglose'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface MetricCardProps {
  title: string;
  amount: number;
  icon: any;
  color: 'blue' | 'green' | 'red' | 'orange' | 'black';
  currencySymbol?: string;
}

const MetricCard = ({ title, amount, icon: Icon, color, currencySymbol = '$' }: MetricCardProps) => {
  const colorStyles: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50 border-blue-100",
    green: "text-emerald-600 bg-emerald-50 border-emerald-100",
    red: "text-rose-600 bg-rose-50 border-rose-100",
    orange: "text-orange-600 bg-orange-50 border-orange-100",
    black: "text-gray-800 bg-gray-50 border-gray-200"
  };

  return (
    <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className={`p-6 rounded-2xl border ${colorStyles[color].replace('text-', 'border-')} bg-white shadow-sm`}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
          <h3 className="text-2xl font-bold text-gray-900">{currencySymbol}{amount.toFixed(2)}</h3>
        </div>
        <div className={`p-3 rounded-xl ${colorStyles[color]}`}>
          <Icon size={20} />
        </div>
      </div>
    </motion.div>
  );
};

interface EditRowProps {
  data: Partial<FinanceRecord>;
  onChange: (field: keyof FinanceRecord, value: any) => void;
  onSave: () => void;
  onCancel: () => void;
}

const EditRow = ({ data, onChange, onSave, onCancel }: EditRowProps) => {
  return (
    <>
      <td className="px-4 py-2"><input type="date" value={data.date?.split('T')[0]} onChange={e => onChange('date', e.target.value)} className="w-full text-xs p-1 border rounded" /></td>
      <td className="px-4 py-2"><input type="text" value={data.invoice_number} onChange={e => onChange('invoice_number', e.target.value)} className="w-full text-xs p-1 border rounded" /></td>
      <td className="px-4 py-2">
        <input type="text" value={data.entity} onChange={e => onChange('entity', e.target.value)} className="w-full text-xs p-1 border rounded mb-1" placeholder="Entidad" />
        <input type="text" value={data.description} onChange={e => onChange('description', e.target.value)} className="w-full text-xs p-1 border rounded" placeholder="Desc" />
      </td>
      <td className="px-4 py-2">
        <select value={data.type} onChange={e => onChange('type', e.target.value)} className="text-xs p-1 border rounded">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
        </select>
      </td>
      <td className="px-4 py-2"><input type="number" value={data.subtotal} onChange={e => onChange('subtotal', e.target.value)} className="w-20 text-xs p-1 border rounded text-right" step="0.01"/></td>
      <td className="px-4 py-2"><input type="number" value={data.tax} onChange={e => onChange('tax', e.target.value)} className="w-20 text-xs p-1 border rounded text-right" step="0.01"/></td>
      <td className="px-4 py-2"><input type="number" value={data.total} onChange={e => onChange('total', e.target.value)} className="w-20 text-xs p-1 border rounded text-right font-bold" step="0.01"/></td>
      <td className="px-4 py-2 text-right">
        <div className="flex justify-end gap-1">
          <button onClick={onSave} className="p-1 bg-green-100 text-green-700 rounded hover:bg-green-200"><Check size={14}/></button>
          <button onClick={onCancel} className="p-1 bg-red-100 text-red-700 rounded hover:bg-red-200"><X size={14}/></button>
        </div>
      </td>
    </>
  );
};

// ── Componente ItemRow — fila editable de ítem de factura ────────────────────
interface ItemRowProps {
  item: FinanceItem;
  taxRate: number;
  currencySymbol?: string;
  onChange: (updated: FinanceItem) => void;
  onRemove: () => void;
}
const ItemRow = ({ item, taxRate, currencySymbol = '$', onChange, onRemove }: ItemRowProps) => {
  const [ivaEditing, setIvaEditing] = useState(false);
  const update = (field: keyof FinanceItem, value: string) => {
    const partial = { ...item, [field]: parseAmount(value) };
    const qty     = field === 'quantity'   ? (parseAmount(value) || 1) : item.quantity;
    const uprice  = field === 'unit_price' ? (parseAmount(value) || 0) : item.unit_price;
    const ivaRate = field === 'iva_rate'   ? (parseAmount(value) || 0) : item.iva_rate;
    const subtotal = parseFloat((qty * uprice).toFixed(2));
    const tax      = parseFloat((subtotal * ivaRate / 100).toFixed(2));
    onChange({ ...partial, quantity: qty, unit_price: uprice, iva_rate: ivaRate, subtotal, tax, total: parseFloat((subtotal+tax).toFixed(2)) });
  };
  // ponytail: back-calculates subtotal+IVA from total; unit_price synced so qty*price=subtotal
  const updateFromTotal = (value: string) => {
    const total = parseAmount(value);
    const { subtotal, tax } = calcFromTotal(total, item.iva_rate);
    const qty = item.quantity || 1;
    onChange({ ...item, total, subtotal, tax, unit_price: parseFloat((subtotal / qty).toFixed(4)) });
  };
  const isDefaultIva = item.iva_rate === taxRate;
  const cls = "px-2 py-1.5 border rounded-lg text-xs focus:ring-1 focus:ring-yellow-400 outline-none w-full";
  return (
    <div className="grid grid-cols-12 gap-1 items-center">
      <input value={item.description} onChange={e => onChange({ ...item, description: e.target.value })} placeholder="Descripción del ítem" className={`col-span-4 ${cls}`} />
      <input type="text" inputMode="decimal" value={item.quantity}   onChange={e => update('quantity', e.target.value)}   className={`col-span-1 text-right ${cls}`} />
      <input type="text" inputMode="decimal" value={item.unit_price} onChange={e => update('unit_price', e.target.value)} className={`col-span-2 text-right ${cls}`} />
      {/* IVA% — gris cuando es el default, editable al click */}
      {!ivaEditing ? (
        <div className={`col-span-1 flex items-center justify-between px-2 py-1.5 rounded-lg border cursor-pointer group ${isDefaultIva ? 'bg-gray-50 border-gray-200' : 'bg-yellow-50 border-yellow-300'}`}
          onClick={() => setIvaEditing(true)} title="Click para editar IVA">
          <span className={`text-xs font-mono ${isDefaultIva ? 'text-gray-400' : 'text-yellow-700 font-semibold'}`}>{item.iva_rate}%</span>
          <Edit2 size={9} className="text-gray-300 group-hover:text-yellow-500 flex-shrink-0 ml-0.5" />
        </div>
      ) : (
        <input type="number" autoFocus value={item.iva_rate}
          onChange={e => update('iva_rate', e.target.value)}
          onBlur={() => setIvaEditing(false)}
          onKeyDown={e => { if (e.key === 'Enter') setIvaEditing(false); if (e.key === 'Escape') { update('iva_rate', String(taxRate)); setIvaEditing(false); }}}
          step="0.5" min="0" max="100"
          className={`col-span-1 text-right ${cls} border-yellow-400`}
        />
      )}
      <span className="col-span-2 text-right text-xs font-mono text-gray-500 pr-1">{currencySymbol}{item.subtotal.toFixed(2)}</span>
      <input
        type="text"
        inputMode="decimal"
        value={item.total.toFixed(2)}
        onChange={e => updateFromTotal(e.target.value)}
        title="Ingrese el total para calcular subtotal e IVA automáticamente"
        className={`col-span-1 text-right ${cls} font-bold bg-yellow-50 border-yellow-200 focus:border-yellow-400`}
      />
      <button onClick={onRemove} className="col-span-1 text-red-300 hover:text-red-500 flex justify-center"><X size={14}/></button>
    </div>
  );
};

export default AdminFinance;
