import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Database, Download, RefreshCw, Loader2, Users, Stethoscope, DollarSign, Package, Check, AlertCircle, Info,
  ClipboardList, Upload, FileJson, FileSpreadsheet, Cloud, ShieldCheck, History, FileSignature, Settings, MessageCircle, XCircle,
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';

type Stat = { label: string; count: number; exists: boolean };
type StatsData = { stats: Record<string, Stat>; totalRecords: number; clinic_id: string; is_master: boolean; encryption_ready: boolean };
type Snapshot = { key: string; kind: string; size: number; created_at: string };
type RestoreInfo = { signature: 'valid' | 'invalid' | 'unsigned'; sameClinic: boolean; timestamp: string | null; ageDays: number | null; modules: string[]; legacy: boolean };
type RestoreReport = { inserted: Record<string, number>; existing: Record<string, number>; errors: { table: string; id: number | null; error: string }[]; errorCount: number; committed: boolean };
type RestoreResult = { info: RestoreInfo; confirmations: string[]; report: RestoreReport; preRestoreSnapshot: string | null };
type PatientReport = { valid: number; created: number; duplicates: { line: number; reason: string }[]; errors: { line: number; error: string }[]; committed: boolean };

const MAX_UPLOAD_MB = 50;
const TEMPLATE_HEADERS = ['nombres', 'apellidos', 'tipo_identificacion', 'numero_identificacion', 'email', 'telefono', 'fecha_nacimiento', 'genero', 'estado_civil', 'tipo_sangre', 'ocupacion', 'direccion'];
const REQUIRED_HEADERS = TEMPLATE_HEADERS.slice(0, 4);

const TABLE_LABELS: Record<string, string> = {
  patients: 'Pacientes', clinical_records: 'Expedientes', consultations: 'Consultas', medical_history: 'Antecedentes',
  consultation_info: 'Motivo de consulta', consultation_history: 'Historial de consulta', physical_exams: 'Exámenes físicos',
  diagnoses: 'Diagnósticos', treatments: 'Tratamientos', injectables: 'Inyectables', prescriptions: 'Recetas',
  consent_forms: 'Consentimientos', medical_history_snapshots: 'Versiones de antecedentes', clinical_photos: 'Referencias de fotos',
  patient_audit_log: 'Auditoría', financial_records: 'Finanzas', external_finance_records: 'Finanzas (legacy)',
  financial_items: 'Partidas', inventory_groups: 'Subcategorías', inventory_items: 'Productos', inventory_batches: 'Lotes', inventory_movements: 'Movimientos',
};

const MODULES = [
  { id: 'patients', label: 'Pacientes y Fichas Clínicas', icon: Users, restorable: true, statKeys: ['patients', 'clinical_records', 'consultations', 'medical_history', 'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms', 'medical_history_snapshots', 'patient_audit_log', 'clinical_photos'],
    description: 'Pacientes, expedientes, consultas, antecedentes y sus versiones, examen físico con marcaciones 2D/3D, diagnósticos, tratamientos, inyectables, recetas, consentimientos firmados, auditoría y referencias de fotos' },
  { id: 'finance', label: 'Finanzas', icon: DollarSign, restorable: true, statKeys: ['finance', 'financial_items'], description: 'Ingresos, egresos y partidas de facturas' },
  { id: 'inventory', label: 'Inventario', icon: Package, restorable: true, statKeys: ['inventory_items', 'inventory_batches', 'inventory_movements', 'inventory_groups'], description: 'Productos, subcategorías, lotes, vencimientos y movimientos' },
  { id: 'config', label: 'Configuración de la clínica', icon: Settings, restorable: false, statKeys: [], description: 'Datos de la clínica, ajustes, módulos, usuarios (sin contraseñas), recursos de agenda y asignaciones — solo referencia' },
  { id: 'communications', label: 'Comunicaciones WhatsApp', icon: MessageCircle, restorable: false, statKeys: [], description: 'Contactos y mensajes de recordatorios — solo referencia' },
];

const authHeaders = (json = false): HeadersInit => ({
  Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { headers: authHeaders() } : { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data });
  return data as T;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadGzipAsJson(url: string, filename: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar el archivo generado');
  const json = await new Response((await res.blob()).stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  saveBlob(new Blob([json], { type: 'application/json' }), filename.replace(/\.gz$/, ''));
}

function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const head = src.split(/\r?\n/, 1)[0];
  const delimiter = (head.match(/;/g)?.length || 0) > (head.match(/,/g)?.length || 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

const normalizeHeader = (h: string) => h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, '_');
const fmtSize = (bytes: number) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const KIND_LABEL: Record<string, string> = { auto: 'Automático diario', manual: 'Manual', 'pre-restore': 'Antes de restaurar' };

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden mb-6">
      <div className="p-4 bg-gray-50 border-b border-gray-200">
        <h2 className="font-semibold text-gray-800">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Confirm({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 accent-gold" />
      <span>{children}</span>
    </label>
  );
}

export default function AdminBackup() {
  const { user } = useAuth();
  const canManage = user?.role === 'clinic_admin' || user?.role === 'master_admin';
  const [tab, setTab] = useState<'export' | 'import' | 'cloud'>('export');
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(['patients', 'finance', 'inventory']));
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);

  const [importMode, setImportMode] = useState<'restore' | 'patients'>('restore');
  const [restoreTarget, setRestoreTarget] = useState<{ source: 'upload' | 'snapshot'; key: string; label: string } | null>(null);
  const [restore, setRestore] = useState<RestoreResult | null>(null);
  const [confirm, setConfirm] = useState({ unsigned: false, foreign: false, partial: false, understood: false });
  const [patientRows, setPatientRows] = useState<Record<string, string>[] | null>(null);
  const [patientFile, setPatientFile] = useState('');
  const [patientReport, setPatientReport] = useState<PatientReport | null>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Ocurrió un error'); } finally { setBusy(null); }
  };

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    try { setStats(await api<StatsData>('/api/backup?action=stats')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Error al cargar estadísticas'); }
    finally { setLoadingStats(false); }
  }, []);

  const loadSnapshots = useCallback(async () => {
    try { setSnapshots((await api<{ snapshots: Snapshot[] }>('/api/backup?action=snapshots')).snapshots); }
    catch (e) { setSnapshots([]); setError(e instanceof Error ? e.message : 'No se pudo listar los respaldos en la nube'); }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { if (tab === 'cloud' && snapshots === null) loadSnapshots(); }, [tab, snapshots, loadSnapshots]);

  const count = (keys: string[]) => keys.reduce((sum, k) => sum + (stats?.stats[k]?.count || 0), 0);

  const exportJson = () => run('export', async () => {
    const { url, filename } = await api<{ url: string; filename: string }>('/api/backup?action=export', { modules: [...selected] });
    await downloadGzipAsJson(url, filename);
    setNotice('Respaldo descargado. Contiene datos sensibles de salud: guárdalo cifrado y fuera del computador de uso diario.');
  });

  const exportCsv = (dataset: string) => run(`csv-${dataset}`, async () => {
    const res = await fetch(`/api/backup?action=csv&dataset=${dataset}`, { headers: authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo generar el CSV');
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `${dataset}.csv`;
    saveBlob(await res.blob(), name);
  });

  const resetRestore = () => { setRestore(null); setRestoreTarget(null); setConfirm({ unsigned: false, foreign: false, partial: false, understood: false }); };

  const previewRestore = (target: { source: 'upload' | 'snapshot'; key: string; label: string }) => run('preview', async () => {
    setRestoreTarget(target); setRestore(null);
    setConfirm({ unsigned: false, foreign: false, partial: false, understood: false });
    setRestore(await api<RestoreResult>('/api/backup?action=restore', { source: target.source, key: target.key, dryRun: true }));
    setTab('import'); setImportMode('restore');
  });

  const onBackupFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(json|gz)$/i.test(file.name)) { setError('Selecciona un archivo .json o .json.gz exportado por BioSkinTech'); return; }
    if (file.size > MAX_UPLOAD_MB * 1048576) { setError(`El archivo supera ${MAX_UPLOAD_MB} MB`); return; }
    run('upload', async () => {
      const { key, url } = await api<{ key: string; url: string }>('/api/backup?action=uploadUrl', { size: file.size });
      const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!put.ok) throw new Error('No se pudo subir el archivo de forma segura');
      setRestoreTarget({ source: 'upload', key, label: file.name });
      setRestore(await api<RestoreResult>('/api/backup?action=restore', { source: 'upload', key, dryRun: true }));
    });
  };

  const needs = restore?.confirmations || [];
  const canCommit = !!restore && confirm.understood && (!needs.includes('unsigned') || confirm.unsigned) &&
    (!needs.includes('foreignClinic') || confirm.foreign) && (restore.report.errorCount === 0 || confirm.partial) &&
    Object.values(restore.report.inserted).some(Boolean);

  const commitRestore = () => restoreTarget && run('restore', async () => {
    const result = await api<RestoreResult>('/api/backup?action=restore', {
      source: restoreTarget.source, key: restoreTarget.key, dryRun: false,
      acceptUnsigned: confirm.unsigned, confirmForeignClinic: confirm.foreign, allowPartial: confirm.partial,
    });
    const total = Object.values(result.report.inserted).reduce((a, b) => a + b, 0);
    resetRestore();
    setNotice(`Restauración completada: ${total} registros agregados. Se creó un respaldo previo por seguridad (${result.preRestoreSnapshot ? 'disponible en la pestaña Nube' : 'no requerido'}).`);
    setSnapshots(null);
    loadStats();
  });

  const downloadTemplate = () => saveBlob(new Blob([`\uFEFF${TEMPLATE_HEADERS.join(',')}\r\n`], { type: 'text/csv' }), 'plantilla-pacientes-bioskintech.csv');

  const onPatientCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setPatientReport(null); setPatientRows(null);
    if (!file) return;
    if (file.size > 5 * 1048576) { setError('La plantilla supera 5 MB'); return; }
    run('csv-parse', async () => {
      const [header, ...rows] = parseCsv(await file.text());
      const headers = (header || []).map(normalizeHeader);
      const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
      if (missing.length) throw new Error(`Faltan columnas obligatorias: ${missing.join(', ')}. Usa la plantilla oficial.`);
      if (!rows.length) throw new Error('La plantilla no contiene pacientes');
      if (rows.length > 5000) throw new Error('Máximo 5000 pacientes por archivo');
      const mapped = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
      setPatientRows(mapped); setPatientFile(file.name);
      setPatientReport(await api<PatientReport>('/api/backup?action=importPatients', { rows: mapped, dryRun: true }));
    });
  };

  const commitPatients = () => patientRows && run('patients', async () => {
    const report = await api<PatientReport>('/api/backup?action=importPatients', { rows: patientRows, dryRun: false });
    setPatientReport(null); setPatientRows(null);
    setNotice(`${report.created} pacientes importados. Cada uno tiene su expediente creado y queda registrado en auditoría.`);
    loadStats();
  });

  const createSnapshot = () => run('snapshot', async () => {
    await api('/api/backup?action=snapshot', {});
    setNotice('Respaldo cifrado creado en la nube.');
    await loadSnapshots();
  });

  const downloadSnapshot = (s: Snapshot) => run(`dl-${s.key}`, async () => {
    const { url, filename } = await api<{ url: string; filename: string }>('/api/backup?action=export', { snapshotKey: s.key });
    await downloadGzipAsJson(url, filename);
  });

  if (!canManage) {
    return (
      <AdminLayout title="Base de Datos">
        <div className="max-w-xl mx-auto bg-white rounded-2xl p-6 text-sm text-gray-600">Solo el administrador de la clínica puede gestionar respaldos.</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Base de Datos">
      <div className="p-4 md:p-8 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl shadow-lg"><Database className="w-7 h-7 text-white" /></div>
            <div>
              <h1 className="text-2xl font-bold text-white">Base de Datos</h1>
              <p className="text-sm text-gray-400">Respaldos, exportación e importación</p>
            </div>
          </div>
          <button onClick={() => { loadStats(); if (tab === 'cloud') loadSnapshots(); }} disabled={loadingStats} aria-label="Actualizar"
            className="p-2 bg-white/10 hover:bg-white/20 rounded-xl border border-white/20 transition-colors disabled:opacity-50">
            {loadingStats ? <Loader2 className="w-4 h-4 animate-spin text-white" /> : <RefreshCw className="w-4 h-4 text-white" />}
          </button>
        </div>

        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
          {([['export', 'Exportar', Download], ['import', 'Importar', Upload], ['cloud', 'Nube', Cloud]] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all ${tab === id ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              <Icon className="w-4 h-4" />{label}
            </button>
          ))}
        </div>

        {error && <div role="alert" className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm flex gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}</div>}
        {notice && <div role="status" className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-sm flex gap-2"><Check className="w-4 h-4 flex-shrink-0 mt-0.5" />{notice}</div>}

        {tab === 'export' && (
          <>
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                {[
                  ['Pacientes', ['patients'], Users], ['Expedientes', ['clinical_records'], ClipboardList],
                  ['Tratamientos', ['treatments'], Stethoscope], ['Consentimientos', ['consent_forms'], FileSignature],
                  ['Finanzas', ['finance'], DollarSign], ['Inventario', ['inventory_items', 'inventory_batches'], Package],
                ].map(([label, keys, Icon]) => {
                  const I = Icon as typeof Users;
                  return (
                    <div key={label as string} className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
                      <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-gold/10"><I className="w-4 h-4 text-gold-dark" /></div><span className="text-xs text-gray-500">{label as string}</span></div>
                      <p className="text-2xl font-bold text-gray-900">{loadingStats ? '—' : count(keys as string[]).toLocaleString('es-EC')}</p>
                    </div>
                  );
                })}
              </div>
            )}

            <Card title="¿Qué incluye un respaldo?" subtitle="Léelo antes de depender de un archivo exportado">
              <ul className="text-xs text-gray-700 space-y-1.5">
                <li className="flex gap-2"><Check className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />Toda la información escrita de fichas, consentimientos (con firmas digitalizadas y huellas de integridad), recetas, finanzas e inventario.</li>
                <li className="flex gap-2"><Check className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />Marcaciones de mapas faciales/corporales y del mapeo 3D de inyectables (son datos, no imágenes).</li>
                <li className="flex gap-2"><XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" /><span><strong>Fotografías clínicas:</strong> no se descargan por su tamaño; solo su referencia. Permanecen en almacenamiento privado mientras existan en el sistema.</span></li>
                <li className="flex gap-2"><XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" /><span><strong>Agenda:</strong> vive en el Google Calendar de cada profesional.</span></li>
                <li className="flex gap-2"><XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" /><span><strong>Modelos 3D y plantillas:</strong> son parte del software, no de tus datos.</span></li>
                <li className="flex gap-2"><XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" /><span><strong>Contraseñas, tokens y códigos de firma remota:</strong> nunca se exportan.</span></li>
              </ul>
            </Card>

            <Card title="Respaldo completo (JSON)" subtitle="Formato oficial restaurable: conserva relaciones, historial y firma de integridad del sistema">
              <div className="divide-y divide-gray-100 -mx-4 -mt-4 mb-4">
                {MODULES.map(m => {
                  const on = selected.has(m.id);
                  return (
                    <label key={m.id} className="flex items-start gap-3 p-4 cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={on} className="mt-1 w-4 h-4 accent-gold"
                        onChange={() => setSelected(prev => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} />
                      <m.icon className="w-4 h-4 text-gold-dark mt-1 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="font-medium text-gray-800 text-sm">{m.label} {!m.restorable && <span className="ml-1 text-[10px] uppercase bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">solo consulta</span>}</p>
                        <p className="text-xs text-gray-500 leading-relaxed">{m.description}</p>
                      </div>
                      {m.statKeys.length > 0 && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full flex-shrink-0">{loadingStats ? '—' : count(m.statKeys).toLocaleString('es-EC')}</span>}
                    </label>
                  );
                })}
              </div>
              <button onClick={exportJson} disabled={!!busy || selected.size === 0}
                className="w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 bg-gold text-white hover:bg-gold-dark disabled:opacity-50">
                {busy === 'export' ? <><Loader2 className="w-5 h-5 animate-spin" />Generando respaldo...</> : <><FileJson className="w-5 h-5" />Descargar respaldo (.json)</>}
              </button>
            </Card>

            <Card title="Exportar para Excel / Google Sheets (CSV)" subtitle="Para consultar, filtrar o migrar a otro sistema. El CSV no es restaurable: pierde relaciones e historial.">
              <div className="grid grid-cols-2 gap-2">
                {[['patients', 'Pacientes'], ['treatments', 'Tratamientos'], ['finance', 'Finanzas'], ['inventory', 'Inventario']].map(([id, label]) => (
                  <button key={id} onClick={() => exportCsv(id)} disabled={!!busy}
                    className="py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:border-gold hover:bg-gold/5 flex items-center justify-center gap-2 disabled:opacity-50">
                    {busy === `csv-${id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 text-emerald-600" />}{label}
                  </button>
                ))}
              </div>
            </Card>
            <p className="text-xs text-gray-400 text-center">Los archivos descargados contienen datos sensibles de salud. Su custodia es responsabilidad de la clínica.</p>
          </>
        )}

        {tab === 'import' && (
          <>
            <div className="flex gap-2 mb-4">
              {([['restore', 'Restaurar respaldo'], ['patients', 'Importar pacientes (CSV)']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setImportMode(id)}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium border ${importMode === id ? 'bg-white text-gray-900 border-white' : 'text-gray-300 border-white/20 hover:bg-white/10'}`}>{label}</button>
              ))}
            </div>

            {importMode === 'restore' && (
              <>
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800 space-y-1">
                  <p className="font-semibold flex items-center gap-1.5"><Info className="w-4 h-4" />Cómo funciona la restauración</p>
                  <p>1. Primero se hace una <strong>simulación</strong>: no se modifica nada y ves exactamente qué se agregaría.</p>
                  <p>2. Solo se <strong>agregan registros que faltan</strong>. Nada existente se sobrescribe ni se borra, así un respaldo antiguo no revierte cambios recientes.</p>
                  <p>3. Antes de aplicar, el sistema guarda un respaldo automático del estado actual.</p>
                  <p>4. Cada referencia se valida contra tu clínica; archivos dañados, alterados o de otra clínica se rechazan o requieren confirmación explícita.</p>
                </div>
                {!restore && (
                  <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-2xl bg-white cursor-pointer hover:border-gold ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                    {busy === 'upload' || busy === 'preview' ? <Loader2 className="w-8 h-8 text-gold animate-spin mb-2" /> : <FileJson className="w-8 h-8 text-gray-300 mb-2" />}
                    <span className="text-sm text-gray-500">{busy === 'upload' ? 'Subiendo y analizando…' : `Selecciona un respaldo .json o .json.gz (máx. ${MAX_UPLOAD_MB} MB)`}</span>
                    <input ref={backupInput} type="file" accept=".json,.gz,application/json,application/gzip" className="hidden" onChange={onBackupFile} />
                  </label>
                )}
                {restore && restoreTarget && (
                  <Card title="Resultado de la simulación" subtitle={restoreTarget.label}>
                    <div className="grid grid-cols-2 gap-2 text-xs mb-4">
                      <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Generado:</span> {fmtDate(restore.info.timestamp)}{restore.info.ageDays != null && ` (${restore.info.ageDays} días)`}</div>
                      <div className={`p-2 rounded-lg ${restore.info.signature === 'valid' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                        {restore.info.signature === 'valid' ? 'Firma de integridad válida' : restore.info.signature === 'invalid' ? 'Firma inválida: el archivo fue modificado' : 'Sin firma de integridad'}
                      </div>
                      <div className={`p-2 rounded-lg col-span-2 ${restore.info.sameClinic ? 'bg-gray-50' : 'bg-red-50 text-red-700'}`}>{restore.info.sameClinic ? 'Pertenece a esta clínica' : 'Atención: el respaldo proviene de otra clínica'}</div>
                    </div>
                    {restore.info.ageDays != null && restore.info.ageDays > 30 && <p className="text-xs text-amber-700 mb-3">Este respaldo tiene más de 30 días. Solo se recuperarán registros que hoy no existen.</p>}
                    <table className="w-full text-xs mb-3">
                      <thead className="text-gray-500"><tr><th className="text-left py-1">Sección</th><th className="text-right">Nuevos</th><th className="text-right">Ya existen</th></tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {[...new Set([...Object.keys(restore.report.inserted), ...Object.keys(restore.report.existing)])].map(t => (
                          <tr key={t}><td className="py-1">{TABLE_LABELS[t] || t}</td><td className="text-right font-semibold text-emerald-700">{restore.report.inserted[t] || 0}</td><td className="text-right text-gray-500">{restore.report.existing[t] || 0}</td></tr>
                        ))}
                      </tbody>
                    </table>
                    {restore.report.errorCount > 0 && (
                      <div className="mb-3 p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-700 max-h-40 overflow-auto">
                        <p className="font-semibold mb-1">{restore.report.errorCount} filas no se pueden restaurar:</p>
                        {restore.report.errors.slice(0, 50).map((e, i) => <p key={i}>{TABLE_LABELS[e.table] || e.table} #{e.id ?? '?'}: {e.error}</p>)}
                      </div>
                    )}
                    {!Object.values(restore.report.inserted).some(Boolean) && <p className="text-xs text-gray-600 mb-3">No hay nada que restaurar: todos los registros válidos ya existen.</p>}
                    <div className="space-y-2 mb-4">
                      {needs.includes('unsigned') && <Confirm checked={confirm.unsigned} onChange={v => setConfirm(c => ({ ...c, unsigned: v }))}>Entiendo que el archivo no tiene una firma válida de este sistema y asumo la responsabilidad de su contenido.</Confirm>}
                      {needs.includes('foreignClinic') && <Confirm checked={confirm.foreign} onChange={v => setConfirm(c => ({ ...c, foreign: v }))}>Confirmo que quiero importar datos de otra clínica a esta clínica.</Confirm>}
                      {restore.report.errorCount > 0 && <Confirm checked={confirm.partial} onChange={v => setConfirm(c => ({ ...c, partial: v }))}>Restaurar solo las filas válidas y omitir las {restore.report.errorCount} con errores.</Confirm>}
                      <Confirm checked={confirm.understood} onChange={v => setConfirm(c => ({ ...c, understood: v }))}>Revisé la simulación y autorizo agregar estos registros.</Confirm>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={resetRestore} disabled={!!busy} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">Cancelar</button>
                      <button onClick={commitRestore} disabled={!canCommit || !!busy} className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
                        {busy === 'restore' && <Loader2 className="w-4 h-4 animate-spin" />}Restaurar ahora
                      </button>
                    </div>
                  </Card>
                )}
              </>
            )}

            {importMode === 'patients' && (
              <Card title="Importar pacientes desde plantilla" subtitle="Para migrar pacientes desde Excel u otro sistema">
                <ol className="text-xs text-gray-700 space-y-1 mb-4 list-decimal list-inside">
                  <li>Descarga la plantilla y llénala en Excel o Google Sheets (una fila por paciente).</li>
                  <li>Obligatorios: <strong>nombres, apellidos, tipo_identificacion</strong> (cedula o ruc) y <strong>numero_identificacion</strong>.</li>
                  <li>Formato de fecha: AAAA-MM-DD o DD/MM/AAAA. Género: Femenino, Masculino u Otro.</li>
                  <li>Guarda como CSV (UTF-8). Si Excel quita el cero inicial de la cédula, el sistema lo corrige.</li>
                  <li>Pacientes con identificación ya registrada se omiten; nunca se sobrescriben.</li>
                </ol>
                <div className="flex gap-2 mb-4">
                  <button onClick={downloadTemplate} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2"><Download className="w-4 h-4" />Plantilla CSV</button>
                  <button onClick={() => csvInput.current?.click()} disabled={!!busy} className="flex-1 py-2.5 rounded-xl bg-gold text-white text-sm font-semibold hover:bg-gold-dark flex items-center justify-center gap-2 disabled:opacity-50">
                    {busy === 'csv-parse' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}Seleccionar CSV
                  </button>
                  <input ref={csvInput} type="file" accept=".csv,text/csv" className="hidden" onChange={onPatientCsv} />
                </div>
                {patientReport && (
                  <div className="space-y-3 text-xs">
                    <p className="text-gray-700"><strong>{patientFile}</strong>: {patientReport.valid} listos para importar · {patientReport.duplicates.length} omitidos · {patientReport.errors.length} con errores</p>
                    {patientReport.errors.length > 0 && (
                      <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-red-700 max-h-40 overflow-auto">
                        <p className="font-semibold mb-1">Corrige estas filas y vuelve a cargar el archivo (no se importa nada mientras existan errores):</p>
                        {patientReport.errors.slice(0, 100).map(e => <p key={e.line}>Fila {e.line}: {e.error}</p>)}
                      </div>
                    )}
                    {patientReport.duplicates.length > 0 && (
                      <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-gray-600 max-h-32 overflow-auto">
                        {patientReport.duplicates.slice(0, 100).map(d => <p key={d.line}>Fila {d.line}: {d.reason}</p>)}
                      </div>
                    )}
                    <button onClick={commitPatients} disabled={!!busy || patientReport.errors.length > 0 || patientReport.valid === 0}
                      className="w-full py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
                      {busy === 'patients' && <Loader2 className="w-4 h-4 animate-spin" />}Importar {patientReport.valid} pacientes
                    </button>
                  </div>
                )}
              </Card>
            )}
          </>
        )}

        {tab === 'cloud' && (
          <>
            <Card title="Respaldo automático protegido" subtitle="Tu defensa ante borrados accidentales, ataques o ransomware">
              <ul className="text-xs text-gray-700 space-y-1.5 mb-4">
                <li className="flex gap-2"><ShieldCheck className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />Copia diaria automática de toda la clínica, cifrada con AES-256-GCM antes de salir del servidor.</li>
                <li className="flex gap-2"><ShieldCheck className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />Almacenada fuera de la base de datos, en Cloudflare R2, <strong>inmutable durante 30 días</strong>: ni siquiera un atacante con acceso a la aplicación puede borrarla o alterarla.</li>
                <li className="flex gap-2"><History className="w-3.5 h-3.5 text-blue-600 flex-shrink-0 mt-0.5" />Se eliminan automáticamente a los 35 días. Pérdida máxima ante un desastre: el último día.</li>
              </ul>
              {stats && !stats.encryption_ready && <p className="text-xs text-red-600 mb-3">El cifrado de respaldos no está configurado en el servidor. Contacta a soporte.</p>}
              <button onClick={createSnapshot} disabled={!!busy || (stats ? !stats.encryption_ready : false)}
                className="w-full py-3 rounded-xl bg-gold text-white font-semibold hover:bg-gold-dark disabled:opacity-50 flex items-center justify-center gap-2">
                {busy === 'snapshot' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Cloud className="w-5 h-5" />}Crear respaldo en la nube ahora
              </button>
            </Card>

            <Card title="Respaldos disponibles" subtitle="Descárgalos o restaura registros faltantes desde cualquiera de ellos">
              {snapshots === null && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Cargando…</p>}
              {snapshots?.length === 0 && <p className="text-sm text-gray-500">Aún no hay respaldos. El primero automático se genera esta noche.</p>}
              <div className="divide-y divide-gray-100 -mx-4">
                {snapshots?.map(s => (
                  <div key={s.key} className="flex items-center gap-3 px-4 py-3">
                    <Cloud className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800">{fmtDate(s.created_at)}</p>
                      <p className="text-xs text-gray-500">{KIND_LABEL[s.kind] || s.kind} · {fmtSize(s.size)}</p>
                    </div>
                    <button onClick={() => downloadSnapshot(s)} disabled={!!busy} title="Descargar" className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
                      {busy === `dl-${s.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4 text-gray-600" />}
                    </button>
                    <button onClick={() => previewRestore({ source: 'snapshot', key: s.key, label: `Nube · ${fmtDate(s.created_at)}` })} disabled={!!busy}
                      className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">Restaurar…</button>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
