/**
 * SkinCanvas — Visor Three.js puro.
 * Herramientas completas: auto-rotate, zoom, aislar, sección transversal, capas, reiniciar.
 * Callout de hotspot + posición de pantalla expuesta para overlay HTML.
 * CSP fix: blob: en connect-src resuelve carga de texturas GLB embebidas.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Microscope } from 'lucide-react';
import type { Hotspot } from './skin-data';

const FIT_SIZE      = 3.8;
const CAMERA_POS    = { x: 0, y: 1.4, z: 11.0 };  // más atrás y alto → modelo más pequeño y centrado
const CAMERA_TARGET = { x: 0, y: 0.6, z: 0 };       // apunta más arriba → modelo sube en pantalla
const PLINTH_Y      = -2.5;
const DOT_SIZE      = 0.12;

type OnSelectFn = (h: Hotspot | null) => void;

class SkinRenderer {
  renderer: THREE.WebGLRenderer;
  scene    = new THREE.Scene();
  camera   = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  controls: OrbitControls;

  private frame    = 0;
  private disposed = false;
  private pivot: THREE.Group | null = null;
  private skinMeshes: THREE.Mesh[] = [];
  private dotMeshes: { mesh: THREE.Mesh; hotspot: Hotspot }[] = [];
  private hoveredId:  string | null = null;
  private selectedId: string | null = null;
  private onSelect: OnSelectFn;
  private dirty    = true;
  private container: HTMLElement;

  // Tool state
  private isolated     = false;
  private crossSection = false;
  private wireframe    = false;
  private clipPlane    = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

  constructor(container: HTMLElement, onSelect: OnSelectFn) {
    this.container = container;
    this.onSelect  = onSelect;

    const lowPower = (navigator.hardwareConcurrency ?? 8) < 6;
    this.renderer  = new THREE.WebGLRenderer({
      antialias: !lowPower,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2));
    this.renderer.outputColorSpace    = THREE.SRGBColorSpace;
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled   = false;
    this.renderer.localClippingEnabled = true;
    this.scene.background = new THREE.Color(0xf7f0e7);
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(CAMERA_POS.x, CAMERA_POS.y, CAMERA_POS.z);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping   = true;
    this.controls.dampingFactor   = 0.055;
    this.controls.enablePan       = false;
    this.controls.minDistance     = 5;
    this.controls.maxDistance     = 15;
    this.controls.autoRotate      = true;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.target.set(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z);
    this.controls.addEventListener('start', () => { this.dirty = true; });

    this.buildScene();
    this.resize();
    this.animate();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.renderer.domElement.addEventListener('click', this.onClick);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', () => {
      if (this.hoveredId) { this.hoveredId = null; this.renderer.domElement.style.cursor = ''; this.dirty = true; }
    });
  }

  // ── Escena ─────────────────────────────────────────────────────────────────

  private buildScene() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x444433, 0.6));

    const key = new THREE.DirectionalLight(0xfff3e7, 1.8);
    key.position.set(4.8, 6.5, 6.8);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xe6ecff, 0.7);
    fill.position.set(-4.5, 1.2, 5.2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffb7a5, 0.8);
    rim.position.set(-4, 3.5, -5.5);
    this.scene.add(rim);

    // Env map PMREM para materiales PBR
    const w = 16, h = 32;
    const data = new Uint8Array(w * h * 4);
    const top = new THREE.Color(0xfff3e4);
    const bot = new THREE.Color(0x6b4f45);
    const mix = new THREE.Color();
    for (let y = 0; y < h; y++) {
      mix.copy(bot).lerp(top, Math.pow(1 - y / (h - 1), 0.7));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = Math.round(mix.r * 255); data[i+1] = Math.round(mix.g * 255);
        data[i+2] = Math.round(mix.b * 255); data[i+3] = 255;
      }
    }
    const src = new THREE.DataTexture(data, w, h);
    src.mapping = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    src.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(src).texture;
    pmrem.dispose(); src.dispose();

    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 2.48, 0.34, 56),
      new THREE.MeshStandardMaterial({ color: 0xead7c1, roughness: 0.78, metalness: 0 }),
    );
    plinth.name = 'plinth';
    plinth.position.y = PLINTH_Y;
    this.scene.add(plinth);
  }

  // ── Carga del modelo ───────────────────────────────────────────────────────

  async loadSkin(url: string, hotspots: Hotspot[], onProgress: (n: number) => void) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    try {
      gltf = await loader.loadAsync(url, (evt) => {
        if (evt.total > 0) onProgress(evt.loaded / evt.total);
      });
    } catch (e) {
      console.error('GLTFLoader error:', e);
      return;
    }

    const model = gltf.scene;
    const box   = new THREE.Box3().setFromObject(model);
    const size  = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = FIT_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    model.scale.setScalar(s);
    model.position.copy(center.multiplyScalar(-s));

    const pivot = new THREE.Group();
    pivot.name = 'skin-pivot';
    pivot.add(model);
    pivot.rotation.set(0.05, -0.28, 0);
    this.scene.add(pivot);
    this.pivot = pivot;
    pivot.updateWorldMatrix(true, true);

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      this.skinMeshes.push(child);
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat: any) => {
        mat.metalness       = 0;
        mat.roughness       = 0.8;
        mat.envMapIntensity = 0.4;
        if (mat.map) { mat.map.colorSpace = THREE.SRGBColorSpace; mat.map.needsUpdate = true; }
        mat.needsUpdate = true;
      });
    });

    this.addHotspots(hotspots, pivot);
    onProgress(1);
    this.dirty = true;
  }

  // ── Hotspot dots ───────────────────────────────────────────────────────────

  private addHotspots(hotspots: Hotspot[], pivot: THREE.Group) {
    hotspots.forEach((h) => {
      const geo  = new THREE.SphereGeometry(DOT_SIZE, 20, 20);
      const mat  = new THREE.MeshBasicMaterial({ color: h.color, depthTest: false, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...(h.position as [number, number, number]));
      mesh.renderOrder = 10;
      mesh.userData = { hotspotId: h.id };
      pivot.add(mesh);
      this.dotMeshes.push({ mesh, hotspot: h });
    });
  }

  /** Proyecta un hotspot a coordenadas de pantalla para posicionar el callout HTML */
  getHotspotScreenPos(id: string): { x: number; y: number } | null {
    const entry = this.dotMeshes.find(d => d.hotspot.id === id);
    if (!entry) return null;
    const world = new THREE.Vector3();
    entry.mesh.getWorldPosition(world);
    const projected = world.project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return {
      x: (projected.x * 0.5 + 0.5) * w,
      y: (-projected.y * 0.5 + 0.5) * h,
    };
  }

  // ── Interacción ────────────────────────────────────────────────────────────

  private getCanvasNDC(event: MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) / r.width) * 2 - 1,
      y: -((event.clientY - r.top) / r.height) * 2 + 1,
    };
  }

  private pickDot(event: MouseEvent) {
    const { x, y } = this.getCanvasNDC(event);
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x, y }, this.camera);
    const hits = ray.intersectObjects(this.dotMeshes.map(d => d.mesh));
    return hits.length ? this.dotMeshes.find(d => d.mesh === hits[0].object) ?? null : null;
  }

  private onClick = (event: MouseEvent) => {
    const dot = this.pickDot(event);
    const id  = dot?.hotspot.id ?? null;
    if (id !== null && id === this.selectedId) {
      this.selectedId = null; this.onSelect(null);
    } else {
      this.selectedId = id; this.onSelect(dot?.hotspot ?? null);
    }
    this.dirty = true;
  };

  private onPointerMove = (event: MouseEvent) => {
    const dot = this.pickDot(event);
    const id  = dot?.hotspot.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
      this.dirty = true;
    }
  };

  // ── Loop ───────────────────────────────────────────────────────────────────

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    if (this.disposed) return;
    if (this.controls.update()) this.dirty = true;
    if (this.dotMeshes.length) {
      const t = performance.now() / 1000;
      this.dotMeshes.forEach(({ mesh, hotspot }) => {
        const sel  = hotspot.id === this.selectedId;
        const hov  = hotspot.id === this.hoveredId;
        const mat  = mesh.material as THREE.MeshBasicMaterial;
        mesh.scale.setScalar(hov ? 1.4 : sel ? 1 + Math.sin(t * 3.5) * 0.18 : 1);
        mat.opacity = hov || sel ? 1 : 0.9;
      });
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.dirty = true;
  }

  // ── Herramientas ───────────────────────────────────────────────────────────

  setAutoRotate(v: boolean) {
    this.controls.autoRotate = v;
    this.dirty = true;
  }

  zoom(dir: 1 | -1) {
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z + dir * 1.2, 5, 15);
    this.dirty = true;
  }

  reset() {
    const sp = this.camera.position.clone();
    const ep = new THREE.Vector3(CAMERA_POS.x, CAMERA_POS.y, CAMERA_POS.z);
    const st = this.controls.target.clone();
    const et = new THREE.Vector3(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z);
    const t0 = performance.now();
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - t0) / 800, 1);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(sp, ep, e);
      this.controls.target.lerpVectors(st, et, e);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);
  }

  toggleIsolate() {
    this.isolated = !this.isolated;
    const plinth = this.scene.getObjectByName('plinth') as THREE.Mesh | undefined;
    if (plinth) {
      const mat = plinth.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      // Animate opacity in the animate loop isn't practical — just jump
      mat.opacity = this.isolated ? 0.1 : 1;
      mat.needsUpdate = true;
    }
    this.dirty = true;
    return this.isolated;
  }

  toggleCrossSection() {
    this.crossSection = !this.crossSection;
    const planes = this.crossSection ? [this.clipPlane] : null;
    this.skinMeshes.forEach(mesh => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(m => { m.clippingPlanes = planes; m.needsUpdate = true; });
    });
    // Animate clip plane
    if (this.crossSection) {
      let v = -1.8;
      const target = 0;
      const step = () => {
        if (this.disposed || !this.crossSection) return;
        v = Math.min(v + 0.06, target);
        this.clipPlane.constant = v;
        this.dirty = true;
        if (v < target) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else {
      this.clipPlane.constant = -1.8;
    }
    this.dirty = true;
    return this.crossSection;
  }

  toggleLayers() {
    this.wireframe = !this.wireframe;
    this.skinMeshes.forEach(mesh => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m: any) => { if ('wireframe' in m) m.wireframe = this.wireframe; m.needsUpdate = true; });
    });
    this.dirty = true;
    return this.wireframe;
  }

  clearSelection() {
    this.selectedId = null;
    this.onSelect(null);
    this.dirty = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('click', this.onClick);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ── Componente React ──────────────────────────────────────────────────────────

export interface SkinCanvasHandle {
  zoom: (dir: 1 | -1) => void;
  reset: () => void;
  clearSelection: () => void;
  toggleIsolate: () => boolean;
  toggleCrossSection: () => boolean;
  toggleLayers: () => boolean;
  getHotspotScreenPos: (id: string) => { x: number; y: number } | null;
}

export interface SkinCanvasProps {
  hotspots: Hotspot[];
  selected: Hotspot | null;
  onSelect: OnSelectFn;
  autoRotate: boolean;
  onInteraction: () => void;
}

export const SkinCanvas = forwardRef<SkinCanvasHandle, SkinCanvasProps>(
  ({ hotspots, selected, onSelect, autoRotate, onInteraction }, ref) => {
    const mountRef    = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<SkinRenderer | null>(null);
    const [loading,  setLoading]  = useState(true);
    const [progress, setProgress] = useState(0);

    useImperativeHandle(ref, () => ({
      zoom(dir) { rendererRef.current?.zoom(dir); },
      reset()   { rendererRef.current?.reset(); },
      clearSelection() { rendererRef.current?.clearSelection(); },
      toggleIsolate()      { return rendererRef.current?.toggleIsolate() ?? false; },
      toggleCrossSection() { return rendererRef.current?.toggleCrossSection() ?? false; },
      toggleLayers()       { return rendererRef.current?.toggleLayers() ?? false; },
      getHotspotScreenPos(id) { return rendererRef.current?.getHotspotScreenPos(id) ?? null; },
    }));

    useEffect(() => {
      if (!mountRef.current) return;
      const r = new SkinRenderer(mountRef.current, onSelect);
      rendererRef.current = r;
      r.loadSkin('/models/clinical/skin.glb', hotspots, (n) => {
        setProgress(Math.round(n * 100));
        if (n >= 1) setLoading(false);
      });
      return () => { rendererRef.current = null; r.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { rendererRef.current?.setAutoRotate(autoRotate); }, [autoRotate]);

    return (
      <div className="absolute inset-0" style={{ background: '#f7f0e7' }}>
        <div ref={mountRef} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20"
               style={{ background: 'rgba(251,246,238,0.8)', backdropFilter: 'blur(4px)' }}>
            <div className="w-14 h-14 rounded-2xl bg-[#deb887] flex items-center justify-center mb-4 animate-pulse">
              <Microscope size={28} className="text-white" />
            </div>
            <p className="text-[#2f2a27] font-semibold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>
              Preparando el modelo
            </p>
            <p className="text-[#8d847c] text-xs mt-1 mb-4">Cargando estructura de la piel...</p>
            <div className="w-48 rounded-full h-1.5" style={{ backgroundColor: 'rgba(117,91,70,0.15)' }}>
              <div className="h-1.5 rounded-full bg-[#deb887] transition-all" style={{ width: `${Math.max(8, progress)}%` }} />
            </div>
            <p className="text-[#8d847c] text-xs mt-2">{Math.max(8, progress)}%</p>
          </div>
        )}
      </div>
    );
  }
);
