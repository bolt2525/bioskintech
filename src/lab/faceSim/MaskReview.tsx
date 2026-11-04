import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PersonalSurface } from './engine';
import type { PhotoSurfacePatch } from './multiViewHead';
import { calibrateProfileDepth, PROFILE_CALIBRATION, type ProfileCalibration } from './profileCalibration';

interface Props {
  surface: PersonalSurface;
  photo: HTMLCanvasElement;
  patches?: readonly PhotoSurfacePatch[];
  details: string;
  warnings: readonly string[];
  onCancel: () => void;
  onAccept: (positions: Float32Array, settings: ProfileCalibration) => Promise<void>;
}
const NO_PATCHES: readonly PhotoSurfacePatch[] = [];

/** Revisión sin GLB intermedios: el borrador actualiza el buffer, no la máscara aceptada. */
export default function MaskReview({ surface, photo, patches = NO_PATCHES, details, warnings, onCancel, onAccept }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const previewRef = useRef<{ update: (positions: Float32Array, textured: boolean) => void; view: (side: number) => void }>();
  const [settings, setSettings] = useState<ProfileCalibration>({});
  const [textured, setTextured] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const calibrated = useMemo(() => calibrateProfileDepth(surface.positions, surface.indices, settings), [surface, settings]);
  const changed = Object.values(settings).some(value => value !== 0);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#0f172a');
    renderer.setScissorTest(true);
    renderer.domElement.className = 'block h-full w-full touch-none';
    renderer.domElement.setAttribute('aria-label', 'Máscara generada y propuesta en 3D; arrastra para girar ambas');
    node.appendChild(renderer.domElement);
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const bounds = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(surface.positions, 3));
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 1.8;
    const camera = new THREE.PerspectiveCamera(35, 1, radius / 1000, radius * 30);
    camera.position.copy(center).add(new THREE.Vector3(0, 0, radius));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center); controls.enableDamping = true; controls.update();
    const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [], textures: THREE.Texture[] = [];
    const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
    const draft: THREE.BufferGeometry[] = [];
    scenes.forEach((scene, side) => {
      const add = (indices: Uint32Array, uvs: Float32Array, canvas: HTMLCanvasElement | null, alpha?: Float32Array) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions.slice(), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1)); geometry.computeVertexNormals();
        const map = canvas ? new THREE.CanvasTexture(canvas) : null;
        if (map) { map.flipY = false; map.colorSpace = THREE.SRGBColorSpace; textures.push(map); }
        const material = new THREE.MeshBasicMaterial({ map, color: canvas ? '#ffffff' : '#94a3b8',
          side: 'observedIndexCount' in surface && !alpha ? THREE.DoubleSide : THREE.FrontSide,
          transparent: !!alpha, depthWrite: !alpha, polygonOffset: !!alpha, polygonOffsetFactor: -2, polygonOffsetUnits: -1 });
        if (alpha) {
          geometry.setAttribute('color', new THREE.BufferAttribute(Float32Array.from({ length: alpha.length * 4 },
            (_, i) => i % 4 === 3 ? alpha[i >> 2] : 1), 4));
          material.vertexColors = true;
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.map = map; mesh.userData.patch = !!alpha;
        meshes.push(mesh); scene.add(mesh); geometries.push(geometry); materials.push(material);
        if (side === 1) draft.push(geometry);
      };
      const observed = 'observedIndexCount' in surface ? Number(surface.observedIndexCount) : surface.indices.length;
      add(surface.indices.slice(0, observed), surface.uvs, photo);
      if (observed < surface.indices.length) add(surface.indices.slice(observed), surface.uvs, null);
      patches.forEach(patch => add(patch.blendIndices?.length ? patch.blendIndices : patch.indices,
        patch.uvs, patch.source.texture, patch.alpha));
    });
    previewRef.current = {
      update: (positions, textured) => {
        draft.forEach(geometry => {
          (geometry.getAttribute('position').array as Float32Array).set(positions);
          geometry.getAttribute('position').needsUpdate = true; geometry.computeVertexNormals();
        });
        meshes.forEach(mesh => {
          mesh.visible = textured || !mesh.userData.patch;
          mesh.material.map = textured ? mesh.userData.map : null;
          mesh.material.color.set(textured ? mesh.userData.map ? '#ffffff' : '#94a3b8' : '#cbd5e1');
          mesh.material.wireframe = !textured; mesh.material.needsUpdate = true;
        });
        node.dataset.displacement = String(Math.max(...Array.from({ length: 468 }, (_, i) =>
          Math.abs(positions[i * 3 + 2] - surface.positions[i * 3 + 2]))));
      },
      view: side => { camera.position.copy(center).add(new THREE.Vector3(side * radius, 0, side ? 0 : radius)); controls.target.copy(center); controls.update(); },
    };
    const resize = () => renderer.setSize(node.clientWidth, node.clientHeight, false);
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw); controls.update();
      const width = node.clientWidth, height = node.clientHeight, half = Math.floor(width / 2);
      camera.aspect = half / height; camera.updateProjectionMatrix();
      scenes.forEach((scene, i) => {
        renderer.setViewport(i * half, 0, half, height); renderer.setScissor(i * half, 0, half, height);
        renderer.render(scene, camera);
      });
    };
    draw();
    return () => {
      previewRef.current = undefined; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); textures.forEach(item => item.dispose());
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [surface, photo, patches]);
  useEffect(() => {
    previewRef.current?.update(comparing ? surface.positions : calibrated.positions, textured);
  }, [calibrated, surface, comparing, textured]);
  const accept = async (original: boolean) => {
    setBusy(true); setError('');
    try { await onAccept(original ? surface.positions : calibrated.positions, original ? {} : settings); }
    catch (error) { setError(`No se pudo confirmar: ${error instanceof Error ? error.message : 'error desconocido'}. Tu máscara anterior no cambió.`); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onCancel(); }}
    aria-labelledby="mask-review-title" className="max-h-[96dvh] w-[min(96vw,1280px)] overflow-y-auto rounded-2xl bg-white p-4 text-slate-800 shadow-xl backdrop:bg-slate-950/75">
    <header className="flex items-center justify-between gap-3">
      <h2 id="mask-review-title" className="text-lg font-semibold">Revisar máscara antes de usarla</h2>
      <button type="button" disabled={busy} onClick={onCancel} className="admin-focus-ring min-h-11 rounded-lg border px-3">Cancelar</button>
    </header>
    <p className="my-2 text-sm">La generada es el punto de partida. Ajustar es opcional; nada cambia hasta confirmar.</p>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <section className="sticky top-0 z-10 min-w-0 self-start overflow-hidden rounded-xl bg-slate-900 text-white lg:static" aria-label="Comparación de máscara preliminar">
        <div className="grid grid-cols-2 text-center text-xs font-semibold"><h3 className="p-2">Generada · original</h3><h3 className="border-l border-slate-600 p-2">Propuesta · {comparing ? 'sin ajustes' : 'en vivo'}</h3></div>
        <div ref={host} data-testid="mask-review-preview" className="h-[min(30dvh,300px)] min-h-[210px] lg:h-[min(52dvh,520px)] lg:min-h-[260px]" />
        <div className="flex flex-wrap gap-2 p-2">
          {[[0, 'Frente'], [-1, 'Perfil A'], [1, 'Perfil B']].map(([side, label]) => <button key={label} type="button"
            className="admin-focus-ring min-h-11 rounded border border-slate-600 px-3 text-xs" onClick={() => previewRef.current?.view(Number(side))}>{label}</button>)}
          <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={textured} onChange={event => setTextured(event.target.checked)} />Mostrar fotografía</label>
        </div>
      </section>
      <section className="space-y-2" aria-label="Ajuste opcional del perfil">
        <h3 className="font-semibold">Ajustar perfil (opcional)</h3>
        <p className="text-xs text-slate-600">− hacia atrás · + hacia delante</p>
        {PROFILE_CALIBRATION.map(control => <label key={control.id} className="block text-xs">{control.label} · {Math.round((settings[control.id] ?? 0) * 1000) / 10} %
          <input aria-label={`Ajuste de perfil ${control.label}`} type="range" min={-0.08} max={0.08} step={0.0025}
            value={settings[control.id] ?? 0} disabled={busy}
            onChange={event => { setSettings(current => ({ ...current, [control.id]: Number(event.target.value) })); setComparing(false); }}
            className="admin-focus-ring block min-h-8 w-full scroll-mt-[calc(30dvh+8rem)] accent-sky-700 lg:scroll-mt-0" /></label>)}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !changed} aria-pressed={comparing} onClick={() => setComparing(value => !value)}
            className="admin-focus-ring min-h-11 rounded-lg border px-3 text-xs">{comparing ? 'Ver ajustes' : 'Comparar sin ajustes'}</button>
          <button type="button" disabled={busy || !changed} onClick={() => { setSettings({}); setComparing(false); }} className="admin-focus-ring min-h-11 rounded-lg border px-3 text-xs">Restablecer</button>
        </div>
        {calibrated.gain < 0.999 && <p role="status" className="text-xs font-semibold text-amber-900">Ajuste reducido para evitar pliegues en la superficie.</p>}
      </section>
    </div>
    {warnings.map(warning => <p role="status" key={warning} className="my-2 text-xs font-semibold text-amber-900">{warning}</p>)}
    <p className="my-3 text-xs font-semibold text-amber-900">Es una aproximación visual, no un escaneo ni un resultado clínico. Las fotos no reconstruyen el interior de las fosas ni zonas ocultas.</p>
    <details className="my-2 rounded-lg border p-2 text-xs"><summary className="admin-focus-ring cursor-pointer font-semibold">Calidad, referencias y límites</summary><p className="mt-2">{details}</p><p className="mt-2">Los ajustes cambian profundidad, no la fotografía ni las dosis. La protección evita inversiones locales, no certifica ausencia de autointersecciones.</p></details>
    {error && <p role="alert" className="my-2 text-sm text-red-800">{error}</p>}
    <footer className="flex flex-wrap justify-end gap-2">
      <button type="button" disabled={busy} onClick={() => void accept(true)} className="admin-focus-ring min-h-11 rounded-lg bg-slate-900 px-4 font-semibold text-white disabled:opacity-40">{busy ? 'Preparando…' : 'Usar generada sin ajustes'}</button>
      <button type="button" disabled={busy || !changed} onClick={() => void accept(false)} className="admin-focus-ring min-h-11 rounded-lg border border-sky-800 px-4 font-semibold text-sky-900 disabled:opacity-40">Confirmar propuesta ajustada</button>
    </footer>
  </dialog>;
}
