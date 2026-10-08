import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Database, Download, RefreshCw, Loader2, Users, Stethoscope, DollarSign, Package, Check, AlertCircle, Info,
  ClipboardList, Upload, FileJson, FileSpreadsheet, Cloud, ShieldCheck, History, FileSignature, Settings, MessageCircle,
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';
import AnnualPhotoBackupPanel from '../components/admin/AnnualPhotoBackupPanel';
import { subscriptionAccess } from '../utils/subscriptionAccess';
import { Dialog } from '../components/ui/Dialog';
import recordsFetch from '../utils/recordsFetch';

type Stat = { label: string; count: number; exists: boolean };
type ManualBackup = { available: boolean; next_allowed_at: string | null; last_created_at: string | null; timezone: string; limit: number; state?: string; reason?: string | null };
type StatsData = { stats: Record<string, Stat>; totalRecords: number; clinic_id: string; is_master: boolean; encryption_ready: boolean; manual_backup?: ManualBackup | null };
type Snapshot = { key: string; kind: string; size: number; created_at: string; format?: string };
type RestoreInfo = { signature: 'valid' | 'invalid' | 'unsigned'; sameClinic: boolean; timestamp: string | null; ageDays: number | null; modules: string[]; legacy: boolean };
type RestoreReport = { inserted: Record<string, number>; existing: Record<string, number>; errors: { table: string; id: number | null; error: string }[]; errorCount: number; committed: boolean };
type RestoreResult = { info: RestoreInfo; confirmations: string[]; report: RestoreReport; preRestoreSnapshot: string | null };
type PatientReport = { valid: number; created: number; withHistory: number; examplesSkipped: number; duplicates: { line: number; reason: string }[]; errors: { line: number; error: string }[]; committed: boolean };
type TemplateColumn = { name: string; required: boolean; description: string; example: string };
type ConsentPatient = { id: number; first_name: string; last_name: string; identification: string | null; consents: number };
type ConsentPage = {
  url: string; filename: string; count: number; returnedCount: number;
  hasMore: boolean; nextOffset: number | null; revision: string;
};
type BatchSource = { file: File } | { snapshotKey: string };
type BatchManifestInfo = {
  signature: 'valid' | 'invalid' | 'unsigned'; sameClinic: boolean; timestamp: string | null;
  ageDays: number | null; modules: string[]; total_batches: number; counts: Record<string, number>;
};
type BatchReport = {
  inserted: Record<string, number>; existing: Record<string, number>; deferred: Record<string, number>;
  skipped: Record<string, number>; errors: { table: string; id: number | null; error: string }[];
  errorCount: number; deferredCount: number;
};
type BatchRestorePreview = {
  source: BatchSource; label: string; info: BatchManifestInfo; confirmations: string[];
  report: BatchReport; trailer: string;
  outcome?: { completed: boolean; committedBatches: number; uncertain: boolean };
};
type BatchRestoreResponse = {
  phase: 'inspect' | 'batch' | 'finish' | 'prepare'; info: BatchManifestInfo; confirmations: string[];
  progress: { next_index: number; total_batches: number; done: boolean };
  resume_token: string | null; completed: boolean; committed: boolean;
  report?: BatchReport;
};

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="w-full sm:w-[32rem]">
      <div className="bg-white rounded-2xl shadow-2xl w-full p-5">
        <h3 id={titleId} className="text-lg font-bold text-gray-900 mb-3">{title}</h3>
        {children}
      </div>
    </Dialog>
  );
}

const MAX_UPLOAD_MIB = 50;
const REQUIRED_HEADERS = ['nombres', 'apellidos', 'numero_identificacion'];

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
    description: 'Fichas, consultas, recetas y consentimientos. Fotografías originales por separado' },
  { id: 'finance', label: 'Finanzas', icon: DollarSign, restorable: true, statKeys: ['finance', 'financial_items'], description: 'Ingresos, egresos y partidas de facturas' },
  { id: 'inventory', label: 'Inventario', icon: Package, restorable: true, statKeys: ['inventory_items', 'inventory_batches', 'inventory_movements', 'inventory_groups'], description: 'Productos, subcategorías, lotes, vencimientos y movimientos' },
  { id: 'config', label: 'Configuración de la clínica', icon: Settings, restorable: false, statKeys: [], description: 'Datos, ajustes y usuarios — solo consulta' },
  { id: 'communications', label: 'Comunicaciones WhatsApp', icon: MessageCircle, restorable: false, statKeys: [], description: 'Contactos y mensajes de recordatorios — solo referencia' },
];

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await recordsFetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data, status: res.status });
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

async function downloadGzip(url: string, filename: string, type: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar el archivo generado');
  const body = await new Response((await res.blob()).stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  saveBlob(new Blob([body], { type }), filename.replace(/\.gz$/, ''));
}
async function downloadCompressedBackup(url: string, filename: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('No se pudo descargar el respaldo comprimido');
  saveBlob(await response.blob(), filename);
}

async function* readGzipNdjson(stream: ReadableStream<Uint8Array>) {
  // The DOM lib types DecompressionStream's writable input as BufferSource, while this browser stream supplies Uint8Array.
  const gzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
  const reader = stream.pipeThrough(gzip).getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line) throw new Error('El respaldo por lotes contiene una línea vacía');
        if (new TextEncoder().encode(line).length > 1024 * 1024) throw new Error('Una línea del respaldo supera 1 MiB');
        yield line;
        newline = pending.indexOf('\n');
      }
      if (new TextEncoder().encode(pending).length > 1024 * 1024)
        throw new Error('Una línea del respaldo supera 1 MiB');
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (pending) throw new Error('El respaldo por lotes está truncado: falta el cierre de línea final');
}

const emptyBatchReport = (): BatchReport => ({
  inserted: {}, existing: {}, deferred: {}, skipped: {}, errors: [], errorCount: 0, deferredCount: 0,
});
const addBatchReport = (total: BatchReport, part?: BatchReport) => {
  if (!part) return;
  for (const key of ['inserted', 'existing', 'deferred', 'skipped'] as const) {
    for (const [table, count] of Object.entries(part[key] || {}))
      total[key][table] = (total[key][table] || 0) + count;
  }
  total.errors.push(...part.errors);
  total.errorCount += part.errorCount;
  total.deferredCount += part.deferredCount;
};

async function downloadConsentPages(patientIds: number[] | null, onProgress: (part: number) => void) {
  let offset = 0;
  let parts = 0;
  let revision: string | null = null;
  let total: number | null = null;
  while (true) {
    onProgress(parts + 1);
    const page: ConsentPage = await api<ConsentPage>('/api/backup?action=consentsHtml', {
      ...(patientIds ? { patientIds } : {}), offset, limit: 100, ...(revision ? { revision } : {}),
    });
    // No aceptar el contrato antiguo: podría omitir consentimientos sin avisar.
    const nextOffset = offset + page.returnedCount;
    if (!Number.isSafeInteger(page.count) || page.count < offset ||
        !Number.isSafeInteger(page.returnedCount) || page.returnedCount !== Math.min(100, page.count - offset) ||
        typeof page.hasMore !== 'boolean' || page.hasMore !== (nextOffset < page.count) ||
        page.nextOffset !== (page.hasMore ? nextOffset : null) ||
        typeof page.revision !== 'string' || !/^[a-f0-9]{32}$/.test(page.revision) ||
        (revision !== null && page.revision !== revision) || (total !== null && page.count !== total)) {
      throw new Error('No se pudo verificar la paginación de consentimientos. No se confirma una descarga completa; contacte a soporte.');
    }
    revision = page.revision;
    total = page.count;
    if (page.returnedCount > 0) {
      await downloadGzip(page.url, page.filename, 'text/html');
      parts++;
    }
    if (page.nextOffset === null) return { count: nextOffset, parts };
    offset = page.nextOffset;
  }
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
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Guayaquil' }) : '—';
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
  const access = subscriptionAccess(user);
  const canManage = access.canAccessBackup && !access.deliveryOnly;
  const [pending, setPending] = useState<{ title: string; message: React.ReactNode; confirmLabel: string; onConfirm: () => void } | null>(null);
  const [picker, setPicker] = useState<{ patients: ConsentPatient[] | null; selected: Set<number>; search: string } | null>(null);
  const [tab, setTab] = useState<'export' | 'import' | 'cloud'>('export');
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(['patients', 'finance', 'inventory']));
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [loadingSnapshots, setLoadingSnapshots] = useState(true);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [snapshotKind, setSnapshotKind] = useState('all');
  const [snapshotLimit, setSnapshotLimit] = useState(10);
  const [importMode, setImportMode] = useState<'restore' | 'patients'>('restore');
  const [restoreTarget, setRestoreTarget] = useState<{ source: 'upload' | 'snapshot'; key: string; label: string } | null>(null);
  const [restore, setRestore] = useState<RestoreResult | null>(null);
  const [batchRestore, setBatchRestore] = useState<BatchRestorePreview | null>(null);
  const [batchConfirm, setBatchConfirm] = useState({ unsigned: false, foreign: false, partial: false, understood: false });
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState({ unsigned: false, foreign: false, partial: false, understood: false });
  const [patientRows, setPatientRows] = useState<Record<string, string>[] | null>(null);
  const [patientFile, setPatientFile] = useState('');
  const [patientReport, setPatientReport] = useState<PatientReport | null>(null);
  const [templateColumns, setTemplateColumns] = useState<TemplateColumn[]>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (!canManage) return;
    if ((['preview', 'upload', 'restore', 'batch-preview', 'batch-restore'].includes(label) && !access.canRestore) ||
        (['csv-parse', 'patients'].includes(label) && !access.canImport) ||
        ((['export', 'batch-export', 'consents'].includes(label) || label.startsWith('dl-') || (label.startsWith('csv-') && label !== 'csv-parse')) && !access.canExport) ||
        (label === 'snapshot' && !access.canManualSnapshot)) {
      setError('La suscripción solo permite consultar y descargar respaldos existentes.');
      return;
    }
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Ocurrió un error'); } finally {
      setBusy(null);
      if (label === 'batch-preview' || label === 'batch-restore') setBatchProgress(null);
    }
  };
  const ask = (title: string, message: React.ReactNode, confirmLabel: string, onConfirm: () => void) =>
    setPending({ title, message, confirmLabel, onConfirm });
  const SENSITIVE = 'El archivo contendrá datos sensibles de salud. Guárdalo en un lugar seguro y no lo compartas por correo o chats sin protección.';

  const loadStats = useCallback(async () => {
    if (!canManage) return;
    setLoadingStats(true);
    setStatsError(null);
    try {
      const result = await api<StatsData>('/api/backup?action=stats');
      setStats(result);
    }
    catch (e) { setStats(null); setStatsError(e instanceof Error ? e.message : 'Error al cargar estadísticas'); }
    finally { setLoadingStats(false); }
  }, [canManage]);

  const loadSnapshots = useCallback(async () => {
    if (!canManage) return;
    setLoadingSnapshots(true);
    setSnapshotsError(null);
    try {
      const result = await api<{ snapshots: Snapshot[]; batch_snapshots?: Snapshot[] }>('/api/backup?action=snapshots');
      setSnapshots([...result.snapshots, ...(result.batch_snapshots || [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
    }
    catch (e) { setSnapshots(null); setSnapshotsError(e instanceof Error ? e.message : 'No se pudo listar los respaldos en la nube'); }
    finally { setLoadingSnapshots(false); }
  }, [canManage]);

  useEffect(() => { if (canManage) { void loadStats(); void loadSnapshots(); } }, [canManage, loadStats, loadSnapshots]);
  const loadTemplateInfo = useCallback(async () => {
    if (!canManage) return;
    setTemplateError(null);
    try { setTemplateColumns((await api<{ columns: TemplateColumn[] }>('/api/backup?action=templateInfo')).columns); }
    catch (failure) { setTemplateError(failure instanceof Error ? failure.message : 'No se pudo cargar la guía de columnas'); }
  }, [canManage]);
  useEffect(() => {
    if (canManage && tab === 'import' && importMode === 'patients' && !templateColumns.length)
      void loadTemplateInfo();
  }, [canManage, tab, importMode, templateColumns.length, loadTemplateInfo]);
  const lastAuto = snapshots?.filter(s => s.kind === 'auto')
    .reduce<Snapshot | null>((latest, snapshot) => !latest || Date.parse(snapshot.created_at) > Date.parse(latest.created_at) ? snapshot : latest, null) || null;
  const autoStale = !!lastAuto && Date.now() - Date.parse(lastAuto.created_at) > 48 * 60 * 60 * 1000;
  const encryptionReady = !loadingStats && !statsError && stats?.encryption_ready === true;
  const manualBackup = stats?.manual_backup;
  const manualReady = access.canManualSnapshot && encryptionReady && stats?.manual_backup?.available === true;
  const manualStatus = !access.canManualSnapshot ? 'Puedes descargar las copias existentes.'
    : loadingStats || statsError || !stats || !encryptionReady || !manualBackup ? 'No se pudo verificar la disponibilidad. Actualiza para reintentar.'
    : manualBackup.state === 'PROCESSING' ? 'Hay una copia manual en curso. Actualiza cuando termine.'
    : manualBackup.reason ? 'Copia no disponible. Actualiza o contacta a soporte.'
    : manualBackup.available ? 'Puedes crear una copia ahora.'
    : `Ya creaste una copia hoy.${manualBackup.next_allowed_at ? ` Disponible desde ${fmtDate(manualBackup.next_allowed_at)}.` : ' Actualiza para verificar disponibilidad.'}`;
  const autoStatus = loadingSnapshots ? 'Última copia automática: consultando…'
    : snapshotsError ? `No se pudo verificar la última copia automática: ${snapshotsError}`
    : lastAuto ? `Última copia automática: ${fmtDate(lastAuto.created_at)}${autoStale ? '. Tiene más de 48 horas; solicite revisión a soporte.' : ''}`
    : 'No hay copias automáticas registradas. Contacta a soporte.';

  const count = (keys: string[]) => keys.reduce((sum, k) => sum + (stats?.stats[k]?.count || 0), 0);
  const filteredSnapshots = (snapshots || []).filter(snapshot => snapshotKind === 'all' || snapshot.kind === snapshotKind);

  const exportJson = () => run('export', async () => {
    setBatchRestore(null);
    const { url, filename } = await api<{ url: string; filename: string }>('/api/backup?action=export', { modules: [...selected] });
    await downloadCompressedBackup(url, filename);
    setNotice('Respaldo descargado. Contiene datos sensibles de salud: guárdalo cifrado y fuera del computador de uso diario.');
  });

  const exportBatchJson = () => run('batch-export', async () => {
    setBatchRestore(null);
    const result = await api<{ url: string; filename: string; total_batches: number; size_bytes: number }>(
      '/api/backup?action=export', { modules: [...selected], format: 'batch-jsonl-v1' },
    );
    await downloadCompressedBackup(result.url, result.filename);
    setNotice(`Respaldo completo descargado: ${result.total_batches.toLocaleString('es-EC')} lotes, ${fmtSize(result.size_bytes)}. Conserva el archivo íntegro.`);
  });

  const exportConsents = (patientIds: number[] | null) => run('consents', async () => {
    try {
      const result = await downloadConsentPages(patientIds, part => setNotice(`Generando parte ${part}… Descargue y conserve todas las partes.`));
      setNotice(result.count
        ? `${result.count} consentimientos descargados en ${result.parts} archivo(s). Ábrelos en el navegador y usa Imprimir → Guardar como PDF si necesitas archivarlos.`
        : 'No hay consentimientos firmados para la selección.');
    } catch (failure) {
      setNotice(null);
      if (failure instanceof Error && 'status' in failure && failure.status === 409) {
        throw new Error('La selección de consentimientos cambió durante la descarga. Descarte todas las partes recibidas y reinicie manualmente desde la selección de pacientes. No se reintentará automáticamente.');
      }
      throw new Error(`${failure instanceof Error ? failure.message : 'No se pudo generar la descarga'} La descarga no se completó. Descarte las partes recibidas y reinicie la selección para obtener una copia completa.`);
    }
  });

  const openConsentPicker = () => {
    if (!canManage) return;
    setPicker({ patients: null, selected: new Set(), search: '' });
    api<{ patients: ConsentPatient[] }>('/api/backup?action=consentPatients')
      .then(d => setPicker(p => p && { ...p, patients: d.patients }))
      .catch(e => { setPicker(null); setError(e instanceof Error ? e.message : 'No se pudo cargar la lista de pacientes'); });
  };

  const confirmConsentDownload = () => {
    if (!picker?.patients) return;
    const all = picker.selected.size === 0 || picker.selected.size === picker.patients.length;
    const chosen = picker.patients.filter(p => all || picker.selected.has(p.id));
    const total = chosen.reduce((sum, p) => sum + p.consents, 0);
    const parts = Math.ceil(total / 100);
    setPicker(null);
    ask('Descargar consentimientos firmados',
      <>Se descargarán <strong>{total} consentimientos</strong> de {all ? <strong>todos los pacientes ({chosen.length})</strong> : <strong>{chosen.length} paciente(s) seleccionado(s)</strong>}{parts > 1 ? <>, en aproximadamente <strong>{parts} archivos</strong> de hasta 100 consentimientos</> : ''}. Se incluirán todas las páginas, incluso si un paciente tiene más de 100 consentimientos. {SENSITIVE}</>,
      'Descargar', () => exportConsents(all ? null : chosen.map(patient => patient.id)));
  };

  const exportCsv = (dataset: string) => run(`csv-${dataset}`, async () => {
    const res = await recordsFetch(`/api/backup?action=csv&dataset=${dataset}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo generar el CSV');
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `${dataset}.csv`;
    saveBlob(await res.blob(), name);
  });

  const resetRestore = () => { setRestore(null); setRestoreTarget(null); setConfirm({ unsigned: false, foreign: false, partial: false, understood: false }); };
  const resetBatchRestore = () => {
    setBatchRestore(null);
    setBatchConfirm({ unsigned: false, foreign: false, partial: false, understood: false });
    setBatchProgress(null);
  };

  const openBatchStream = async (source: BatchSource) => {
    if ('file' in source) return source.file.stream();
    const download = await api<{ url: string }>('/api/backup?action=export', { snapshotKey: source.snapshotKey });
    const response = await fetch(download.url);
    if (!response.ok || !response.body) throw new Error('No se pudo abrir el respaldo por lotes de la nube');
    return response.body;
  };

  const previewBatchRestore = (source: BatchSource, label: string) => run('batch-preview', async () => {
    setBatchRestore(null);
    setBatchConfirm({ unsigned: false, foreign: false, partial: false, understood: false });
    setRestore(null); setRestoreTarget(null);
    let manifestLine: string | null = null;
    let trailerLine: string | null = null;
    let info: BatchManifestInfo | null = null;
    let token: string | null = null;
    let nextIndex = 0;
    let finished = false;
    const report = emptyBatchReport();

    for await (const line of readGzipNdjson(await openBatchStream(source))) {
      let parsed: { type?: string };
      try { parsed = JSON.parse(line) as { type?: string }; }
      catch { throw new Error('El archivo contiene una línea JSON inválida; no se restauró nada.'); }
      if (!manifestLine) {
        if (parsed.type !== 'manifest') throw new Error('El archivo no comienza con un manifiesto de respaldo por lotes.');
        manifestLine = line;
        const inspected = await api<BatchRestoreResponse>('/api/backup?action=restore', {
          format: 'batch-jsonl-v1', phase: 'inspect', manifest: line,
        });
        info = inspected.info;
        token = inspected.resume_token;
        continue;
      }
      if (finished) throw new Error('El archivo contiene datos después de su trailer; no se considera completo.');
      if (parsed.type === 'batch') {
        if (!info || nextIndex >= info.total_batches) throw new Error('El archivo contiene más lotes de los declarados.');
        const result: BatchRestoreResponse = await api<BatchRestoreResponse>('/api/backup?action=restore', {
          format: 'batch-jsonl-v1', phase: 'batch', manifest: manifestLine, batch: line,
          index: nextIndex, dryRun: true, ...(token ? { resumeToken: token } : {}),
        });
        if (result.progress.next_index !== nextIndex + 1) throw new Error('La simulación no verificó la secuencia completa de lotes.');
        token = result.resume_token;
        addBatchReport(report, result.report);
        nextIndex++;
        setBatchProgress(`Simulación: ${nextIndex.toLocaleString('es-EC')} de ${info.total_batches.toLocaleString('es-EC')} lotes`);
        continue;
      }
      if (parsed.type !== 'trailer' || !info || nextIndex !== info.total_batches)
        throw new Error('El archivo está incompleto o el trailer no sigue a todos los lotes declarados.');
      trailerLine = line;
      const completed = await api<BatchRestoreResponse>('/api/backup?action=restore', {
        format: 'batch-jsonl-v1', phase: 'finish', manifest: manifestLine, trailer: line,
        ...(token ? { resumeToken: token } : {}),
      });
      if (!completed.completed || !completed.progress.done) throw new Error('No se pudo verificar el trailer final del respaldo.');
      finished = true;
    }
    setBatchProgress(null);
    if (!finished || !manifestLine || !trailerLine || !info)
      throw new Error('El respaldo por lotes terminó antes del manifiesto o trailer completo.');
    setBatchRestore({ source, label, info, confirmations: info.signature === 'valid' ? [] : ['unsigned', ...(info.sameClinic ? [] : ['foreignClinic'])],
      report, trailer: trailerLine });
    setTab('import');
    setImportMode('restore');
  });

  const commitBatchRestore = () => batchRestore && run('batch-restore', async () => {
    let manifestLine: string | null = null;
    let token: string | null = null;
    let nextIndex = 0;
    let finished = false;
    let writeAttempted = false;
    let committedBatches = 0;
    const appliedReport = emptyBatchReport();
    try {
      for await (const line of readGzipNdjson(await openBatchStream(batchRestore.source))) {
        let parsed: { type?: string };
        try { parsed = JSON.parse(line) as { type?: string }; }
        catch { throw new Error('El archivo cambió desde la simulación o contiene una línea JSON inválida.'); }
        if (!manifestLine) {
          if (parsed.type !== 'manifest') throw new Error('El respaldo ya no comienza con un manifiesto válido.');
          manifestLine = line;
          const prepared = await api<BatchRestoreResponse>('/api/backup?action=restore', {
            format: 'batch-jsonl-v1', phase: 'prepare', manifest: line,
            acceptUnsigned: batchConfirm.unsigned, confirmForeignClinic: batchConfirm.foreign,
          });
          if (!prepared.resume_token) throw new Error('No se verificó el respaldo previo; no se aplicaron lotes.');
          token = prepared.resume_token;
          continue;
        }
        if (finished) throw new Error('El archivo cambió: contiene datos después de su trailer.');
        if (parsed.type === 'batch') {
          if (nextIndex >= batchRestore.info.total_batches) throw new Error('El archivo contiene más lotes que la simulación.');
          writeAttempted = true;
          const result: BatchRestoreResponse = await api<BatchRestoreResponse>('/api/backup?action=restore', {
            format: 'batch-jsonl-v1', phase: 'batch', manifest: manifestLine, batch: line, index: nextIndex,
            dryRun: false, allowPartial: batchConfirm.partial, resumeToken: token,
          });
          addBatchReport(appliedReport, result.report);
          if (!result.committed && (result.report?.errorCount || 0) > 0)
            throw new Error(`El lote ${nextIndex + 1} tiene errores y no se aplicó. Confirma la opción de restauración parcial y reinicia desde el mismo archivo; los lotes confirmados son idempotentes.`);
          if (result.progress.next_index !== nextIndex + 1 || !result.resume_token)
            throw new Error(`El lote ${nextIndex + 1} no confirmó el avance esperado. Reinicia desde el mismo archivo para reanudar de forma idempotente.`);
          token = result.resume_token;
          nextIndex++;
          committedBatches++;
          setBatchProgress(`Aplicación: ${nextIndex.toLocaleString('es-EC')} de ${batchRestore.info.total_batches.toLocaleString('es-EC')} lotes`);
          continue;
        }
        if (parsed.type !== 'trailer' || nextIndex !== batchRestore.info.total_batches || line !== batchRestore.trailer)
          throw new Error('El trailer no coincide con la simulación; el proceso no se considera completo.');
        const complete = await api<BatchRestoreResponse>('/api/backup?action=restore', {
          format: 'batch-jsonl-v1', phase: 'finish', manifest: manifestLine, trailer: line, resumeToken: token,
        });
        if (!complete.completed || !complete.progress.done) throw new Error('El servidor no confirmó todos los lotes y el trailer.');
        finished = true;
      }
      if (!finished) throw new Error('La restauración quedó incompleta: falta verificar el trailer.');
      const omitted = appliedReport.errorCount + appliedReport.deferredCount +
        Object.values(appliedReport.skipped).reduce((sum, count) => sum + count, 0);
      setBatchRestore(current => current && { ...current, report: appliedReport,
        outcome: { completed: true, committedBatches, uncertain: false } });
      setBatchConfirm({ unsigned: false, foreign: false, partial: false, understood: false });
      setBatchProgress(null);
      if (!omitted)
        setNotice(`Restauración por lotes completada sin errores; trailer verificado (${committedBatches.toLocaleString('es-EC')} lotes). Respaldo previo: ${batchRestore.info.total_batches === 0 ? 'no se requerían lotes' : 'creado y verificado antes de aplicar'}.`);
      void loadSnapshots();
      void loadStats();
    } catch (failure) {
      setBatchProgress(null);
      if (writeAttempted) {
        setBatchRestore(current => current && { ...current, report: appliedReport,
          outcome: { completed: false, committedBatches, uncertain: true } });
      }
      throw failure;
    }
  });

  const previewRestore = (target: { source: 'upload' | 'snapshot'; key: string; label: string }) => run('preview', async () => {
    setBatchRestore(null);
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
    if (/\.jsonl\.gz$/i.test(file.name)) {
      void previewBatchRestore({ file }, file.name);
      return;
    }
    if (file.size > MAX_UPLOAD_MIB * 1048576) { setError(`El archivo supera ${MAX_UPLOAD_MIB} MiB. Usa la copia .json.gz sin descomprimir; si aún supera el límite, coordina una restauración asistida con soporte.`); return; }
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
    void loadSnapshots();
    void loadStats();
  });

  const downloadTemplate = () => run('template', async () => {
    const res = await recordsFetch('/api/backup?action=template');
    if (!res.ok) throw new Error('No se pudo descargar la plantilla');
    saveBlob(await res.blob(), 'plantilla-pacientes-bioskintech.csv');
  });

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
    setNotice(`${report.created} pacientes importados${report.withHistory ? ` (${report.withHistory} con antecedentes)` : ''}. Cada uno ya tiene su expediente clínico listo y queda registrado en auditoría.`);
    loadStats();
  });

  const createSnapshot = () => run('snapshot', async () => {
    if (!manualReady) throw new Error('Debe verificarse el cifrado y el cupo diario antes de crear una copia.');
    try {
      await api('/api/backup?action=snapshot', {});
      setNotice('Respaldo cifrado creado. El cupo manual de hoy está utilizado.');
    } finally {
      await Promise.all([loadStats(), loadSnapshots()]);
    }
  });

  const downloadSnapshot = (s: Snapshot) => run(`dl-${s.key}`, async () => {
    const { url, filename } = await api<{ url: string; filename: string }>('/api/backup?action=export', { snapshotKey: s.key });
    await downloadCompressedBackup(url, filename);
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
        <div className="flex items-center justify-between gap-3 mb-6">
          <div className="flex min-w-0 items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl shadow-lg"><Database className="w-7 h-7 text-white" /></div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Base de Datos</h1>
              <p className="text-sm text-gray-600">Respaldos, exportación e importación</p>
            </div>
          </div>
          <button onClick={() => { void loadStats(); void loadSnapshots(); }} disabled={loadingStats || loadingSnapshots} aria-label="Actualizar"
            className="shrink-0 p-3 bg-white hover:bg-gray-50 rounded-xl border border-gray-200 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            {loadingStats ? <Loader2 className="w-4 h-4 animate-spin text-gray-700" /> : <RefreshCw className="w-4 h-4 text-gray-700" />}
          </button>
        </div>

        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
          {([['export', 'Exportar', Download], ['import', 'Importar', Upload], ['cloud', 'Nube', Cloud]] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id} disabled={id === 'import' && !access.canImport}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${tab === id ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              <Icon className="w-4 h-4" />{label}
            </button>
          ))}
        </div>

        {error && <div role="alert" className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm flex gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}</div>}
        {notice && <div role="status" className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-sm flex gap-2"><Check className="w-4 h-4 flex-shrink-0 mt-0.5" />{notice}</div>}

        <p className="mb-4 text-sm text-gray-700">
          {tab === 'export' ? 'Descarga datos por módulos, tablas para Excel o consentimientos legibles. Las fotografías originales se solicitan por separado.'
            : tab === 'cloud' ? 'Consulta tus copias cifradas, descarga una o simula una restauración. Las fotografías originales no están incluidas.'
            : 'Restaura registros faltantes desde un respaldo o importa pacientes por CSV. Primero revisa la simulación.'}
        </p>
        <details className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 text-xs leading-relaxed text-gray-700">
          <summary className="cursor-pointer font-semibold text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-dark">¿Qué puedo hacer aquí?</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li><strong>Exportar:</strong> descargar respaldos, tablas para Excel y consentimientos.</li>
            <li><strong>Nube:</strong> crear, descargar o restaurar copias de todos los módulos de tu clínica.</li>
            <li><strong>Importar:</strong> agregar registros faltantes o cargar pacientes desde un CSV, sin reemplazar datos existentes.</li>
            <li><strong>Respaldo anual:</strong> solicitar fotografías originales, historias clínicas y consentimientos legibles.</li>
          </ul>
        </details>

        {tab === 'export' && (
          <>
            <div className={`mb-6 border rounded-2xl p-4 flex gap-3 ${snapshotsError || autoStale || (!loadingSnapshots && !lastAuto) ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
              <ShieldCheck className="w-6 h-6 flex-shrink-0" aria-hidden="true" />
              <div className="text-sm">
                <p className="font-semibold">Estado del respaldo automático de datos</p>
                <p role="status" className="text-xs mt-1 font-medium">{autoStatus}</p>
              </div>
            </div>
            {statsError && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">No se pudieron consultar las estadísticas: {statsError}</p>}
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

            <AnnualPhotoBackupPanel />

            <Card title="Respaldo por módulos" subtitle="Selecciona los datos que deseas guardar. Puedes restaurarlos desde Importar.">
              <p className="mb-4 text-xs text-gray-600">Los conteos son registros, no pacientes: una ficha puede incluir consultas, firmas y versiones.{stats?.stats.patients?.exists && ` Pacientes registrados: ${stats.stats.patients.count}.`}</p>
              <div className="divide-y divide-gray-100 -mx-4 -mt-4 mb-4">
                {MODULES.map(m => {
                  const on = selected.has(m.id);
                  return (
                    <label key={m.id} className="flex items-start gap-3 p-4 cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={on} className="mt-1 w-4 h-4 accent-gold"
                        onChange={() => setSelected(prev => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} />
                      <m.icon className="w-4 h-4 text-gold-dark mt-1 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800 text-sm">{m.label} {!m.restorable && <span className="ml-1 text-[10px] uppercase bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">solo consulta</span>}</p>
                        <p className="text-xs text-gray-500 leading-relaxed">{m.description}</p>
                      </div>
                      {m.statKeys.length > 0 && <span title="Registros incluidos en el módulo" className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full flex-shrink-0">{loadingStats || !stats ? '—' : `${count(m.statKeys).toLocaleString('es-EC')} reg.`}</span>}
                    </label>
                  );
                })}
              </div>
              <button onClick={() => ask('Descargar respaldo técnico',
                <>Se generará un archivo JSON comprimido (.json.gz) con: <strong>{MODULES.filter(m => selected.has(m.id)).map(m => m.label).join(', ')}</strong>. {SENSITIVE}</>,
                'Descargar', exportJson)} disabled={!!busy || selected.size === 0}
                className="w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 bg-gold text-white hover:bg-gold-dark disabled:opacity-50">
                {busy === 'export' ? <><Loader2 className="w-5 h-5 animate-spin" />Generando respaldo…</> : <><FileJson className="w-5 h-5" />Descargar respaldo (.json.gz)</>}
              </button>
              <button onClick={() => ask('Descargar respaldo completo por lotes',
                <>Se descargará un respaldo por lotes de: <strong>{MODULES.filter(m => selected.has(m.id)).map(m => m.label).join(', ')}</strong>. {SENSITIVE}</>,
                'Descargar', exportBatchJson)} disabled={!!busy || selected.size === 0}
                className="w-full mt-2 py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 border border-gold text-gold-dark hover:bg-gold/5 disabled:opacity-50">
                {busy === 'batch-export' ? <><Loader2 className="w-5 h-5 animate-spin" />Generando respaldo…</> : <><FileJson className="w-5 h-5" />Descargar respaldo por lotes (.jsonl.gz)</>}
              </button>
            </Card>

            <Card title="Tablas para Excel / Google Sheets (CSV)" subtitle="Listados simples para consultar o filtrar. No son fichas clínicas completas ni se pueden restaurar.">
              <div className="grid grid-cols-2 gap-2">
                {[['patients', 'Pacientes'], ['treatments', 'Tratamientos'], ['finance', 'Finanzas'], ['inventory', 'Inventario']].map(([id, label]) => (
                  <button key={id} onClick={() => ask(`Descargar tabla de ${label.toLowerCase()}`,
                    <>Se descargará un archivo CSV con todos los registros de <strong>{label.toLowerCase()}</strong> de la clínica. {SENSITIVE}</>,
                    'Descargar', () => exportCsv(id))} disabled={!!busy}
                    className="py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:border-gold hover:bg-gold/5 flex items-center justify-center gap-2 disabled:opacity-50">
                    {busy === `csv-${id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 text-emerald-600" />}{label}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="Consentimientos firmados (documento legible)" subtitle="Consentimientos con su contenido, firmas, fechas y huella de integridad, listos para leer o imprimir">
              <p className="text-xs text-gray-600 mb-3">Elige pacientes específicos o todos y conserva todas las partes descargadas. Para obtener un PDF, abre el documento y usa <strong>Imprimir → Guardar como PDF</strong>.</p>
              <button onClick={openConsentPicker} disabled={!!busy}
                className="w-full py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:border-gold hover:bg-gold/5 flex items-center justify-center gap-2 disabled:opacity-50">
                {busy === 'consents' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSignature className="w-4 h-4 text-gold-dark" />}Seleccionar y descargar consentimientos
              </button>
            </Card>
            <p className="text-xs text-gray-400 text-center">Los archivos descargados contienen datos sensibles de salud. Su custodia es responsabilidad de la clínica.</p>
          </>
        )}

        {tab === 'import' && access.canImport && (
          <>
            <div className="flex gap-2 mb-4">
              {([['restore', 'Restaurar respaldo'], ['patients', 'Importar pacientes (CSV)']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setImportMode(id)}
                  aria-pressed={importMode === id} className={`flex-1 py-2 rounded-xl text-sm font-medium border ${importMode === id ? 'bg-white text-gray-900 border-gray-300' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{label}</button>
              ))}
            </div>

            {importMode === 'restore' && (
              <>
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800 space-y-1">
                  <p className="font-semibold flex items-center gap-1.5"><Info className="w-4 h-4" />Cómo funciona la restauración</p>
                  <p>Revisa la simulación antes de confirmar. Solo se agregan registros faltantes; los datos existentes no se modifican.</p>
                  <p>Antes de restaurar, se guarda una copia del estado actual.</p>
                </div>
                {!restore && !batchRestore && (
                  <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-2xl bg-white cursor-pointer hover:border-gold ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                    {busy === 'upload' || busy === 'preview' || busy === 'batch-preview' ? <Loader2 className="w-8 h-8 text-gold animate-spin mb-2" /> : <FileJson className="w-8 h-8 text-gray-300 mb-2" />}
                    <span className="text-sm text-gray-500">{busy === 'upload' ? 'Subiendo y analizando…' : busy === 'batch-preview' ? batchProgress || 'Verificando respaldo…' : 'Selecciona un respaldo .json, .json.gz o .jsonl.gz'}</span>
                    <input ref={backupInput} type="file" accept=".json,.gz,.jsonl.gz,application/json,application/gzip" className="hidden" onChange={onBackupFile} />
                  </label>
                )}
                <p className="my-3 text-xs text-gray-600">Selecciona el archivo descargado sin extraerlo ni modificarlo.</p>
                {batchProgress && busy !== 'batch-preview' && <p role="status" className="my-2 text-xs text-blue-800">{batchProgress}</p>}
                {batchRestore && (
                  <Card title={batchRestore.outcome ? (batchRestore.outcome.completed ? 'Resultado de restauración por lotes' : 'Restauración por lotes interrumpida') : 'Simulación completa por lotes'} subtitle={batchRestore.label}>
                    <div className="grid grid-cols-2 gap-2 text-xs mb-4">
                      <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Generado:</span> {fmtDate(batchRestore.info.timestamp)}{batchRestore.info.ageDays != null && ` (${batchRestore.info.ageDays} días)`}</div>
                      <div className={`p-2 rounded-lg ${batchRestore.info.signature === 'valid' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                        {batchRestore.info.signature === 'valid' ? 'Firma de integridad válida' : batchRestore.info.signature === 'invalid' ? 'Firma inválida: requiere confirmación explícita' : 'Sin firma de integridad: requiere confirmación explícita'}
                      </div>
                      <div className={`p-2 rounded-lg col-span-2 ${batchRestore.info.sameClinic ? 'bg-gray-50' : 'bg-red-50 text-red-700'}`}>{batchRestore.info.sameClinic ? 'Pertenece a esta clínica' : 'Atención: el respaldo proviene de otra clínica'}</div>
                      <div className="p-2 bg-gray-50 rounded-lg col-span-2">{batchRestore.info.total_batches.toLocaleString('es-EC')} lotes verificados; el trailer acredita el archivo completo.</div>
                    </div>
                    <table className="w-full text-xs mb-3">
                      <thead className="text-gray-500"><tr><th className="text-left py-1">Sección</th><th className="text-right">Nuevos</th><th className="text-right">Ya existen</th><th className="text-right">Diferidos*</th></tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {[...new Set([...Object.keys(batchRestore.report.inserted), ...Object.keys(batchRestore.report.existing),
                          ...Object.keys(batchRestore.report.deferred), ...Object.keys(batchRestore.report.skipped)])].map(table => (
                          <tr key={table}><td className="py-1">{TABLE_LABELS[table] || table}</td>
                            <td className="text-right font-semibold text-emerald-700">{batchRestore.report.inserted[table] || 0}</td>
                            <td className="text-right text-gray-500">{batchRestore.report.existing[table] || 0}</td>
                            <td className="text-right text-amber-700">{batchRestore.report.deferred[table] || batchRestore.report.skipped[table] || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {batchRestore.report.deferredCount > 0 && <p className="text-xs text-amber-800 mb-3">*Las filas diferidas dependen de registros anteriores simulados sin escribir. Se revalidarán en orden durante la aplicación.</p>}
                    {batchRestore.report.errorCount > 0 && (
                      <div className="mb-3 p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-700 max-h-40 overflow-auto">
                        <p className="font-semibold mb-1">{batchRestore.report.errorCount} filas con errores{batchRestore.outcome ? '; revisa el resultado parcial.' : '; la opción parcial requiere confirmación explícita.'}</p>
                        {batchRestore.report.errors.slice(0, 50).map((item, index) => <p key={`${item.table}-${item.id}-${index}`}>{TABLE_LABELS[item.table] || item.table} #{item.id ?? '?'}: {item.error}</p>)}
                      </div>
                    )}
                    {batchRestore.outcome && (
                      <div role="status" className={`mb-4 p-3 rounded-xl text-xs ${batchRestore.outcome.completed &&
                        !batchRestore.report.errorCount && !batchRestore.report.deferredCount &&
                        !Object.values(batchRestore.report.skipped).some(Boolean) ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
                        {batchRestore.outcome.completed
                          ? batchRestore.report.errorCount || batchRestore.report.deferredCount || Object.values(batchRestore.report.skipped).some(Boolean)
                            ? `Restauración finalizada con resultado parcial en ${batchRestore.outcome.committedBatches} lotes. El trailer del archivo sí fue verificado; quedan filas con errores, diferidas u omitidas en el resumen.`
                            : `Restauración completa: ${batchRestore.outcome.committedBatches} lotes confirmados y trailer verificado.`
                          : `Restauración incompleta: ${batchRestore.outcome.committedBatches} lotes confirmados. ${batchRestore.outcome.uncertain ? 'El lote interrumpido pudo haberse aplicado aunque se perdiera su respuesta. ' : ''}No se verificó el trailer. Reinicia con el mismo archivo para reanudar idempotentemente; los registros existentes no se sobrescriben.`}
                      </div>
                    )}
                    {(!batchRestore.outcome || !batchRestore.outcome.completed) && (
                      <>
                        <div className="space-y-2 mb-4">
                          {batchRestore.confirmations.includes('unsigned') && <Confirm checked={batchConfirm.unsigned} onChange={value => setBatchConfirm(current => ({ ...current, unsigned: value }))}>Entiendo que el archivo no tiene firma válida de este sistema y autorizo explícitamente su uso.</Confirm>}
                          {batchRestore.confirmations.includes('foreignClinic') && <Confirm checked={batchConfirm.foreign} onChange={value => setBatchConfirm(current => ({ ...current, foreign: value }))}>Confirmo que quiero importar datos de otra clínica a esta clínica.</Confirm>}
                          {batchRestore.report.errorCount > 0 && <Confirm checked={batchConfirm.partial} onChange={value => setBatchConfirm(current => ({ ...current, partial: value }))}>Permito confirmar por lote las filas válidas aunque otras fallen; la clínica puede quedar parcialmente restaurada hasta reanudar.</Confirm>}
                          {!batchRestore.outcome && <Confirm checked={batchConfirm.understood} onChange={value => setBatchConfirm(current => ({ ...current, understood: value }))}>Revisé la simulación completa y autorizo restaurar por lotes.</Confirm>}
                        </div>
                        {batchRestore.outcome && <p className="mb-3 text-xs text-amber-800">El reinicio procesará nuevamente el mismo archivo; no vuelve a sobrescribir los registros que ya existan.</p>}
                      </>
                    )}
                    <div className="flex gap-2">
                      <button onClick={resetBatchRestore} disabled={!!busy} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">{batchRestore.outcome?.completed ? 'Nueva restauración' : 'Cancelar'}</button>
                      {(!batchRestore.outcome || !batchRestore.outcome.completed) && (
                        <button onClick={() => ask(batchRestore.outcome ? 'Reanudar restauración por lotes' : 'Confirmar restauración por lotes',
                          <>Se creará y verificará un respaldo previo antes del primer cambio. Después, <strong>{batchRestore.info.total_batches.toLocaleString('es-EC')} lotes</strong> se confirmarán en transacciones separadas. Si el proceso se interrumpe, algunos lotes podrían quedar aplicados; reiniciar con el mismo archivo es idempotente y no sobrescribe registros existentes.</>,
                          batchRestore.outcome ? 'Reanudar por lotes' : 'Restaurar por lotes', () => { void commitBatchRestore(); })}
                          disabled={!!busy || (!batchRestore.outcome && !batchConfirm.understood) ||
                            (batchRestore.confirmations.includes('unsigned') && !batchConfirm.unsigned) ||
                            (batchRestore.confirmations.includes('foreignClinic') && !batchConfirm.foreign) ||
                            (batchRestore.report.errorCount > 0 && !batchConfirm.partial)}
                          className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
                          {busy === 'batch-restore' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}{batchRestore.outcome ? 'Reanudar por lotes' : 'Restaurar todos los lotes'}
                        </button>
                      )}
                    </div>
                  </Card>
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
                      <button onClick={() => ask('Confirmar restauración',
                        <>Se agregarán <strong>{Object.values(restore.report.inserted).reduce((a, b) => a + b, 0)} registros</strong> que hoy no existen. Nada existente se modificará y antes se guardará un respaldo del estado actual.</>,
                        'Restaurar', commitRestore)} disabled={!canCommit || !!busy} className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
                        {busy === 'restore' && <Loader2 className="w-4 h-4 animate-spin" />}Restaurar ahora
                      </button>
                    </div>
                  </Card>
                )}
              </>
            )}

            {importMode === 'patients' && (
              <Card title="Importar pacientes desde plantilla" subtitle="Para migrar pacientes desde Excel u otro sistema">
                <ol className="text-xs text-gray-700 space-y-1 mb-3 list-decimal list-inside">
                  <li>Descarga la plantilla y ábrela en Excel o Google Sheets. Trae dos filas de <strong>EJEMPLO</strong> que el sistema ignora; puedes borrarlas.</li>
                  <li>Llena una fila por paciente. Solo son obligatorios <strong>nombres, apellidos y número de identificación</strong>.</li>
                  <li>Guarda como <strong>CSV UTF-8</strong> (Archivo → Guardar como → CSV UTF-8) y súbelo aquí.</li>
                  <li>Verás una revisión previa con los errores por fila. No se importa nada hasta que confirmes.</li>
                </ol>
                <div className="mb-3 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-800 space-y-1">
                  <p><strong>Expediente:</strong> cada paciente importado queda con su expediente clínico creado automáticamente; no necesitas crear otro.</p>
                  <p><strong>Antecedentes:</strong> las columnas de alergias, medicación y antecedentes se cargan directo en la pestaña Antecedentes del expediente.</p>
                  <p><strong>Identificación:</strong> el sistema valida la cédula ecuatoriana (dígito verificador) y detecta si es cédula o RUC por la cantidad de dígitos. Si ya existe un paciente con esa identificación, se omite y nunca se sobrescribe.</p>
                </div>
                {templateError && <div role="alert" className="mb-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                  No se pudo cargar la guía de columnas: {templateError}. La descarga de la plantilla sigue disponible.
                  <button type="button" onClick={() => void loadTemplateInfo()} className="ml-2 min-h-11 underline">Reintentar guía</button>
                </div>}
                {templateColumns.length > 0 && (
                  <details className="mb-4 text-xs">
                    <summary className="cursor-pointer font-medium text-gray-700">Ver guía de columnas ({templateColumns.length})</summary>
                    <div className="mt-2 max-h-64 overflow-auto border border-gray-100 rounded-lg">
                      <table className="w-full">
                        <thead className="bg-gray-50 text-gray-500 sticky top-0"><tr><th className="text-left p-2">Columna</th><th className="text-left p-2">Cómo llenarla</th><th className="text-left p-2">Ejemplo</th></tr></thead>
                        <tbody className="divide-y divide-gray-100">
                          {templateColumns.map(c => (
                            <tr key={c.name}><td className="p-2 font-mono">{c.name}{c.required && <span className="text-red-500"> *</span>}</td><td className="p-2 text-gray-600">{c.description}</td><td className="p-2 text-gray-500">{c.example}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                <div className="flex gap-2 mb-4">
                  <button onClick={() => ask('Descargar plantilla', 'Se descargará la plantilla CSV vacía (con dos filas de ejemplo) para registrar pacientes.', 'Descargar', downloadTemplate)} disabled={!!busy} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2 disabled:opacity-50">{busy === 'template' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}Plantilla CSV</button>
                  <button onClick={() => csvInput.current?.click()} disabled={!!busy} className="flex-1 py-2.5 rounded-xl bg-gold text-white text-sm font-semibold hover:bg-gold-dark flex items-center justify-center gap-2 disabled:opacity-50">
                    {busy === 'csv-parse' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}Seleccionar CSV
                  </button>
                  <input ref={csvInput} type="file" accept=".csv,text/csv" className="hidden" onChange={onPatientCsv} />
                </div>
                {patientReport && (
                  <div className="space-y-3 text-xs">
                    <p className="text-gray-700"><strong>{patientFile}</strong>: {patientReport.valid} listos para importar ({patientReport.withHistory} con antecedentes) · {patientReport.duplicates.length} omitidos · {patientReport.errors.length} con errores{patientReport.examplesSkipped ? ` · ${patientReport.examplesSkipped} filas de ejemplo ignoradas` : ''}</p>
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
                    <button onClick={() => ask('Confirmar importación',
                      <>Se crearán <strong>{patientReport.valid} pacientes</strong> con su expediente{patientReport.withHistory ? ` (${patientReport.withHistory} con antecedentes)` : ''}. Los pacientes ya registrados no se modifican.</>,
                      'Importar', commitPatients)} disabled={!!busy || patientReport.errors.length > 0 || patientReport.valid === 0}
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
            <Card title="Copias de datos en la nube" subtitle="Copias cifradas de tu clínica; originales fotográficos por solicitud anual">
              <details className="mb-3 text-xs text-gray-700">
              <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-dark">Protección y conservación</summary>
              <ul className="mt-2 space-y-1.5">
                <li className="flex gap-2"><ShieldCheck className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />Copias cifradas en almacenamiento separado de la base de datos.</li>
                <li className="flex gap-2"><History className="w-3.5 h-3.5 text-blue-600 flex-shrink-0 mt-0.5" />Conservación de 35 días. Cada copia incluye los datos hasta su fecha de creación.</li>
              </ul>
              </details>
              <p role="status" className={`text-xs mb-3 ${snapshotsError || autoStale || (!loadingSnapshots && !lastAuto) ? 'text-amber-800' : 'text-gray-700'}`}>{autoStatus}</p>
              <p role="status" className="mb-3 text-xs text-gray-700">{loadingStats ? 'Consultando disponibilidad…' : manualStatus}</p>
              <button onClick={() => ask('Crear respaldo en la nube', 'Se guardará una copia cifrada de los datos actuales de tu clínica.', 'Crear respaldo', createSnapshot)} disabled={!!busy || !manualReady}
                className="w-full py-3 rounded-xl bg-gold text-white font-semibold hover:bg-gold-dark disabled:opacity-50 flex items-center justify-center gap-2">
                {busy === 'snapshot' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Cloud className="w-5 h-5" />}Crear respaldo en la nube ahora
              </button>
            </Card>

            <Card title="Respaldos disponibles" subtitle="Descárgalos o restaura registros faltantes desde cualquiera de ellos">
              <label className="mb-3 block text-xs text-gray-700">Tipo de copia
                <select value={snapshotKind} onChange={event => { setSnapshotKind(event.target.value); setSnapshotLimit(10); }}
                  className="ml-2 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 focus-visible:ring-2 focus-visible:ring-gold-dark">
                  <option value="all">Todas</option>{Object.entries(KIND_LABEL).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select>
              </label>
              {loadingSnapshots && <p role="status" className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Cargando…</p>}
              {snapshotsError && <p role="alert" className="text-sm text-red-700">No se pudo consultar la lista: {snapshotsError}. Use Actualizar para reintentar.</p>}
              {!loadingSnapshots && !snapshotsError && snapshots?.length === 0 && <p className="text-sm text-gray-500">Aún no hay respaldos guardados.</p>}
              <div className="divide-y divide-gray-100 -mx-4">
                {filteredSnapshots.slice(0, snapshotLimit).map(s => (
                  <div key={s.key} className="flex items-center gap-3 px-4 py-3">
                    <Cloud className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800">{fmtDate(s.created_at)}</p>
                      <p className="text-xs text-gray-500">{KIND_LABEL[s.kind] || s.kind} · {fmtSize(s.size)}</p>
                    </div>
                    <button onClick={() => ask('Descargar respaldo de la nube', <>Se descargará la copia del <strong>{fmtDate(s.created_at)}</strong> en formato {s.format === 'batch-jsonl-v1' ? '.jsonl.gz por lotes' : '.json.gz'}. {SENSITIVE}</>, 'Descargar', () => downloadSnapshot(s))} disabled={!!busy} title="Descargar" aria-label={`Descargar respaldo del ${fmtDate(s.created_at)}`} className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
                      {busy === `dl-${s.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4 text-gray-600" />}
                    </button>
                    <button onClick={() => s.format === 'batch-jsonl-v1'
                      ? previewBatchRestore({ snapshotKey: s.key }, `Nube por lotes · ${fmtDate(s.created_at)}`)
                      : previewRestore({ source: 'snapshot', key: s.key, label: `Nube · ${fmtDate(s.created_at)}` })}
                      disabled={!!busy || !access.canRestore}
                      className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">Restaurar…</button>
                  </div>
                ))}
              </div>
              {!loadingSnapshots && !snapshotsError && <p role="status" className="mt-3 text-xs text-gray-600">{Math.min(snapshotLimit, filteredSnapshots.length)} de {filteredSnapshots.length} copias en este filtro</p>}
              {filteredSnapshots.length > snapshotLimit && <button onClick={() => setSnapshotLimit(limit => limit + 10)}
                className="mt-3 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gold-dark">Ver 10 copias más</button>}
            </Card>
          </>
        )}
      </div>

      {picker && (
        <Modal title="Seleccionar consentimientos" onClose={() => setPicker(null)}>
          {!picker.patients ? <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Cargando pacientes…</p>
            : picker.patients.length === 0 ? <p className="text-sm text-gray-500">No hay consentimientos firmados en la clínica.</p>
            : (() => {
              const q = picker.search.trim().toLowerCase();
              const visible = picker.patients.filter(p => !q || `${p.first_name} ${p.last_name} ${p.identification || ''}`.toLowerCase().includes(q));
              const toggle = (id: number) => setPicker(pk => pk && { ...pk, selected: new Set(pk.selected.has(id) ? [...pk.selected].filter(x => x !== id) : [...pk.selected, id]) });
              return (
                <>
                  <input aria-label="Buscar pacientes por nombre o identificación" value={picker.search} onChange={e => setPicker(pk => pk && { ...pk, search: e.target.value })} placeholder="Buscar por nombre o identificación"
                    className="w-full mb-3 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-gold outline-none" />
                  <div className="flex items-center justify-between text-xs text-gray-600 mb-2">
                    <span>{picker.selected.size ? `${picker.selected.size} seleccionado(s)` : `Sin selección = todos (${picker.patients.length} pacientes)`}</span>
                    <button onClick={() => setPicker(pk => pk && { ...pk, selected: pk.selected.size ? new Set() : new Set(visible.map(p => p.id)) })} className="text-gold-dark font-semibold hover:underline">
                      {picker.selected.size ? 'Limpiar selección' : 'Seleccionar visibles'}
                    </button>
                  </div>
                  <div className="max-h-72 overflow-auto divide-y divide-gray-100 border border-gray-100 rounded-xl">
                    {visible.map(p => (
                      <label key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                        <input type="checkbox" checked={picker.selected.has(p.id)} onChange={() => toggle(p.id)} className="w-4 h-4 accent-gold" />
                        <span className="flex-1">{p.last_name} {p.first_name}<span className="block text-xs text-gray-400">{p.identification || 'Sin identificación'}</span></span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.consents}</span>
                      </label>
                    ))}
                    {!visible.length && <p className="p-3 text-sm text-gray-500">Sin resultados.</p>}
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => setPicker(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">Cancelar</button>
                    <button onClick={confirmConsentDownload} className="flex-1 py-2.5 rounded-xl bg-gold text-white text-sm font-semibold hover:bg-gold-dark">
                      {picker.selected.size ? `Continuar con ${picker.selected.size}` : 'Continuar con todos'}
                    </button>
                  </div>
                </>
              );
            })()}
        </Modal>
      )}

      {pending && (
        <Modal title={pending.title} onClose={() => setPending(null)}>
          <p className="text-sm text-gray-700 leading-relaxed">{pending.message}</p>
          <div className="flex gap-2 mt-5">
            <button onClick={() => setPending(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">Cancelar</button>
            <button autoFocus onClick={() => { const action = pending.onConfirm; setPending(null); action(); }}
              className="flex-1 py-2.5 rounded-xl bg-gold text-white text-sm font-semibold hover:bg-gold-dark">{pending.confirmLabel}</button>
          </div>
        </Modal>
      )}
    </AdminLayout>
  );
}
