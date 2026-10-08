import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Download, FlaskConical, MousePointer2, Rotate3D,
  Save, SlidersHorizontal, Trash2, Undo2, Upload,
} from 'lucide-react';
import Clinical3DViewer, {
  type ClinicalCameraPreset,
  type ClinicalModelMetrics,
  type ClinicalSceneSettings,
  type Marker3D,
  type ScalpHairVisualization,
} from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import { useAuth } from '../../context/AuthContext';
import { SCALP_BOUNDARY_PRESET, SCALP_BOUNDARY_PRESET_VERSION } from '../../data/scalpBoundaryPreset';

type LabMode = 'hair' | 'model';
type Density = 'Alta' | 'Media' | 'Baja';

const NORWOOD_STAGES = ['I', 'II', 'III', 'III Vertex', 'IV', 'V', 'VI', 'VII'];
const LUDWIG_STAGES = ['I', 'II', 'III'];
const HAIR_COLORS = ['#160d09', '#2b1a12', '#4a2b1a', '#6b4328', '#9a744e'];
const SCALP_TRACE_STORAGE_KEY = 'bioskin-3d-lab-scalp-trace-v2';
const MODEL_PRESETS = {
  head: { label: 'Cabeza', url: '/models/clinical/male_head.glb', camera: 'scalp' as const },
  body: { label: 'Cuerpo', url: '/models/clinical/male_body.glb', camera: 'body' as const },
};
const DEFAULT_HAIR = {
  scale: 'norwood' as const,
  stage: 'II',
  density: 'Media' as Density,
  color: '#2b1a12',
  lengthScale: 1,
  roughness: 0.58,
  layDown: 0.78,
};
const DEFAULT_SCENE: ClinicalSceneSettings = {
  backgroundColor: '#1e293b',
  exposure: 1,
  ambientIntensity: 0.3,
  keyLightIntensity: 1.8,
  fillLightIntensity: 0.9,
  materialColor: '#fae3db',
  roughness: 0.45,
  metalness: 0.05,
  wireframe: false,
};

const createPresetBoundaryMarkers = (): Marker3D[] => SCALP_BOUNDARY_PRESET.map((position, index) => {
  const radialLength = Math.hypot(position.x, position.z);
  return {
    id: `scalp-preset-v${SCALP_BOUNDARY_PRESET_VERSION}-${index + 1}`,
    type: 'Puntual',
    pathologyId: 'lesion',
    zone: `Trazado ${index + 1}`,
    position: { ...position },
    rotation: [0, 0, 0],
    normal: radialLength
      ? { x: position.x / radialLength, y: 0, z: position.z / radialLength }
      : { x: 0, y: 1, z: 0 },
    radius: 0.3,
  };
});

const loadBoundaryMarkers = (): Marker3D[] => {
  const stored = localStorage.getItem(SCALP_TRACE_STORAGE_KEY);
  if (stored === null) return createPresetBoundaryMarkers();
  try {
    const markers = JSON.parse(stored);
    return Array.isArray(markers) ? markers as Marker3D[] : createPresetBoundaryMarkers();
  } catch {
    return createPresetBoundaryMarkers();
  }
};

const RangeControl = ({
  label, value, min, max, step, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => (
  <label className="block">
    <span className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
      {label} <output>{value.toFixed(2)}</output>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={event => onChange(Number(event.target.value))}
      className="w-full accent-[#b8944d]"
    />
  </label>
);

function HairRenderLabView({ onBack }: { onBack?: () => void }) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [labMode, setLabMode] = useState<LabMode>('hair');
  const [scale, setScale] = useState<'norwood' | 'ludwig'>(DEFAULT_HAIR.scale);
  const [stage, setStage] = useState(DEFAULT_HAIR.stage);
  const [density, setDensity] = useState<Density>(DEFAULT_HAIR.density);
  const [hairColor, setHairColor] = useState(DEFAULT_HAIR.color);
  const [lengthScale, setLengthScale] = useState(DEFAULT_HAIR.lengthScale);
  const [hairRoughness, setHairRoughness] = useState(DEFAULT_HAIR.roughness);
  const [layDown, setLayDown] = useState(DEFAULT_HAIR.layDown);
  const [traceMode, setTraceMode] = useState(false);
  const [traceStatus, setTraceStatus] = useState('');
  const [boundaryPoints, setBoundaryPoints] = useState<Marker3D[]>(loadBoundaryMarkers);
  const [traceClosed, setTraceClosed] = useState(() => loadBoundaryMarkers().length >= 3);
  const [modelUrl, setModelUrl] = useState(MODEL_PRESETS.head.url);
  const [modelData, setModelData] = useState<ArrayBuffer | null>(null);
  const [modelName, setModelName] = useState(MODEL_PRESETS.head.label);
  const [cameraPreset, setCameraPreset] = useState<ClinicalCameraPreset>(MODEL_PRESETS.head.camera);
  const [sceneSettings, setSceneSettings] = useState<ClinicalSceneSettings>(DEFAULT_SCENE);
  const [metrics, setMetrics] = useState<ClinicalModelMetrics | null>(null);
  const [markers, setMarkers] = useState<Marker3D[]>([]);
  const [marking, setMarking] = useState(false);
  const [fileError, setFileError] = useState('');

  const stages = scale === 'norwood' ? NORWOOD_STAGES : LUDWIG_STAGES;
  const hairVisualization = useMemo<ScalpHairVisualization>(() => ({
    scale,
    stage,
    density,
    color: hairColor,
    lengthScale,
    roughness: hairRoughness,
    layDown,
    showBoundaryTrace: true,
    boundaryPoints: boundaryPoints.map(point => point.position),
    boundaryClosed: traceClosed,
  }), [boundaryPoints, density, hairColor, hairRoughness, layDown, lengthScale, scale, stage, traceClosed]);
  const lastDistance = markers.length >= 2
    ? Math.hypot(
      markers.at(-1)!.position.x - markers.at(-2)!.position.x,
      markers.at(-1)!.position.y - markers.at(-2)!.position.y,
      markers.at(-1)!.position.z - markers.at(-2)!.position.z,
    )
    : null;

  const updateScene = <K extends keyof ClinicalSceneSettings>(key: K, value: ClinicalSceneSettings[K]) => {
    setSceneSettings(previous => ({ ...previous, [key]: value }));
  };

  const selectPreset = (preset: keyof typeof MODEL_PRESETS) => {
    const next = MODEL_PRESETS[preset];
    setModelData(null);
    setModelUrl(next.url);
    setModelName(next.label);
    setCameraPreset(next.camera);
    setMarkers([]);
    setMetrics(null);
    setFileError('');
  };

  const importModel = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb')) {
      setFileError('Selecciona un archivo GLB autocontenido.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setFileError('El archivo supera el límite local de 50 MB.');
      return;
    }
    try {
      setModelData(await file.arrayBuffer());
      setModelName(file.name);
      setCameraPreset('default');
      setMarkers([]);
      setMetrics(null);
      setFileError('');
    } catch {
      setFileError('No se pudo leer el archivo seleccionado.');
    }
  };

  const placeMarker = (marker: Marker3D) => {
    setMarkers(previous => [...previous, { ...marker, zone: `Punto ${previous.length + 1}` }]);
  };

  const placeBoundaryPoint = (marker: Marker3D) => {
    setBoundaryPoints(previous => [...previous, { ...marker, zone: `Trazado ${previous.length + 1}` }]);
    setTraceClosed(false);
    setTraceStatus('');
  };

  const saveBoundaryTrace = () => {
    if (boundaryPoints.length < 3) {
      setTraceStatus('Coloca al menos 3 puntos para cerrar el trazado.');
      return;
    }
    localStorage.setItem(SCALP_TRACE_STORAGE_KEY, JSON.stringify(boundaryPoints));
    setTraceClosed(true);
    setTraceMode(false);
    setTraceStatus(`Trazado guardado localmente con ${boundaryPoints.length} puntos.`);
  };

  const exportBoundaryTrace = () => {
    const blob = new Blob([JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      closed: traceClosed,
      points: boundaryPoints,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `bioskin-trazado-capilar-${Date.now()}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    setTraceStatus(`Trazado exportado con ${boundaryPoints.length} puntos.`);
  };

  const capturePng = () => {
    const canvas = viewerRef.current?.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `bioskin-3d-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const reset = () => {
    if (labMode === 'hair') {
      setScale(DEFAULT_HAIR.scale);
      setStage(DEFAULT_HAIR.stage);
      setDensity(DEFAULT_HAIR.density);
      setHairColor(DEFAULT_HAIR.color);
      setLengthScale(DEFAULT_HAIR.lengthScale);
      setHairRoughness(DEFAULT_HAIR.roughness);
      setLayDown(DEFAULT_HAIR.layDown);
      return;
    }
    selectPreset('head');
    setSceneSettings(DEFAULT_SCENE);
    setMarking(false);
  };

  return (
    <main className="min-h-screen bg-[#eef2f1] p-4 text-slate-900 lg:p-6">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-4 rounded-2xl border border-white/80 bg-white px-5 py-4 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="Volver al panel Master"
                  className="admin-focus-ring mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gold-ink">
                  <FlaskConical className="h-4 w-4" aria-hidden="true" />
                  {onBack ? 'Laboratorio Master' : 'Entorno local de desarrollo'}
                </p>
                <h1 className="mt-1 font-serif text-2xl font-semibold">Laboratorio 3D BIOSKIN</h1>
                <p className="mt-1 text-sm text-slate-500">Pruebas gráficas aisladas; no guarda ni modifica fichas clínicas.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={reset}
              className="admin-focus-ring min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Restablecer laboratorio
            </button>
          </div>
          <div className="mt-4 grid gap-2 rounded-xl bg-slate-100 p-1 sm:inline-grid sm:grid-cols-2">
            {([
              ['hair', 'Cabello PBR'],
              ['model', 'Núcleo GLB'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={labMode === value}
                onClick={() => setLabMode(value)}
                className={`admin-focus-ring min-h-10 rounded-lg px-5 text-sm font-semibold ${
                  labMode === value ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="grid gap-4 xl:grid-cols-[350px_minmax(0,1fr)]">
          <aside className="space-y-5 rounded-2xl border border-white/80 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <SlidersHorizontal className="h-4 w-4 text-gold-ink" aria-hidden="true" />
              <h2 className="text-sm font-semibold">
                {labMode === 'hair' ? 'Controles capilares' : 'Controles del modelo'}
              </h2>
            </div>

            {labMode === 'hair' ? (
              <>
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Escala clínica</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {(['norwood', 'ludwig'] as const).map(item => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={scale === item}
                        onClick={() => { setScale(item); setStage('I'); }}
                        className={`admin-focus-ring min-h-11 rounded-xl border text-sm font-semibold ${
                          scale === item ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        {item === 'norwood' ? 'Norwood' : 'Ludwig'}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Etapa</span>
                  <select
                    value={stage}
                    onChange={event => setStage(event.target.value)}
                    className="admin-focus-ring min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold"
                  >
                    {stages.map(item => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Densidad</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Baja', 'Media', 'Alta'] as const).map(item => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={density === item}
                        onClick={() => setDensity(item)}
                        className={`admin-focus-ring min-h-10 rounded-lg border text-xs font-semibold ${
                          density === item ? 'border-gold-ink bg-gold/20 text-gold-ink' : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <RangeControl label="Longitud" value={lengthScale} min={0.55} max={1.8} step={0.05} onChange={setLengthScale} />
                <RangeControl label="Brillo / rugosidad" value={hairRoughness} min={0.25} max={0.95} step={0.05} onChange={setHairRoughness} />
                <RangeControl label="Perfil compacto" value={layDown} min={0.45} max={0.96} step={0.01} onChange={setLayDown} />
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Color</legend>
                  <div className="flex flex-wrap items-center gap-2">
                    {HAIR_COLORS.map(item => (
                      <button
                        key={item}
                        type="button"
                        aria-label={`Usar color ${item}`}
                        aria-pressed={hairColor === item}
                        onClick={() => setHairColor(item)}
                        className={`admin-focus-ring h-9 w-9 rounded-full border-2 ${
                          hairColor === item ? 'border-gold-ink ring-2 ring-gold/40' : 'border-white'
                        }`}
                        style={{ backgroundColor: item }}
                      />
                    ))}
                    <input
                      type="color"
                      aria-label="Color capilar personalizado"
                      value={hairColor}
                      onChange={event => setHairColor(event.target.value)}
                      className="admin-focus-ring h-9 w-12 rounded-lg border border-slate-200 p-1"
                    />
                  </div>
                </fieldset>
                <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                  Mechones anime 3D · PBR estilizado
                </p>
                <div className="space-y-2 rounded-xl border border-gold/30 bg-gold/10 p-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gold-ink">Trazado manual</p>
                    <p className="mt-1 text-[11px] leading-4 text-slate-600">
                      Traza una sección, pausa para rotar y continúa: cada tramo se conecta con el anterior. Guardar cierra y suaviza la curva.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-pressed={traceMode}
                    onClick={() => setTraceMode(value => !value)}
                    className={`admin-focus-ring flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold ${
                      traceMode ? 'bg-gold-ink text-white' : 'border border-gold/50 bg-white text-gold-ink'
                    }`}
                  >
                    <MousePointer2 className="h-4 w-4" aria-hidden="true" />
                    {traceMode ? 'Pausar para rotar' : boundaryPoints.length ? 'Continuar trazado' : 'Activar trazado'}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setBoundaryPoints(previous => previous.slice(0, -1))}
                      disabled={!boundaryPoints.length}
                      className="admin-focus-ring flex min-h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 disabled:opacity-40"
                    >
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> Deshacer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.setItem(SCALP_TRACE_STORAGE_KEY, '[]');
                        setBoundaryPoints([]);
                        setTraceClosed(false);
                        setTraceStatus('Trazado eliminado de este navegador.');
                      }}
                      disabled={!boundaryPoints.length}
                      className="admin-focus-ring flex min-h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Limpiar
                    </button>
                    <button
                      type="button"
                      onClick={saveBoundaryTrace}
                      disabled={boundaryPoints.length < 3}
                      className="admin-focus-ring flex min-h-9 items-center justify-center gap-1 rounded-lg bg-slate-900 text-[11px] font-semibold text-white disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5" aria-hidden="true" /> Guardar
                    </button>
                    <button
                      type="button"
                      onClick={exportBoundaryTrace}
                      disabled={boundaryPoints.length < 3}
                      className="admin-focus-ring flex min-h-9 items-center justify-center gap-1 rounded-lg border border-gold/50 bg-white text-[11px] font-semibold text-gold-ink disabled:opacity-40"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" /> Exportar JSON
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500" role="status">
                    {traceStatus || `${boundaryPoints.length} punto(s) · ${traceClosed ? 'trazado cerrado' : 'trazado abierto'} · guardado local`}
                  </p>
                </div>
              </>
            ) : (
              <>
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Modelo</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(MODEL_PRESETS) as Array<keyof typeof MODEL_PRESETS>).map(key => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => selectPreset(key)}
                        className="admin-focus-ring min-h-10 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        {MODEL_PRESETS[key].label}
                      </button>
                    ))}
                  </div>
                  <label className="admin-focus-ring mt-2 flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 text-sm font-semibold text-white">
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Importar GLB local
                    <input type="file" accept=".glb" className="hidden" onChange={importModel} />
                  </label>
                  <p className="mt-2 truncate text-xs text-slate-500" title={modelName}>{modelName}</p>
                  {fileError ? <p className="mt-2 text-xs font-medium text-rose-600">{fileError}</p> : null}
                </fieldset>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Fondo
                    <input
                      type="color"
                      value={sceneSettings.backgroundColor}
                      onChange={event => updateScene('backgroundColor', event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg border border-slate-200 p-1"
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Material
                    <input
                      type="color"
                      value={sceneSettings.materialColor}
                      onChange={event => updateScene('materialColor', event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg border border-slate-200 p-1"
                    />
                  </label>
                </div>
                <RangeControl label="Exposición" value={sceneSettings.exposure} min={0.4} max={2} step={0.05} onChange={value => updateScene('exposure', value)} />
                <RangeControl label="Luz principal" value={sceneSettings.keyLightIntensity} min={0} max={4} step={0.1} onChange={value => updateScene('keyLightIntensity', value)} />
                <RangeControl label="Luz de relleno" value={sceneSettings.fillLightIntensity} min={0} max={3} step={0.1} onChange={value => updateScene('fillLightIntensity', value)} />
                <RangeControl label="Rugosidad" value={sceneSettings.roughness} min={0} max={1} step={0.05} onChange={value => updateScene('roughness', value)} />
                <RangeControl label="Metalizado" value={sceneSettings.metalness} min={0} max={1} step={0.05} onChange={value => updateScene('metalness', value)} />

                <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700">
                  Malla alámbrica
                  <input
                    type="checkbox"
                    checked={sceneSettings.wireframe}
                    onChange={event => updateScene('wireframe', event.target.checked)}
                    className="h-4 w-4 accent-[#b8944d]"
                  />
                </label>
                <button
                  type="button"
                  aria-pressed={marking}
                  onClick={() => setMarking(value => !value)}
                  className={`admin-focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold ${
                    marking ? 'bg-gold-ink text-white' : 'border border-slate-200 text-slate-700'
                  }`}
                >
                  <MousePointer2 className="h-4 w-4" aria-hidden="true" />
                  {marking ? 'Marcación activada' : 'Activar marcaciones'}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMarkers([])}
                    disabled={!markers.length}
                    className="admin-focus-ring flex min-h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Limpiar
                  </button>
                  <button
                    type="button"
                    onClick={capturePng}
                    className="admin-focus-ring flex min-h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" /> PNG
                  </button>
                </div>
              </>
            )}
          </aside>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-slate-950/70 px-4 py-3 text-white">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gold">
                  {labMode === 'hair' ? 'Cabello PBR' : 'Núcleo de inspección GLB'}
                </p>
                <p className="text-sm font-semibold">
                  {labMode === 'hair'
                    ? `${scale === 'norwood' ? 'Norwood' : 'Ludwig'} ${stage} · Densidad ${density.toLowerCase()}`
                    : modelName}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-slate-200">
                <Rotate3D className="h-3.5 w-3.5" aria-hidden="true" /> Rota y acerca
              </span>
            </div>
            {labMode === 'model' ? (
              <div className="grid grid-cols-2 gap-px bg-white/10 text-xs text-slate-200 sm:grid-cols-4">
                <div className="bg-slate-900/95 px-3 py-2"><span className="text-slate-500">Mallas</span><strong className="ml-2">{metrics?.meshes ?? '—'}</strong></div>
                <div className="bg-slate-900/95 px-3 py-2"><span className="text-slate-500">Vértices</span><strong className="ml-2">{metrics?.vertices.toLocaleString('es-EC') ?? '—'}</strong></div>
                <div className="bg-slate-900/95 px-3 py-2"><span className="text-slate-500">Triángulos</span><strong className="ml-2">{metrics?.triangles.toLocaleString('es-EC') ?? '—'}</strong></div>
                <div className="bg-slate-900/95 px-3 py-2"><span className="text-slate-500">Puntos</span><strong className="ml-2">{markers.length}</strong></div>
              </div>
            ) : null}
            <div ref={viewerRef} className="h-[560px] sm:h-[680px]">
              <Clinical3DViewer
                markers={labMode === 'model' ? markers : traceMode ? boundaryPoints : []}
                modelUrl={labMode === 'model' ? modelUrl : MODEL_PRESETS.head.url}
                modelData={labMode === 'model' ? modelData : null}
                cameraPreset={labMode === 'model' ? cameraPreset : 'scalp'}
                readOnly={labMode === 'hair' ? !traceMode : !marking}
                skipConfirmation
                selectedPathology="lesion"
                onMarkerPlaced={labMode === 'hair' ? placeBoundaryPoint : placeMarker}
                onModelMetrics={setMetrics}
                sceneSettings={labMode === 'model' ? sceneSettings : undefined}
                height="100%"
                pointMarkerScale={0.7}
                scalpHair={labMode === 'hair' ? hairVisualization : null}
              />
            </div>
            {labMode === 'model' ? (
              <div className="flex flex-wrap gap-3 border-t border-white/10 bg-slate-950/80 px-4 py-3 text-xs text-slate-300">
                <span>Dimensiones originales: {metrics ? `${metrics.dimensions.x.toFixed(2)} × ${metrics.dimensions.y.toFixed(2)} × ${metrics.dimensions.z.toFixed(2)}` : '—'}</span>
                <span>Distancia últimos puntos: {lastDistance == null ? '—' : `${lastDistance.toFixed(3)} unidades normalizadas`}</span>
                <span className="ml-auto">Los GLB importados permanecen solo en este navegador.</span>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

export default function HairRenderLab() {
  return <HairRenderLabView />;
}

export function MasterHairRenderLab() {
  const navigate = useNavigate();
  const { checkAuth, user } = useAuth();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    checkAuth().then(valid => {
      let role = user?.role;
      const stored = sessionStorage.getItem('adminUser');
      if (stored) {
        try {
          role = JSON.parse(stored).role;
        } catch {
          navigate('/admin/login', { replace: true });
          return;
        }
      }
      if (!valid || role !== 'master_admin') {
        navigate('/admin/login', { replace: true });
        return;
      }
      setAuthorized(true);
    });
  }, [checkAuth, navigate, user?.role]);

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#eef2f1] text-sm font-medium text-slate-600" role="status">
        Verificando acceso Master...
      </div>
    );
  }

  return <HairRenderLabView onBack={() => navigate('/admin/master')} />;
}
