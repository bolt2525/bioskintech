import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Database, Download, RefreshCw, Loader2, Users, FileText,
  Stethoscope, DollarSign, Package, Check, AlertCircle, Info,
  ClipboardList, Upload, FileJson,
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';

interface StatEntry {
  label: string;
  count: number;
  exists: boolean;
}

interface StatsData {
  stats: Record<string, StatEntry>;
  totalRecords: number;
  clinic_id: string | number;
  is_master: boolean;
}

const authFetch = (url: string, opts?: RequestInit) =>
  fetch(url, {
    ...opts,
    headers: {
      ...opts?.headers,
      Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}`,
    },
  });

// ── Grupos de módulos para el backup ─────────────────────────────────────────
const MODULE_GROUPS = [
  {
    id: 'patients',
    label: 'Pacientes y Fichas Clínicas',
    icon: Users,
    color: 'text-[#deb887]',
    bg: 'bg-[#deb887]/10',
    description: 'Pacientes, expedientes, diagnósticos, tratamientos, recetas, exámenes físicos, consentimientos',
    statKeys: ['patients', 'clinical_records', 'diagnoses', 'treatments', 'prescriptions', 'physical_exams', 'injectables', 'consent_forms', 'medical_history'],
  },
  {
    id: 'finance',
    label: 'Finanzas',
    icon: DollarSign,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
    description: 'Registros de ingresos y egresos',
    statKeys: ['finance'],
  },
  {
    id: 'inventory',
    label: 'Inventario',
    icon: Package,
    color: 'text-cyan-600',
    bg: 'bg-cyan-50',
    description: 'Ítems de inventario, lotes y vencimientos',
    statKeys: ['inventory_items', 'inventory_batches'],
  },
];

// ── Componente principal ──────────────────────────────────────────────────────
export default function AdminBackup() {
  const { user } = useAuth();
  const isClinicAdmin = user?.role === 'clinic_admin' || user?.role === 'master_admin';

  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [selectedModules, setSelectedModules] = useState<Set<string>>(new Set(['patients']));
  const [downloading, setDownloading] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(
    () => localStorage.getItem('bioskin_last_backup') || null
  );
  const [downloadDone, setDownloadDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Estado importación
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<{ modules: string[]; metadata: any } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    setError(null);
    try {
      const res = await authFetch('/api/backup?action=stats');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: StatsData = await res.json();
      setStats(data);
    } catch (e: any) {
      setError(e.message || 'Error al cargar estadísticas');
    } finally {
      setLoadingStats(false);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const toggleModule = (id: string) => {
    setSelectedModules(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDownload = async () => {
    if (selectedModules.size === 0) {
      setError('Selecciona al menos un módulo para el respaldo.');
      return;
    }
    setDownloading(true);
    setError(null);
    try {
      const modulesParam = Array.from(selectedModules).join(',');
      const res = await authFetch(`/api/backup?action=backup&modules=${modulesParam}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Error ${res.status}`);
      }

      // Descargar el JSON como archivo
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().split('T')[0];
      a.href = url;
      a.download = `bioskintech-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Guardar timestamp del último backup
      const ts = new Date().toLocaleString('es-EC');
      localStorage.setItem('bioskin_last_backup', ts);
      setLastBackup(ts);
      setDownloadDone(true);
      setTimeout(() => setDownloadDone(false), 4000);
    } catch (e: any) {
      setError(e.message || 'Error al descargar el respaldo');
    } finally {
      setDownloading(false);
    }
  };

  const getStatForGroup = (group: typeof MODULE_GROUPS[0]): number => {
    if (!stats) return 0;
    return group.statKeys.reduce((sum, key) => sum + (stats.stats[key]?.count || 0), 0);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data?.metadata && data?.modules) {
          setImportPreview({ modules: Object.keys(data.modules), metadata: data.metadata });
        } else {
          setImportPreview(null);
          setError('El archivo no es un backup válido de BioSkinTech');
        }
      } catch { setError('El archivo no es un JSON válido'); }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setError(null);
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);
      const res = await authFetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al importar');
      const counts = Object.entries(result.imported || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      setImportResult(`Importación completada — ${counts}`);
      setImportFile(null);
      setImportPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadStats();
    } catch (e: any) {
      setError(e.message || 'Error durante la importación');
    } finally {
      setImporting(false);
    }
  };

  return (
    <AdminLayout>
      <div className="p-4 md:p-8 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl shadow-lg">
              <Database className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Base de Datos</h1>
              <p className="text-sm text-gray-400">Estadísticas y respaldo de datos</p>
            </div>
          </div>
          <button onClick={loadStats} disabled={loadingStats}
            className="p-2 hover:bg-gray-100 rounded-xl border border-gray-200 transition-colors disabled:opacity-50">
            {loadingStats ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
          </button>
        </div>

        {/* Tabs */}
        {isClinicAdmin && (
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
            {[
              { id: 'export', label: 'Exportar', icon: Download },
              { id: 'import', label: 'Importar', icon: Upload },
            ].map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id as any)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === t.id ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
                <t.icon className="w-4 h-4" />{t.label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm flex gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}
          </div>
        )}

        {importResult && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-sm flex gap-2">
            <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />{importResult}
          </div>
        )}

        {/* Tab Exportar */}
        {(activeTab === 'export' || !isClinicAdmin) && (
          <>
        {/* Estadísticas globales */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
            {[
              { label: 'Pacientes', key: 'patients', icon: Users, color: 'text-[#deb887]', bg: 'bg-[#deb887]/10' },
              { label: 'Expedientes', key: 'clinical_records', icon: ClipboardList, color: 'text-indigo-600', bg: 'bg-indigo-50' },
              { label: 'Tratamientos', key: 'treatments', icon: Stethoscope, color: 'text-teal-600', bg: 'bg-teal-50' },
              { label: 'Diagnósticos', key: 'diagnoses', icon: FileText, color: 'text-purple-600', bg: 'bg-purple-50' },
              { label: 'Finanzas', key: 'finance', icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-50' },
              { label: 'Inventario', key: 'inventory_items', icon: Package, color: 'text-cyan-600', bg: 'bg-cyan-50' },
            ].map(({ label, key, icon: Icon, color, bg }) => (
              <div key={key} className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`p-1.5 rounded-lg ${bg}`}>
                    <Icon className={`w-4 h-4 ${color}`} />
                  </div>
                  <span className="text-xs text-gray-500">{label}</span>
                </div>
                <p className="text-2xl font-bold text-gray-900">
                  {loadingStats ? '—' : (stats.stats[key]?.count ?? 0).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Información de la clínica */}
        {stats && (
          <div className="mb-6 bg-blue-50 border border-blue-100 rounded-2xl p-4 flex items-start gap-3">
            <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              <span className="font-semibold">
                {stats.is_master ? 'Vista master' : `Clínica ID: ${stats.clinic_id}`}
              </span>
              {' — '}Total de registros en base de datos: <strong>{stats.totalRecords.toLocaleString()}</strong>
              {lastBackup && <span className="block text-blue-600 mt-1">Último respaldo: {lastBackup}</span>}
            </div>
          </div>
        )}

        {/* Selección de módulos */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden mb-6">
          <div className="p-4 bg-gray-50 border-b border-gray-200">
            <h2 className="font-semibold text-gray-700">Seleccionar módulos para respaldar</h2>
            <p className="text-xs text-gray-400 mt-1">El respaldo se descargará como archivo JSON</p>
          </div>
          <div className="divide-y divide-gray-100">
            {MODULE_GROUPS.map(group => {
              const groupCount = getStatForGroup(group);
              const selected = selectedModules.has(group.id);
              return (
                <label key={group.id} className="flex items-start gap-4 p-4 cursor-pointer hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3 flex-1">
                    <div
                      onClick={() => toggleModule(group.id)}
                      className={`w-5 h-5 rounded flex items-center justify-center border-2 flex-shrink-0 mt-0.5 transition-colors cursor-pointer ${
                        selected ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300 bg-white'
                      }`}
                    >
                      {selected && <Check className="w-3 h-3 text-white" />}
                    </div>
                    <div className={`p-2 rounded-xl ${group.bg}`}>
                      <group.icon className={`w-4 h-4 ${group.color}`} />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-800 text-sm">{group.label}</p>
                      <p className="text-xs text-gray-400 leading-relaxed">{group.description}</p>
                    </div>
                  </div>
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full font-medium flex-shrink-0 mt-0.5">
                    {loadingStats ? '—' : groupCount.toLocaleString()} registros
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Botón de descarga */}
        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          onClick={handleDownload}
          disabled={downloading || selectedModules.size === 0}
          className={`w-full py-4 rounded-2xl font-semibold flex items-center justify-center gap-3 shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            downloadDone
              ? 'bg-emerald-500 text-white'
              : 'bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white hover:shadow-lg'
          }`}
        >
          {downloading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Generando respaldo...
            </>
          ) : downloadDone ? (
            <>
              <Check className="w-5 h-5" />
              Respaldo descargado correctamente
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              Descargar respaldo JSON
            </>
          )}
        </motion.button>

        <p className="mt-3 text-xs text-gray-400 text-center">
          El archivo se descargará con la fecha actual. Guárdalo en un lugar seguro.
        </p>
        <p className="mt-1 text-xs text-gray-300 text-center">
          Nota: Las imágenes almacenadas en la nube no se incluyen en el archivo JSON (solo sus referencias URL).
        </p>
          </>
        )}

        {/* Tab Importar */}
        {activeTab === 'import' && isClinicAdmin && (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">
                La importación agrega los registros que no existen (por ID). Los registros existentes no se sobreescriben.
                Solo funciona con backups generados por este mismo sistema.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 bg-gray-50 border-b border-gray-200">
                <h2 className="font-semibold text-gray-700">Seleccionar archivo de backup</h2>
                <p className="text-xs text-gray-400 mt-1">Formato JSON (.json) — exportado desde este panel</p>
              </div>
              <div className="p-4">
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-[#deb887] hover:bg-[#deb887]/5 transition-colors">
                  <FileJson className="w-8 h-8 text-gray-300 mb-2" />
                  <span className="text-sm text-gray-500">{importFile ? importFile.name : 'Clic para seleccionar archivo .json'}</span>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
                </label>

                {importPreview && (
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-xl">
                    <p className="text-xs font-semibold text-blue-800 mb-1">Contenido detectado:</p>
                    <p className="text-xs text-blue-700">Módulos: {importPreview.modules.join(', ')}</p>
                    <p className="text-xs text-blue-600 mt-0.5">Generado: {importPreview.metadata.timestamp?.split('T')[0]} por {importPreview.metadata.generated_by}</p>
                  </div>
                )}
              </div>
            </div>

            <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
              onClick={handleImport} disabled={importing || !importFile || !importPreview}
              className="w-full py-4 rounded-2xl font-semibold flex items-center justify-center gap-3 shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-blue-500 to-blue-700 text-white hover:shadow-lg">
              {importing ? <><Loader2 className="w-5 h-5 animate-spin" />Importando...</> : <><Upload className="w-5 h-5" />Importar datos</>}
            </motion.button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
