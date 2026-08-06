import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RotateCcw, ZoomIn, Layers3, ScanLine, CircleDashed, RotateCw,
  Microscope, X, ChevronRight, BookOpen, HelpCircle, CheckCircle, XCircle,
  Sparkles, Info, Beaker, Menu,
} from 'lucide-react';
import { SkinCanvas, type SkinCanvasHandle } from './SkinCanvas';
import type { Hotspot } from './skin-data';
import {
  SKIN_HOTSPOTS, SKIN_LAYERS, SKIN_CONDITIONS, SKIN_QUIZ,
  HOTSPOT_DETAILS, type SkinLayer,
} from './skin-data';

type Tab = 'capas' | 'condiciones' | 'quiz';
const LINE = 'rgba(117,91,70,0.18)';

export default function SkinExplorerPage() {
  const navigate = useNavigate();
  const canvasRef = useRef<SkinCanvasHandle>(null);

  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [calloutPos, setCalloutPos] = useState<{ x: number; y: number } | null>(null);
  const [tab, setTab] = useState<Tab>('capas');
  const [selectedLayer, setSelectedLayer] = useState<SkinLayer>(SKIN_LAYERS[0]);
  const [mobileOpen, setMobileOpen] = useState(false);

  const [quizActive, setQuizActive] = useState(false);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizAnswer, setQuizAnswer] = useState<number | null>(null);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  // Sync capa con hotspot seleccionado
  useEffect(() => {
    if (!selected) return;
    const layer = SKIN_LAYERS.find((l) => l.id === selected.id);
    if (layer) setSelectedLayer(layer);
  }, [selected]);

  // Callout position — calculado frame a frame
  useEffect(() => {
    if (!selected) { setCalloutPos(null); return; }
    let raf: number;
    const update = () => {
      const pos = canvasRef.current?.getHotspotScreenPos(selected.id);
      setCalloutPos(pos ?? null);
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [selected]);

  const handleTool = (tool: string) => {
    if (tool === 'rotate') { setAutoRotate((v) => !v); return; }
    if (tool === 'zoom-in') { canvasRef.current?.zoom(-1); return; }
    if (tool === 'zoom-out') { canvasRef.current?.zoom(1); return; }
    if (tool === 'reset') { canvasRef.current?.reset(); setSelected(null); setActiveTool(null); return; }
    if (tool === 'isolate') { setActiveTool(canvasRef.current?.toggleIsolate() ? tool : null); return; }
    if (tool === 'section') { setActiveTool(canvasRef.current?.toggleCrossSection() ? tool : null); return; }
    if (tool === 'layers') { setActiveTool(canvasRef.current?.toggleLayers() ? tool : null); return; }
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
      setQuizIndex((i) => i + 1); setQuizAnswer(null);
    }, 1800);
  };

  const tools = [
    { id: 'rotate',   label: autoRotate ? 'Detener' : 'Girar', icon: autoRotate ? RotateCcw : RotateCw },
    { id: 'zoom-in',  label: 'Acercar',  icon: ZoomIn },
    { id: 'zoom-out', label: 'Alejar',   icon: ZoomIn },
    { id: 'isolate',  label: 'Aislar',   icon: CircleDashed },
    { id: 'section',  label: 'Sección',  icon: ScanLine },
    { id: 'layers',   label: 'Capas',    icon: Layers3 },
    { id: 'reset',    label: 'Reiniciar', icon: RotateCcw },
  ] as const;

  const hotspotDetail = selected ? HOTSPOT_DETAILS[selected.id] : null;

  // ── Contenido de tabs (reutilizado en desktop y mobile drawer) ──

  const TabsNav = ({ compact = false }: { compact?: boolean }) => (
    <div className={`flex flex-shrink-0 border-b ${compact ? 'px-2' : ''}`} style={{ borderColor: LINE }}>
      {(['capas', 'condiciones', 'quiz'] as Tab[]).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
            tab === t ? 'text-[#deb887] border-b-2 border-[#deb887]' : 'text-[#8d847c] hover:text-[#5a4e46]'
          }`}
        >
          {t === 'capas' ? 'Capas' : t === 'condiciones' ? 'Cond.' : 'Quiz'}
        </button>
      ))}
    </div>
  );

  const TabContent = () => (
    <>
      {tab === 'capas' && (
        <div className="flex flex-col gap-1 p-3">
          <p className="text-[10px] uppercase tracking-widest text-[#8d847c] font-semibold px-1 mb-1">Estructura anatómica</p>
          {SKIN_LAYERS.map((layer) => (
            <button
              key={layer.id}
              onClick={() => setSelectedLayer(layer)}
              className={`text-left rounded-xl px-3 py-2.5 transition-all border ${
                selectedLayer.id === layer.id ? 'bg-[#fdf5ea] border-[#deb887]/40' : 'border-transparent hover:bg-[#f7efe4]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                <span className="text-[#2f2a27] text-sm font-medium">{layer.name}</span>
              </div>
              <p className="text-[#8d847c] text-[11px] mt-0.5 pl-[18px]">{layer.depth}</p>
            </button>
          ))}
          <div className="mt-3 rounded-xl p-3 border space-y-3" style={{ backgroundColor: 'rgba(255,251,244,0.8)', borderColor: selectedLayer.color + '40' }}>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedLayer.color }} />
              <span className="text-[#2f2a27] font-semibold text-sm">{selectedLayer.name}</span>
              <span className="text-[#8d847c] text-xs ml-auto">{selectedLayer.depth}</span>
            </div>
            <p className="text-[#5a4e46] text-xs leading-relaxed">{selectedLayer.description}</p>
            <div>
              <p className="text-[#8d847c] text-[10px] uppercase tracking-wide mb-1.5">Componentes</p>
              <ul className="space-y-1">
                {selectedLayer.components.map((c) => (
                  <li key={c} className="flex items-start gap-1.5 text-[#6b5e55] text-xs">
                    <span style={{ color: selectedLayer.color }} className="mt-0.5 flex-shrink-0">◇</span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg p-2.5 text-xs" style={{ backgroundColor: selectedLayer.color + '15', borderLeft: `2px solid ${selectedLayer.color}` }}>
              <p className="text-[#8d847c] uppercase tracking-wide text-[9px] mb-1.5">Tratamientos estéticos</p>
              <div className="flex flex-wrap gap-1 mb-2">
                {selectedLayer.aesthetic.treatments.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: selectedLayer.color + '25', color: selectedLayer.color }}>{t}</span>
                ))}
              </div>
              <p className="text-[#6b5e55] leading-relaxed">{selectedLayer.aesthetic.note}</p>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-[10px] uppercase tracking-widest text-[#8d847c] font-semibold px-1 mb-1">Puntos activos</p>
            <div className="space-y-0.5">
              {SKIN_HOTSPOTS.map((h) => (
                <div key={h.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#f7efe4] transition-colors cursor-pointer" onClick={() => setSelected(selected?.id === h.id ? null : h)}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: h.color }} />
                  <span className="text-[#5a4e46] text-xs">{h.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'condiciones' && (
        <div className="p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-[#8d847c] font-semibold px-1 mb-2">Condiciones dermatológicas</p>
          {SKIN_CONDITIONS.map((cond) => (
            <details key={cond.id} className="group rounded-xl" style={{ border: `1px solid ${LINE}` }}>
              <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer list-none bg-[rgba(255,251,244,0.5)] hover:bg-[rgba(255,248,238,0.8)] rounded-xl transition-colors">
                <span className="text-lg w-6 flex-shrink-0 text-center">{cond.icon}</span>
                <span className="text-[#2f2a27] text-sm font-medium">{cond.name}</span>
                <ChevronRight size={13} className="ml-auto text-[#8d847c] group-open:rotate-90 transition-transform" />
              </summary>
              <div className="px-3 pb-3 space-y-2 pt-2">
                <p className="text-[#6b5e55] text-xs leading-relaxed">{cond.brief}</p>
                <div className="flex flex-wrap gap-1">
                  {cond.treatments.map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded-full bg-[#deb887]/15 text-[#b8903a] text-[10px]">{t}</span>
                  ))}
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      {tab === 'quiz' && (
        <div className="p-4">
          {!quizActive && !quizFinished && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="w-16 h-16 rounded-2xl bg-[#deb887] flex items-center justify-center shadow-lg shadow-[#deb887]/20">
                <HelpCircle size={28} className="text-white" />
              </div>
              <div className="text-center">
                <h3 className="text-[#2f2a27] font-semibold mb-1" style={{ fontFamily: 'Playfair Display, serif' }}>Test de la Piel</h3>
                <p className="text-[#8d847c] text-xs">{SKIN_QUIZ.length} preguntas · Dermatología aplicada</p>
              </div>
              <button onClick={startQuiz} className="w-full py-2.5 bg-[#deb887] rounded-xl text-white font-semibold text-sm hover:bg-[#c9a96e] transition-colors">Comenzar</button>
            </div>
          )}
          {quizActive && !quizFinished && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[#8d847c] text-xs">Pregunta {quizIndex + 1}/{SKIN_QUIZ.length}</span>
                <span className="text-[#deb887] text-xs font-semibold">{quizScore} pts</span>
              </div>
              <div className="w-full rounded-full h-1" style={{ backgroundColor: LINE }}>
                <div className="h-1 rounded-full bg-[#deb887] transition-all" style={{ width: `${(quizIndex / SKIN_QUIZ.length) * 100}%` }} />
              </div>
              <p className="text-[#2f2a27] text-sm font-medium leading-relaxed">{SKIN_QUIZ[quizIndex].question}</p>
              <div className="space-y-2">
                {SKIN_QUIZ[quizIndex].options.map((opt, i) => {
                  const isCorrect = i === SKIN_QUIZ[quizIndex].correct;
                  const isSelected = i === quizAnswer;
                  let cls = 'w-full text-left px-3 py-2.5 rounded-xl text-sm border transition-all ';
                  if (quizAnswer === null) cls += 'border-[rgba(117,91,70,0.2)] text-[#5a4e46] hover:bg-[#fdf5ea]';
                  else if (isCorrect) cls += 'border-emerald-400 bg-emerald-50 text-emerald-700';
                  else if (isSelected) cls += 'border-red-300 bg-red-50 text-red-600';
                  else cls += 'border-[rgba(117,91,70,0.1)] text-[#8d847c]';
                  return (
                    <button key={i} onClick={() => handleQuizAnswer(i)} className={cls} disabled={quizAnswer !== null}>
                      <span className="flex items-center gap-2">
                        {quizAnswer !== null && isCorrect && <CheckCircle size={14} className="text-emerald-500 flex-shrink-0" />}
                        {quizAnswer !== null && isSelected && !isCorrect && <XCircle size={14} className="text-red-400 flex-shrink-0" />}
                        {opt}
                      </span>
                    </button>
                  );
                })}
              </div>
              {quizAnswer !== null && (
                <div className="rounded-xl bg-[#fdf5ea] border border-[#deb887]/30 p-3">
                  <p className="text-[#6b5e55] text-xs leading-relaxed">{SKIN_QUIZ[quizIndex].explanation}</p>
                </div>
              )}
            </div>
          )}
          {quizFinished && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="text-5xl">{quizScore >= 4 ? '🏆' : quizScore >= 2 ? '👍' : '📚'}</div>
              <div>
                <h3 className="text-[#2f2a27] font-semibold text-lg">{quizScore}/{SKIN_QUIZ.length} correctas</h3>
                <p className="text-[#8d847c] text-xs mt-1">{quizScore >= 4 ? 'Excelente dominio' : quizScore >= 2 ? 'Buen avance' : 'Sigue explorando'}</p>
              </div>
              <button onClick={startQuiz} className="px-5 py-2 bg-[#deb887]/20 text-[#b8903a] rounded-lg text-sm hover:bg-[#deb887]/30 transition-colors">Repetir</button>
            </div>
          )}
        </div>
      )}
    </>
  );

  const RightPanelContent = () => (
    <>
      {selected && hotspotDetail ? (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: hotspotDetail.color }} />
            <h2 className="text-[#2f2a27] font-bold" style={{ fontFamily: 'Playfair Display, serif' }}>{hotspotDetail.title}</h2>
            <button onClick={() => setSelected(null)} className="ml-auto text-[#8d847c] hover:text-[#2f2a27] transition-colors"><X size={14} /></button>
          </div>
          <p className="text-[#8d847c] text-xs italic">{hotspotDetail.subtitle}</p>
          <div>
            <p className="text-[#8d847c] text-[10px] uppercase tracking-widest mb-2 flex items-center gap-1.5 font-semibold"><Info size={10} /> Datos clave</p>
            <ul className="space-y-1.5">
              {hotspotDetail.facts.map((f) => (
                <li key={f} className="flex items-start gap-2 text-[#5a4e46] text-xs leading-relaxed">
                  <span style={{ color: hotspotDetail.color }} className="mt-0.5 flex-shrink-0">◈</span>{f}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ backgroundColor: hotspotDetail.color + '12', borderLeft: `2px solid ${hotspotDetail.color}` }}>
            <p className="uppercase tracking-widest text-[9px] flex items-center gap-1 font-semibold" style={{ color: hotspotDetail.color }}><Beaker size={10} /> Relevancia estética</p>
            <p className="text-[#6b5e55] leading-relaxed">{hotspotDetail.aestheticNote}</p>
          </div>
          <button onClick={() => setSelected(null)} className="w-full py-2 rounded-lg text-xs text-[#8d847c] hover:text-[#2f2a27] hover:bg-[#f7efe4] transition-colors border border-[rgba(117,91,70,0.15)]">← Ver todos los puntos</button>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          <div className="rounded-xl p-4 border border-[#deb887]/30 bg-[#fdf5ea]">
            <div className="flex items-center gap-2 mb-2">
              <BookOpen size={14} className="text-[#deb887]" />
              <span className="text-[#2f2a27] font-semibold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>Piel · Integumentum</span>
            </div>
            <p className="text-[#6b5e55] text-xs leading-relaxed">El órgano más grande del cuerpo. Toca los puntos de colores en el modelo 3D para explorar sus estructuras anatómicas.</p>
            <dl className="mt-3 space-y-1">
              {[['Superficie', '~2 m²'], ['Peso', '3.5 – 5 kg'], ['Grosor', '0.5 – 4 mm'], ['Renovación', 'Cada 28 días']].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <dt className="text-[#8d847c] text-[11px]">{k}</dt>
                  <dd className="text-[#5a4e46] text-[11px] font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[#8d847c] font-semibold mb-2">Capas de la piel</p>
            <div className="space-y-1">
              {SKIN_LAYERS.map((layer) => (
                <button key={layer.id} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#f7efe4] transition-colors text-left border border-transparent hover:border-[#deb887]/20" onClick={() => { setSelectedLayer(layer); setTab('capas'); }}>
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                  <div className="min-w-0">
                    <p className="text-[#2f2a27] text-sm">{layer.name}</p>
                    <p className="text-[#8d847c] text-[10px] truncate">{layer.aesthetic.treatments.slice(0, 2).join(', ')}</p>
                  </div>
                  <ChevronRight size={13} className="ml-auto text-[#8d847c] flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>
          <button onClick={startQuiz} className="w-full py-3 rounded-xl border border-[#deb887]/30 bg-[#fdf5ea] hover:bg-[#fbecd6] hover:border-[#deb887]/50 transition-all text-left px-4 group">
            <div className="flex items-center gap-2">
              <HelpCircle size={15} className="text-[#deb887]" />
              <span className="text-[#5a4e46] text-sm group-hover:text-[#2f2a27] transition-colors">Test de la Piel</span>
              <ChevronRight size={13} className="ml-auto text-[#8d847c] group-hover:text-[#deb887] transition-colors" />
            </div>
            <p className="text-[#8d847c] text-xs mt-1 pl-6">{SKIN_QUIZ.length} preguntas · Dermatología aplicada</p>
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="h-screen overflow-hidden flex flex-col" style={{ background: '#f2e9dd' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b bg-white/80 backdrop-blur-sm z-20" style={{ borderColor: LINE }}>
        <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-[#deb887] hover:text-[#2f2a27] transition-colors text-sm font-medium">
          <ArrowLeft size={16} /><span className="hidden sm:inline">Volver</span>
        </button>
        <div className="h-4 w-px hidden sm:block" style={{ backgroundColor: LINE }} />
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#deb887] flex items-center justify-center shadow-sm shadow-[#deb887]/30">
            <Microscope size={16} className="text-white" />
          </div>
          <div>
            <h1 className="text-[#2f2a27] font-semibold text-sm leading-none" style={{ fontFamily: 'Playfair Display, serif' }}>DermoAtlas 3D</h1>
            <p className="text-[#8d847c] text-[10px] mt-0.5">Explorador de la piel · Integumentum</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden md:flex items-center gap-1.5 text-[#8d847c] text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Modelo interactivo
          </span>
          <button className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#deb887] text-white text-xs font-semibold" onClick={() => setMobileOpen(true)}>
            <Menu size={14} /> Info
          </button>
        </div>
      </header>

      {/* ── Workspace ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Sidebar izquierdo */}
        <aside className="hidden lg:flex flex-col w-64 xl:w-72 flex-shrink-0 overflow-y-auto bg-white/70 backdrop-blur-sm border-r" style={{ borderColor: LINE }}>
          <TabsNav />
          <TabContent />
        </aside>

        {/* Visor 3D */}
        <section className="flex-1 relative overflow-hidden">
          <SkinCanvas
            ref={canvasRef}
            hotspots={SKIN_HOTSPOTS}
            selected={selected}
            onSelect={setSelected}
            autoRotate={autoRotate}
            onInteraction={() => setAutoRotate(false)}
          />

          {/* Herramientas desktop — con estado activo */}
          <div className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 flex-col gap-1.5 z-10 rounded-2xl p-1.5 backdrop-blur-lg" style={{ background: 'rgba(253,250,244,0.88)', border: `1px solid ${LINE}`, boxShadow: '0 8px 24px rgba(75,54,40,0.08)' }}>
            {tools.map(({ id, label, icon: Icon }) => {
              const isActive = activeTool === id || (id === 'rotate' && autoRotate);
              return (
                <button key={id} onClick={() => handleTool(id)} title={label}
                  className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center gap-1 transition-all text-[9px] font-semibold ${
                    isActive ? 'bg-[#deb887]/15 text-[#b8903a]' : 'text-[#8d847c] hover:bg-[#f7efe4] hover:text-[#5a4e46]'
                  }`}>
                  <Icon size={18} strokeWidth={1.6} />
                  <span className="hidden xl:block">{label}</span>
                </button>
              );
            })}
          </div>

          {/* Herramientas mobile (fila horizontal abajo) */}
          <div className="md:hidden absolute bottom-2 left-2 right-2 z-10 flex justify-around rounded-2xl p-1" style={{ background: 'rgba(253,250,244,0.92)', border: `1px solid ${LINE}`, boxShadow: '0 8px 24px rgba(75,54,40,0.1)' }}>
            {tools.map(({ id, label, icon: Icon }) => {
              const isActive = activeTool === id || (id === 'rotate' && autoRotate);
              return (
                <button key={id} onClick={() => handleTool(id)} title={label}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                    isActive ? 'bg-[#deb887]/15 text-[#b8903a]' : 'text-[#8d847c] hover:bg-[#f7efe4]'
                  }`}>
                  <Icon size={18} strokeWidth={1.6} />
                </button>
              );
            })}
          </div>

          {/* Callout hotspot — posicionado sobre el punto en 3D */}
          {selected && calloutPos && (
            <div
              className="absolute z-20 pointer-events-none"
              style={{ left: calloutPos.x, top: calloutPos.y, transform: 'translate(-50%, -130%)', willChange: 'transform' }}
            >
              <div className="rounded-xl px-3 py-2 shadow-xl max-w-[185px] text-xs" style={{ background: 'rgba(255,252,247,0.96)', backdropFilter: 'blur(10px)', border: `1px solid ${LINE}` }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: selected.color }} />
                  <b className="text-[#2f2a27]" style={{ fontFamily: 'Playfair Display, serif' }}>{selected.label}</b>
                </div>
                <p className="text-[#8d847c] leading-relaxed">{selected.detail}</p>
              </div>
              {/* Flecha hacia abajo */}
              <div className="flex justify-center mt-0.5">
                <div className="w-2 h-2 rotate-45" style={{ background: 'rgba(255,252,247,0.96)', borderRight: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}` }} />
              </div>
            </div>
          )}

          {/* Auto-rotate toggle desktop */}
          <div className="hidden md:flex absolute right-5 bottom-5 z-10 items-center gap-2 rounded-xl px-3 py-2 text-[10px] font-medium cursor-pointer select-none" style={{ background: 'rgba(253,252,247,0.88)', border: `1px solid ${LINE}`, boxShadow: '0 4px 12px rgba(65,45,32,0.08)' }} onClick={() => setAutoRotate((v) => !v)}>
            <RotateCcw size={13} className="text-[#8d847c]" />
            <span className="text-[#5a4e46]">Auto rotar</span>
            <span className={`w-7 h-4 rounded-full flex items-center px-0.5 transition-colors ${autoRotate ? 'bg-[#70a9cb] justify-end' : 'bg-[#c8c2bb] justify-start'}`}>
              <span className="w-3 h-3 rounded-full bg-white shadow" />
            </span>
          </div>

          {/* Sticky note tip */}
          <div className="hidden lg:block absolute right-5 top-5 z-10 w-36 rotate-[-3deg]" style={{ background: '#fff2c9', padding: '12px 14px', boxShadow: '0 5px 12px rgba(93,69,43,0.12)', color: '#534a43' }}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles size={12} className="text-[#8d6bcc]" />
              <span className="text-[11px] italic text-[#8d6bcc]" style={{ fontFamily: 'Comic Sans MS, cursive' }}>Consejo</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ fontFamily: 'Playfair Display, serif', fontWeight: 500 }}>
              Arrastra · Zoom · Toca un punto para explorar
            </p>
          </div>

          {/* Caption */}
          <div className="absolute left-4 bottom-5 z-10 pointer-events-none hidden md:block">
            <p className="text-[#8d847c] text-[9px] uppercase tracking-widest">Modelo 3D · haz clic en un punto para explorar</p>
            <p className="text-[#b0a89e] text-[10px] font-medium italic mt-0.5">Integumentum · Piel humana</p>
          </div>
        </section>

        {/* Panel derecho desktop */}
        <aside className="hidden lg:flex flex-col w-72 xl:w-80 flex-shrink-0 overflow-y-auto bg-white/70 backdrop-blur-sm border-l" style={{ borderColor: LINE }}>
          <RightPanelContent />
        </aside>
      </div>

      {/* ── Drawer mobile ─────────────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(52,39,30,0.24)', backdropFilter: 'blur(5px)' }} onClick={() => setMobileOpen(false)}>
          <div className="rounded-t-3xl max-h-[76vh] overflow-hidden flex flex-col" style={{ background: '#fffaf3', boxShadow: '0 -20px 60px rgba(64,43,29,0.18)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-center pt-2.5 pb-1 flex-shrink-0"><div className="w-10 h-1 rounded-full bg-[#c8b8a2]" /></div>
            <div className="flex items-center flex-shrink-0 border-b px-2" style={{ borderColor: LINE }}>
              <div className="flex flex-1">{(['capas', 'condiciones', 'quiz'] as Tab[]).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors ${tab === t ? 'text-[#deb887] border-b-2 border-[#deb887]' : 'text-[#8d847c]'}`}>
                  {t === 'capas' ? 'Capas' : t === 'condiciones' ? 'Cond.' : 'Quiz'}
                </button>
              ))}</div>
              <button onClick={() => setMobileOpen(false)} className="p-2 text-[#8d847c]"><X size={18} /></button>
            </div>
            {selected && hotspotDetail && (
              <div className="px-4 py-3 flex-shrink-0 border-b" style={{ borderColor: LINE, backgroundColor: '#fdf5ea' }}>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: hotspotDetail.color }} />
                  <span className="text-[#2f2a27] font-semibold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>{hotspotDetail.title}</span>
                  <button onClick={() => setSelected(null)} className="ml-auto text-[#8d847c]"><X size={12} /></button>
                </div>
                <p className="text-[#6b5e55] text-xs mt-1 leading-relaxed">{hotspotDetail.aestheticNote}</p>
              </div>
            )}
            <div className="overflow-y-auto flex-1"><TabContent /></div>
            {!selected && <div className="p-4 flex-shrink-0 border-t" style={{ borderColor: LINE }}><RightPanelContent /></div>}
          </div>
        </div>
      )}
    </div>
  );
}
