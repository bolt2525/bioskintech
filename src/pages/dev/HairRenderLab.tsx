import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FlaskConical, Rotate3D, SlidersHorizontal } from 'lucide-react';
import Clinical3DViewer, {
  type ScalpHairVisualization,
} from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import { useAuth } from '../../context/AuthContext';

const NORWOOD_STAGES = ['I', 'II', 'III', 'III Vertex', 'IV', 'V', 'VI', 'VII'];
const LUDWIG_STAGES = ['I', 'II', 'III'];
const HAIR_COLORS = ['#160d09', '#2b1a12', '#4a2b1a', '#6b4328', '#9a744e'];

const DEFAULTS = {
  scale: 'norwood' as const,
  stage: 'II',
  density: 'Media' as const,
  color: '#2b1a12',
  lengthScale: 1,
  roughness: 0.58,
  layDown: 0.78,
};

function HairRenderLabView({ onBack }: { onBack?: () => void }) {
  const [scale, setScale] = useState<'norwood' | 'ludwig'>(DEFAULTS.scale);
  const [stage, setStage] = useState(DEFAULTS.stage);
  const [density, setDensity] = useState<'Alta' | 'Media' | 'Baja'>(DEFAULTS.density);
  const [color, setColor] = useState(DEFAULTS.color);
  const [lengthScale, setLengthScale] = useState(DEFAULTS.lengthScale);
  const [roughness, setRoughness] = useState(DEFAULTS.roughness);
  const [layDown, setLayDown] = useState(DEFAULTS.layDown);

  const stages = scale === 'norwood' ? NORWOOD_STAGES : LUDWIG_STAGES;
  const visualization = useMemo<ScalpHairVisualization>(() => ({
    scale,
    stage,
    density,
    color,
    lengthScale,
    roughness,
    layDown,
  }), [color, density, layDown, lengthScale, roughness, scale, stage]);
  const cardCount = density === 'Alta' ? 5000 : density === 'Baja' ? 1300 : 3000;

  const changeScale = (nextScale: 'norwood' | 'ludwig') => {
    setScale(nextScale);
    setStage('I');
  };

  const reset = () => {
    setScale(DEFAULTS.scale);
    setStage(DEFAULTS.stage);
    setDensity(DEFAULTS.density);
    setColor(DEFAULTS.color);
    setLengthScale(DEFAULTS.lengthScale);
    setRoughness(DEFAULTS.roughness);
    setLayDown(DEFAULTS.layDown);
  };

  return (
    <main className="min-h-screen bg-[#eef2f1] p-4 text-slate-900 lg:p-6">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-4 flex flex-col gap-3 rounded-2xl border border-white/80 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Volver al panel Master"
                className="admin-focus-ring mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:bg-slate-50"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gold-ink">
              <FlaskConical className="h-4 w-4" aria-hidden="true" />
              {onBack ? 'Laboratorio Master' : 'Entorno local de desarrollo'}
            </p>
            <h1 className="mt-1 font-serif text-2xl font-semibold text-slate-900">Laboratorio de cabello 3D</h1>
            <p className="mt-1 text-sm text-slate-500">Hair cards PBR procedurales. No guarda ni modifica fichas clínicas.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            className="admin-focus-ring min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            Restablecer ajustes
          </button>
        </header>

        <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="space-y-5 rounded-2xl border border-white/80 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <SlidersHorizontal className="h-4 w-4 text-gold-ink" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Controles de render</h2>
            </div>

            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Escala clínica</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['norwood', 'ludwig'] as const).map(item => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={scale === item}
                    onClick={() => changeScale(item)}
                    className={`admin-focus-ring min-h-11 rounded-xl border text-sm font-semibold transition-colors ${
                      scale === item
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
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
                className="admin-focus-ring min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              >
                {stages.map(item => <option key={item} value={item}>{item}</option>)}
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
                    className={`admin-focus-ring min-h-10 rounded-lg border text-xs font-semibold transition-colors ${
                      density === item
                        ? 'border-gold-ink bg-gold/20 text-gold-ink'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="block">
              <span className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                Longitud <output>{lengthScale.toFixed(2)}×</output>
              </span>
              <input
                type="range"
                min="0.55"
                max="1.8"
                step="0.05"
                value={lengthScale}
                onChange={event => setLengthScale(Number(event.target.value))}
                className="w-full accent-[#b8944d]"
              />
            </label>

            <label className="block">
              <span className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                Brillo / rugosidad <output>{roughness.toFixed(2)}</output>
              </span>
              <input
                type="range"
                min="0.25"
                max="0.95"
                step="0.05"
                value={roughness}
                onChange={event => setRoughness(Number(event.target.value))}
                className="w-full accent-[#b8944d]"
              />
            </label>

            <label className="block">
              <span className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cabello recostado <output>{Math.round(layDown * 100)}%</output>
              </span>
              <input
                type="range"
                min="0.45"
                max="0.96"
                step="0.01"
                value={layDown}
                onChange={event => setLayDown(Number(event.target.value))}
                className="w-full accent-[#b8944d]"
              />
            </label>

            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Color</legend>
              <div className="flex flex-wrap items-center gap-2">
                {HAIR_COLORS.map(item => (
                  <button
                    key={item}
                    type="button"
                    aria-label={`Usar color ${item}`}
                    aria-pressed={color === item}
                    onClick={() => setColor(item)}
                    className={`admin-focus-ring h-9 w-9 rounded-full border-2 ${
                      color === item ? 'border-gold-ink ring-2 ring-gold/40' : 'border-white'
                    }`}
                    style={{ backgroundColor: item }}
                  />
                ))}
                <input
                  type="color"
                  aria-label="Color personalizado"
                  value={color}
                  onChange={event => setColor(event.target.value)}
                  className="admin-focus-ring h-9 w-12 cursor-pointer rounded-lg border border-slate-200 bg-white p-1"
                />
              </div>
            </fieldset>

            <dl className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs">
              <div>
                <dt className="text-slate-400">Hair cards</dt>
                <dd className="mt-1 font-semibold text-slate-700">{cardCount.toLocaleString('es-EC')}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Material</dt>
                <dd className="mt-1 font-semibold text-slate-700">PBR + alpha</dd>
              </div>
            </dl>
          </aside>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-slate-950/70 px-4 py-3 text-white">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gold">Vista en tiempo real</p>
                <p className="text-sm font-semibold">
                  {scale === 'norwood' ? 'Norwood' : 'Ludwig'} {stage} · Densidad {density.toLowerCase()}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-slate-200">
                <Rotate3D className="h-3.5 w-3.5" aria-hidden="true" />
                Rota y acerca para inspeccionar
              </span>
            </div>
            <div className="h-[560px] sm:h-[680px]">
              <Clinical3DViewer
                markers={[]}
                modelUrl="/models/clinical/male_head.glb"
                cameraPreset="scalp"
                readOnly
                height="100%"
                scalpHair={visualization}
              />
            </div>
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
