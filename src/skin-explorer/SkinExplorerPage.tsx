import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RotateCcw, ZoomIn, Layers3, ScanLine, CircleDashed, RotateCw,
  Microscope, X, ChevronRight, BookOpen, HelpCircle, CheckCircle, XCircle,
  Sparkles, Info, Beaker,
} from 'lucide-react';
import { SkinViewerEngine } from './SkinViewerEngine';
import type { Hotspot } from './skin-data';
import {
  SKIN_HOTSPOTS, SKIN_LAYERS, SKIN_CONDITIONS, SKIN_QUIZ,
  HOTSPOT_DETAILS, type SkinLayer,
} from './skin-data';

type Tab = 'capas' | 'condiciones' | 'quiz';
type ToolId = 'rotate' | 'zoom-in' | 'zoom-out' | 'isolate' | 'section' | 'layers' | 'reset';

export default function SkinExplorerPage() {
  const navigate = useNavigate();
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SkinViewerEngine | null>(null);

  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [tab, setTab] = useState<Tab>('capas');
  const [selectedLayer, setSelectedLayer] = useState<SkinLayer>(SKIN_LAYERS[0]);

  const [quizActive, setQuizActive] = useState(false);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizAnswer, setQuizAnswer] = useState<number | null>(null);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  // Mostrar loader sólo si la carga tarda más de 900ms
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => setSlowLoad(true), 900);
    return () => window.clearTimeout(t);
  }, [loading]);

  // Motor Three.js — importación estática, sin wrapper dinámico
  useEffect(() => {
    if (!mountRef.current) return;
    const engine = new SkinViewerEngine(mountRef.current, {
      onLoading: (isLoading, value) => {
        setLoading(isLoading);
        setProgress(value);
        if (isLoading) setSlowLoad(false);
      },
      onSelect: setSelected,
    });
    engineRef.current = engine;
    engine.loadSkin('/models/clinical/skin.glb', SKIN_HOTSPOTS).catch(() => setLoading(false));
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  useEffect(() => { engineRef.current?.setAutoRotate(autoRotate); }, [autoRotate]);

  const calloutCallback = useCallback((node: HTMLDivElement | null) => {
    engineRef.current?.attachCallout(node);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const layer = SKIN_LAYERS.find((l) => l.id === selected.id);
    if (layer) setSelectedLayer(layer);
  }, [selected]);

  const handleTool = (tool: ToolId) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (tool === 'rotate') { setAutoRotate((v) => !v); return; }
    if (tool === 'zoom-in') { engine.zoom(-1); return; }
    if (tool === 'zoom-out') { engine.zoom(1); return; }
    if (tool === 'reset') { engine.reset(); setActiveTool(null); return; }
    if (tool === 'isolate') { setActiveTool(engine.toggleIsolate() ? tool : null); return; }
    if (tool === 'section') { setActiveTool(engine.toggleCrossSection() ? tool : null); return; }
    if (tool === 'layers') { setActiveTool(engine.toggleLayers() ? tool : null); return; }
  };

  const startQuiz = () => {
    setQuizActive(true); setQuizIndex(0);
    setQuizAnswer(null); setQuizScore(0); setQuizFinished(false);
    setTab('quiz');
  };

  const handleQuizAnswer = (idx: number) => {
    if (quizAnswer !== null) return;
    setQuizAnswer(idx);
    if (idx === SKIN_QUIZ[quizIndex].correct) setQuizScore((s) => s + 1);
    setTimeout(() => {
      if (quizIndex + 1 >= SKIN_QUIZ.length) { setQuizFinished(true); return; }
      setQuizIndex((i) => i + 1);
      setQuizAnswer(null);
    }, 1800);
  };

  const tools: { id: ToolId; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
    { id: 'rotate', label: autoRotate ? 'Detener' : 'Girar', icon: autoRotate ? RotateCcw : RotateCw },
    { id: 'zoom-in', label: 'Acercar', icon: ZoomIn },
    { id: 'zoom-out', label: 'Alejar', icon: ZoomIn },
    { id: 'isolate', label: 'Aislar', icon: CircleDashed },
    { id: 'section', label: 'Sección', icon: ScanLine },
    { id: 'layers', label: 'Capas', icon: Layers3 },
    { id: 'reset', label: 'Reiniciar', icon: RotateCcw },
  ];

  const hotspotDetail = selected ? HOTSPOT_DETAILS[selected.id] : null;

  return (
    /* h-screen + overflow-hidden garantizan que el canvas tenga dimensiones reales */
    <div className="h-screen overflow-hidden flex flex-col bg-[#1a1210]">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/5 bg-[#1a1210]/80 backdrop-blur-sm z-20">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[#deb887] hover:text-white transition-colors text-sm"
        >
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Volver</span>
        </button>

        <div className="h-4 w-px bg-white/10 hidden sm:block" />

        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#deb887] flex items-center justify-center">
            <Microscope size={14} className="text-white" />
          </div>
          <div>
            <h1 className="text-white font-semibold text-sm leading-none" style={{ fontFamily: 'Playfair Display, serif' }}>
              DermoAtlas 3D
            </h1>
            <p className="text-white/40 text-[10px] mt-0.5">Explorador de la piel · Integumentum</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden md:flex items-center gap-1.5 text-white/30 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Modelo interactivo
          </span>
        </div>
      </header>

      {/* ── Workspace — min-h-0 es esencial para flex-1 en Chrome/Safari ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Sidebar izquierdo ──────────────────────────────────────── */}
        <aside className="w-64 xl:w-72 bg-[#120e0c] border-r border-white/5 flex flex-col overflow-y-auto flex-shrink-0">

          <div className="flex border-b border-white/5 flex-shrink-0">
            {(['capas', 'condiciones', 'quiz'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  tab === t
                    ? 'text-[#deb887] border-b-2 border-[#deb887] bg-[#deb887]/5'
                    : 'text-white/30 hover:text-white/60'
                }`}
              >
                {t === 'capas' ? 'Capas' : t === 'condiciones' ? 'Condiciones' : 'Quiz'}
              </button>
            ))}
          </div>

          {tab === 'capas' && (
            <div className="flex flex-col gap-1 p-3">
              <p className="text-white/30 text-[10px] uppercase tracking-widest px-1 mb-1">Estructura anatómica</p>
              {SKIN_LAYERS.map((layer) => (
                <button
                  key={layer.id}
                  onClick={() => setSelectedLayer(layer)}
                  className={`text-left rounded-lg px-3 py-2.5 transition-all ${
                    selectedLayer.id === layer.id ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                    <span className="text-white text-sm font-medium">{layer.name}</span>
                  </div>
                  <p className="text-white/40 text-[11px] mt-0.5 pl-[18px]">{layer.depth}</p>
                </button>
              ))}

              <div className="mt-3 rounded-xl p-3 bg-white/5 border space-y-3" style={{ borderColor: selectedLayer.color + '40' }}>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedLayer.color }} />
                  <span className="text-white font-semibold text-sm">{selectedLayer.name}</span>
                  <span className="text-white/30 text-xs ml-auto">{selectedLayer.depth}</span>
                </div>
                <p className="text-white/60 text-xs leading-relaxed">{selectedLayer.description}</p>
                <div>
                  <p className="text-white/30 text-[10px] uppercase tracking-wide mb-1.5">Componentes</p>
                  <ul className="space-y-1">
                    {selectedLayer.components.map((c) => (
                      <li key={c} className="flex items-start gap-1.5 text-white/50 text-xs">
                        <span style={{ color: selectedLayer.color }} className="mt-0.5 flex-shrink-0">◇</span>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg p-2.5 text-xs" style={{ backgroundColor: selectedLayer.color + '15', borderLeft: `2px solid ${selectedLayer.color}` }}>
                  <p className="text-white/40 uppercase tracking-wide text-[9px] mb-1.5">Tratamientos estéticos</p>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {selectedLayer.aesthetic.treatments.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: selectedLayer.color + '25', color: selectedLayer.color }}>
                        {t}
                      </span>
                    ))}
                  </div>
                  <p className="text-white/40 leading-relaxed">{selectedLayer.aesthetic.note}</p>
                </div>
              </div>

              <div className="mt-2">
                <p className="text-white/30 text-[10px] uppercase tracking-widest px-1 mb-1">Puntos activos</p>
                <div className="space-y-1">
                  {SKIN_HOTSPOTS.map((h) => (
                    <div key={h.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: h.color }} />
                      <span className="text-white/60 text-xs">{h.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'condiciones' && (
            <div className="p-3 space-y-2">
              <p className="text-white/30 text-[10px] uppercase tracking-widest px-1 mb-2">Condiciones dermatológicas</p>
              {SKIN_CONDITIONS.map((cond) => (
                <details key={cond.id} className="group rounded-lg bg-white/5">
                  <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer list-none">
                    <span className="text-lg w-6 flex-shrink-0 text-center">{cond.icon}</span>
                    <span className="text-white/80 text-sm font-medium">{cond.name}</span>
                    <ChevronRight size={13} className="ml-auto text-white/30 group-open:rotate-90 transition-transform" />
                  </summary>
                  <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
                    <p className="text-white/50 text-xs leading-relaxed">{cond.brief}</p>
                    <div>
                      <p className="text-white/25 text-[10px] uppercase tracking-wide mb-1">Tratamientos</p>
                      <div className="flex flex-wrap gap-1">
                        {cond.treatments.map((t) => (
                          <span key={t} className="px-2 py-0.5 rounded-full bg-[#deb887]/15 text-[#deb887] text-[10px]">{t}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}

          {tab === 'quiz' && (
            <div className="p-4 flex flex-col">
              {!quizActive && !quizFinished && (
                <div className="flex flex-col items-center justify-center gap-4 py-8">
                  <div className="w-16 h-16 rounded-2xl bg-[#deb887] flex items-center justify-center">
                    <HelpCircle size={28} className="text-white" />
                  </div>
                  <div className="text-center">
                    <h3 className="text-white font-semibold mb-1">Test de la Piel</h3>
                    <p className="text-white/40 text-xs">{SKIN_QUIZ.length} preguntas · Dermatología aplicada</p>
                  </div>
                  <button onClick={startQuiz} className="w-full py-2.5 bg-[#deb887] rounded-xl text-white font-semibold text-sm hover:bg-[#c9a96e] transition-colors">
                    Comenzar
                  </button>
                </div>
              )}

              {quizActive && !quizFinished && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-white/40 text-xs">Pregunta {quizIndex + 1}/{SKIN_QUIZ.length}</span>
                    <span className="text-[#deb887] text-xs font-semibold">{quizScore} pts</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1">
                    <div className="h-1 rounded-full bg-[#deb887] transition-all duration-500" style={{ width: `${(quizIndex / SKIN_QUIZ.length) * 100}%` }} />
                  </div>
                  <p className="text-white text-sm font-medium leading-relaxed">{SKIN_QUIZ[quizIndex].question}</p>
                  <div className="space-y-2">
                    {SKIN_QUIZ[quizIndex].options.map((opt, i) => {
                      const isCorrect = i === SKIN_QUIZ[quizIndex].correct;
                      const isSelected = i === quizAnswer;
                      let cls = 'w-full text-left px-3 py-2.5 rounded-lg text-sm border transition-all ';
                      if (quizAnswer === null) cls += 'border-white/10 text-white/70 hover:bg-white/10 hover:text-white';
                      else if (isCorrect) cls += 'border-emerald-500 bg-emerald-500/15 text-emerald-400';
                      else if (isSelected) cls += 'border-red-500 bg-red-500/15 text-red-400';
                      else cls += 'border-white/5 text-white/30';
                      return (
                        <button key={i} onClick={() => handleQuizAnswer(i)} className={cls} disabled={quizAnswer !== null}>
                          <span className="flex items-center gap-2">
                            {quizAnswer !== null && isCorrect && <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />}
                            {quizAnswer !== null && isSelected && !isCorrect && <XCircle size={14} className="text-red-400 flex-shrink-0" />}
                            {opt}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {quizAnswer !== null && (
                    <div className="rounded-lg bg-white/5 border border-white/10 p-3">
                      <p className="text-white/50 text-xs leading-relaxed">{SKIN_QUIZ[quizIndex].explanation}</p>
                    </div>
                  )}
                </div>
              )}

              {quizFinished && (
                <div className="flex flex-col items-center justify-center gap-4 py-6 text-center">
                  <div className="text-5xl">{quizScore >= 4 ? '🏆' : quizScore >= 2 ? '👍' : '📚'}</div>
                  <div>
                    <h3 className="text-white font-semibold text-lg">{quizScore}/{SKIN_QUIZ.length} correctas</h3>
                    <p className="text-white/40 text-xs mt-1">
                      {quizScore >= 4 ? 'Excelente dominio de dermatología' : quizScore >= 2 ? 'Buen avance. Sigue explorando' : 'Revisa las capas y vuelve a intentarlo'}
                    </p>
                  </div>
                  <button onClick={startQuiz} className="px-5 py-2 bg-[#deb887]/20 text-[#deb887] rounded-lg text-sm hover:bg-[#deb887]/30 transition-colors">
                    Repetir test
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>

        {/* ── Visor 3D — llena todo el espacio restante ──────────────── */}
        <section className="flex-1 relative overflow-hidden bg-[#1a1210]">
          {/* Canvas Three.js — absolute inset-0 dentro de relative con dimensiones reales */}
          <div ref={mountRef} className="absolute inset-0" />

          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-[#deb887]/4 blur-3xl" />
          </div>

          {/* Herramientas */}
          <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-10">
            {tools.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => handleTool(id)}
                title={label}
                aria-pressed={activeTool === id || (id === 'rotate' && autoRotate)}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all backdrop-blur-sm ${
                  activeTool === id || (id === 'rotate' && autoRotate)
                    ? 'bg-[#deb887] text-white shadow-lg shadow-[#deb887]/25'
                    : 'bg-black/40 text-white/50 hover:bg-black/60 hover:text-white border border-white/5'
                }`}
              >
                <Icon size={16} strokeWidth={1.5} />
              </button>
            ))}
          </div>

          {/* Caption */}
          <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
            <p className="text-white/20 text-[10px]">Modelo 3D · haz clic en un punto para explorar</p>
            <p className="text-white/10 text-[10px] font-mono italic">Integumentum — Piel humana</p>
          </div>

          <div className="absolute bottom-4 right-4 z-10 max-w-[160px] pointer-events-none">
            <div className="bg-black/40 backdrop-blur-sm border border-white/5 rounded-xl px-3 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles size={11} className="text-[#deb887]" />
                <span className="text-white/40 text-[10px] font-medium">Consejo</span>
              </div>
              <p className="text-white/30 text-[10px] leading-relaxed">
                Arrastra · Scroll para zoom · Toca un punto dorado para detalles
              </p>
            </div>
          </div>

          {/* Loader */}
          {loading && slowLoad && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-[#1a1210]/90 backdrop-blur-sm">
              <div className="w-14 h-14 rounded-2xl bg-[#deb887] flex items-center justify-center mb-4 animate-pulse">
                <Microscope size={28} className="text-white" />
              </div>
              <p className="text-white font-semibold text-sm mb-1" style={{ fontFamily: 'Playfair Display, serif' }}>
                Preparando el modelo
              </p>
              <p className="text-white/40 text-xs mb-5">Cargando estructura de la piel...</p>
              <div className="w-48 bg-white/10 rounded-full h-1.5">
                <div className="h-1.5 rounded-full bg-[#deb887] transition-all duration-300" style={{ width: `${Math.max(8, Math.round(progress * 100))}%` }} />
              </div>
              <p className="text-white/30 text-xs mt-2">{Math.max(8, Math.round(progress * 100))}%</p>
            </div>
          )}

          {/* Callout de hotspot */}
          {selected && (
            <div
              className="absolute top-0 left-0 z-10 pointer-events-none"
              ref={calloutCallback as React.RefCallback<HTMLDivElement>}
              style={{ transform: 'translate3d(-300px, -300px, 0)' }}
            >
              <div className="pointer-events-auto bg-black/85 backdrop-blur-sm border border-white/10 rounded-xl p-3 max-w-[200px] shadow-2xl">
                <button className="absolute top-2 right-2 text-white/30 hover:text-white transition-colors" onClick={() => engineRef.current?.clearSelection()}>
                  <X size={12} />
                </button>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selected.color }} />
                  <b className="text-white text-xs">{selected.label}</b>
                </div>
                <p className="text-white/50 text-[10px] leading-relaxed pr-4">{selected.detail}</p>
              </div>
            </div>
          )}

          <ul className="sr-only">
            {SKIN_HOTSPOTS.map((h) => <li key={h.id}>{h.label}: {h.detail}</li>)}
          </ul>
        </section>

        {/* ── Panel derecho ───────────────────────────────────────────── */}
        <aside className="w-72 xl:w-80 bg-[#120e0c] border-l border-white/5 flex flex-col overflow-y-auto flex-shrink-0">
          {selected && hotspotDetail ? (
            <div className="p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: hotspotDetail.color }} />
                <h2 className="text-white font-bold">{hotspotDetail.title}</h2>
                <button onClick={() => engineRef.current?.clearSelection()} className="ml-auto text-white/20 hover:text-white/60 transition-colors">
                  <X size={14} />
                </button>
              </div>
              <p className="text-white/40 text-xs italic">{hotspotDetail.subtitle}</p>
              <div>
                <p className="text-white/25 text-[10px] uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <Info size={10} /> Datos clave
                </p>
                <ul className="space-y-1.5">
                  {hotspotDetail.facts.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-white/60 text-xs leading-relaxed">
                      <span style={{ color: hotspotDetail.color }} className="mt-0.5 flex-shrink-0">◈</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ backgroundColor: hotspotDetail.color + '12', borderLeft: `2px solid ${hotspotDetail.color}` }}>
                <p className="uppercase tracking-widest text-[9px] flex items-center gap-1" style={{ color: hotspotDetail.color }}>
                  <Beaker size={10} /> Relevancia estética
                </p>
                <p className="text-white/50 leading-relaxed">{hotspotDetail.aestheticNote}</p>
              </div>
              <button onClick={() => engineRef.current?.clearSelection()} className="w-full py-2 rounded-lg text-xs text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors border border-white/5">
                ← Ver todos los puntos
              </button>
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div className="rounded-xl bg-[#deb887]/10 border border-[#deb887]/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <BookOpen size={14} className="text-[#deb887]" />
                  <span className="text-white font-semibold text-sm">Piel · Integumentum</span>
                </div>
                <p className="text-white/50 text-xs leading-relaxed">
                  El órgano más grande del cuerpo humano. Barrera viva que siente, protege y regula.
                  Explora sus capas tocando los puntos en el modelo.
                </p>
                <dl className="mt-3 space-y-1">
                  {[['Superficie', '~2 m²'], ['Peso', '3.5 – 5 kg'], ['Grosor', '0.5 – 4 mm'], ['Renovación', 'Cada 28 días']].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <dt className="text-white/30 text-[11px]">{k}</dt>
                      <dd className="text-white/60 text-[11px] font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div>
                <p className="text-white/25 text-[10px] uppercase tracking-widest mb-2">Capas de la piel</p>
                <div className="space-y-1.5">
                  {SKIN_LAYERS.map((layer) => (
                    <button key={layer.id} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left" onClick={() => { setSelectedLayer(layer); setTab('capas'); }}>
                      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                      <div className="min-w-0">
                        <p className="text-white/70 text-sm">{layer.name}</p>
                        <p className="text-white/25 text-[10px] truncate">{layer.aesthetic.treatments.slice(0, 2).join(', ')}</p>
                      </div>
                      <ChevronRight size={13} className="ml-auto text-white/20 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={startQuiz} className="w-full py-3 rounded-xl bg-[#deb887]/10 border border-[#deb887]/20 hover:border-[#deb887]/40 hover:bg-[#deb887]/15 transition-all text-left px-4 group">
                <div className="flex items-center gap-2">
                  <HelpCircle size={15} className="text-[#deb887]" />
                  <span className="text-white/70 text-sm group-hover:text-white transition-colors">Test de la Piel</span>
                  <ChevronRight size={13} className="ml-auto text-white/30 group-hover:text-[#deb887] transition-colors" />
                </div>
                <p className="text-white/30 text-xs mt-1 pl-6">{SKIN_QUIZ.length} preguntas · Dermatología aplicada</p>
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
