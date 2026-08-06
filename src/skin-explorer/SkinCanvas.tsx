/**
 * SkinCanvas — Visor Three.js PURO sin React Three Fiber.
 * Replica exacta del setup del repo thebuggeddev/anatomy (viewer.ts + loaders.ts).
 * No usamos R3F para evitar interferencias con tone mapping / outputColorSpace.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Microscope } from 'lucide-react';
import { useProgress } from '@react-three/drei';
import type { Hotspot } from './skin-data';

// ── Constantes idénticas al repo de referencia ───────────────────────────────
const FIT_SIZE  = 3.8;
const CAMERA_POS = { x: 0, y: 1.05, z: 8.2 };
const CAMERA_TARGET = { x: 0, y: 0.02, z: 0 };
const PLINTH_Y  = -2.5;
const VIEWER_BG = 'radial-gradient(circle at 55% 45%,rgba(255,255,255,0.92),rgba(255,250,242,0.72) 45%,rgba(246,236,224,0.70)),#f7f0e7';
const DOT_SIZE  = 0.12;

type OnSelectFn = (h: Hotspot | null) => void;

// ── Clase de renderizado ─────────────────────────────────────────────────────
class SkinRenderer {
  renderer: THREE.WebGLRenderer;
  scene   = new THREE.Scene();
  camera  = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  controls: OrbitControls;
  private frame = 0;
  private disposed = false;
  private pivot: THREE.Group | null = null;
  private dotMeshes: { mesh: THREE.Mesh; hotspot: Hotspot }[] = [];
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private onSelect: OnSelectFn;
  private dirty = true;
  private container: HTMLElement;

  constructor(container: HTMLElement, onSelect: OnSelectFn) {
    this.container = container;
    this.onSelect  = onSelect;

    const lowPower = (navigator.hardwareConcurrency ?? 8) < 6;

    this.renderer = new THREE.WebGLRenderer({
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
    // Fondo sólido — el canvas transparente interfiere con el color management
    this.scene.background = new THREE.Color(0xf7f0e7);
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(CAMERA_POS.x, CAMERA_POS.y, CAMERA_POS.z);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping   = true;
    this.controls.dampingFactor   = 0.055;
    this.controls.enablePan       = false;
    this.controls.minDistance     = 4.8;
    this.controls.maxDistance     = 12;
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

  // ── Escena idéntica al repo ────────────────────────────────────────────────

  private buildScene() {
    // Iluminación PBR mínima recomendada para ver colores del GLB
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(5, 8, 6);
    this.scene.add(dir);

    const fill = new THREE.DirectionalLight(0xffeedd, 0.5);
    fill.position.set(-4, 2, -4);
    this.scene.add(fill);

    // Plinto
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 2.48, 0.34, 56),
      new THREE.MeshStandardMaterial({ color: 0xead7c1, roughness: 0.78, metalness: 0 }),
    );
    plinth.position.y = PLINTH_Y;
    this.scene.add(plinth);
  }

  // ── Carga del modelo ──────────────────────────────────────────────────────

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

    // MUY IMPORTANTE: no reemplazar/sobreescribir el material del GLB.
    // Solo asegurar colorSpace correcto en el mapa de color y activar update.
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      child.castShadow    = false;
      child.receiveShadow = false;

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat: any) => {
        if (mat.map) {
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.map.needsUpdate = true;
        }
        mat.needsUpdate = true;
      });
    });

    // Dots de hotspot como children del pivot
    this.addHotspots(hotspots, pivot);

    onProgress(1);
    this.dirty = true;
  }

  // ── Hotspot dots ──────────────────────────────────────────────────────────

  private addHotspots(hotspots: Hotspot[], pivot: THREE.Group) {
    hotspots.forEach((h) => {
      const geo = new THREE.SphereGeometry(DOT_SIZE, 20, 20);
      const mat = new THREE.MeshBasicMaterial({ color: h.color, depthTest: false, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...(h.position as [number, number, number]));
      mesh.renderOrder = 10;
      mesh.userData = { hotspotId: h.id };
      pivot.add(mesh);
      this.dotMeshes.push({ mesh, hotspot: h });
    });
  }

  // ── Interacción ───────────────────────────────────────────────────────────

  private getCanvasOffset(event: MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) / r.width) * 2 - 1,
      y: -((event.clientY - r.top) / r.height) * 2 + 1,
    };
  }

  private pickDot(event: MouseEvent) {
    const { x, y } = this.getCanvasOffset(event);
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x, y }, this.camera);
    const hits = ray.intersectObjects(this.dotMeshes.map((d) => d.mesh));
    return hits.length ? this.dotMeshes.find((d) => d.mesh === hits[0].object) ?? null : null;
  }

  private onClick = (event: MouseEvent) => {
    const dot = this.pickDot(event);
    const id = dot?.hotspot.id ?? null;
    if (id !== this.selectedId) {
      this.selectedId = id;
      this.onSelect(dot?.hotspot ?? null);
      this.dirty = true;
    } else {
      this.selectedId = null;
      this.onSelect(null);
      this.dirty = true;
    }
  };

  private onPointerMove = (event: MouseEvent) => {
    const dot = this.pickDot(event);
    const id = dot?.hotspot.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
      this.dirty = true;
    }
  };

  // ── Animación ──────────────────────────────────────────────────────────────

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    if (this.disposed) return;

    const moved = this.controls.update();
    if (moved) this.dirty = true;

    // Pulso en dots
    if (this.dotMeshes.length) {
      const t = performance.now() / 1000;
      this.dotMeshes.forEach(({ mesh, hotspot }) => {
        const isSelected = hotspot.id === this.selectedId;
        const isHovered  = hotspot.id === this.hoveredId;
        const scale = isHovered ? 1.35 : isSelected ? 1 + Math.sin(t * 3.5) * 0.18 : 1;
        mesh.scale.setScalar(scale);
      });
      this.dirty = true;
    }

    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  };

  // ── Herramientas ──────────────────────────────────────────────────────────

  setAutoRotate(v: boolean) {
    this.controls.autoRotate = v;
    if (v) this.controls.autoRotateSpeed = 0.65;
    this.dirty = true;
  }

  zoom(dir: 1 | -1) {
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z + dir * 1.2, 4.8, 12);
    this.dirty = true;
  }

  reset() {
    const sp = this.camera.position.clone();
    const ep = new THREE.Vector3(CAMERA_POS.x, CAMERA_POS.y, CAMERA_POS.z);
    const t0 = performance.now();
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - t0) / 800, 1);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(sp, ep, e);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);
  }

  clearSelection() {
    this.selectedId = null;
    this.onSelect(null);
    this.dirty = true;
  }

  private resize() {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
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

// ── Componente React ─────────────────────────────────────────────────────────

export interface SkinCanvasHandle { zoom: (dir: 1 | -1) => void; reset: () => void; clearSelection: () => void; }
export interface SkinCanvasProps {
  hotspots: Hotspot[];
  selected: Hotspot | null;
  onSelect: OnSelectFn;
  autoRotate: boolean;
  onInteraction: () => void;
}

// Standalone loading state — no R3F needed
function useModelLoading(url: string, onProgress: (n: number) => void) {
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState(0);
  const handleProgress = React.useCallback((n: number) => {
    setProgress(n);
    onProgress(n);
    if (n >= 1) setLoading(false);
  }, [onProgress]);
  return { loading, progress, handleProgress };
}

import React from 'react';

export const SkinCanvas = forwardRef<SkinCanvasHandle, SkinCanvasProps>(
  ({ hotspots, selected, onSelect, autoRotate, onInteraction }, ref) => {
    const mountRef    = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<SkinRenderer | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [progress, setProgress] = React.useState(0);

    useImperativeHandle(ref, () => ({
      zoom(dir) { rendererRef.current?.zoom(dir); },
      reset()   { rendererRef.current?.reset(); },
      clearSelection() { rendererRef.current?.clearSelection(); },
    }));

    useEffect(() => {
      if (!mountRef.current) return;
      const r = new SkinRenderer(mountRef.current, onSelect);
      rendererRef.current = r;

      r.loadSkin('/models/clinical/skin.glb', hotspots, (n) => {
        setProgress(Math.round(n * 100));
        if (n >= 1) setLoading(false);
      });

      return () => {
        rendererRef.current = null;
        r.dispose();
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Sync autoRotate and onInteraction
    useEffect(() => {
      rendererRef.current?.setAutoRotate(autoRotate);
    }, [autoRotate]);

    return (
      <div className="absolute inset-0" style={{ background: '#f7f0e7' }}>
        <div ref={mountRef} className="absolute inset-0" />

        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20"
               style={{ background: 'rgba(251,246,238,0.75)', backdropFilter: 'blur(4px)' }}>
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
