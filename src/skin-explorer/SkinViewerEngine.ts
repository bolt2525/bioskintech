/**
 * SkinViewerEngine — Motor Three.js para el visor 3D de la piel.
 *
 * Adaptado de thebuggeddev/anatomy (viewer.ts + hotspots.ts + loaders.ts).
 * GSAP reemplazado por lerp nativo + requestAnimationFrame.
 * Compatible con Three.js ya instalado en el proyecto.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Hotspot } from './skin-data';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const FIT_SIZE = 3.8;
const DOT_PIXELS = 34;
const CAMERA_FOV = 34;
const SURFACE_LIFT = 0.02;
const VIEW_LIFT = 0.3;
const PULSE_SECONDS = 4.5;
const HOME_CAMERA = { x: 0, y: 0.5, z: 7.5 };
const HOME_TARGET = { x: 0.15, y: 0.9, z: 0 };
const PLINTH_Y = -2.5;
const PLINTH_TOP = PLINTH_Y + 0.17;
const TAU = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type Marker = {
  hotspot: Hotspot;
  dot: THREE.Sprite;
  pulse: THREE.Sprite;
  anchor: THREE.Vector3;
  opacity: number;
  emphasis: number;
};

type LoadedSkin = {
  pivot: THREE.Group;
  meshes: THREE.Mesh[];
  mixer: THREE.AnimationMixer | null;
};

type ViewerCallbacks = {
  onLoading: (loading: boolean, progress: number) => void;
  onSelect: (hotspot: Hotspot | null) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Texturas para dots (hotspots)
// ─────────────────────────────────────────────────────────────────────────────

function rgba(color: THREE.Color, alpha: number) {
  return `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${alpha})`;
}

function dotTexture(hex: string) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const color = new THREE.Color(hex);

  const halo = ctx.createRadialGradient(c, c, size * 0.3, c, c, size * 0.5);
  halo.addColorStop(0, rgba(color, 0.4));
  halo.addColorStop(0.5, rgba(color, 0.14));
  halo.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(c, c, c, 0, TAU); ctx.fill();

  ctx.beginPath(); ctx.arc(c, c, size * 0.3, 0, TAU);
  ctx.fillStyle = 'rgba(48,32,24,0.22)'; ctx.fill();

  ctx.beginPath(); ctx.arc(c, c, size * 0.285, 0, TAU);
  ctx.fillStyle = 'rgba(255,253,249,0.97)'; ctx.fill();

  ctx.beginPath(); ctx.arc(c, c, size * 0.185, 0, TAU);
  ctx.fillStyle = rgba(color, 1); ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function ringTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = size * 0.035;
  ctx.beginPath(); ctx.arc(c, c, size * 0.42, 0, TAU); ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function contactShadowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, 'rgba(94,62,42,0.62)');
  gradient.addColorStop(0.45, 'rgba(94,62,42,0.26)');
  gradient.addColorStop(1, 'rgba(94,62,42,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ─────────────────────────────────────────────────────────────────────────────
// snapToSurface — coloca hotspots en la superficie del mesh
// (traducido directamente de hotspots.ts del repo original)
// ─────────────────────────────────────────────────────────────────────────────

const DIRECTION_CONES = [0.94, 0.82, 0.6, -1.1];
type Candidate = { distance: number; mesh: THREE.Mesh; index: number; point: THREE.Vector3 };

function snapToSurface(hotspots: Hotspot[], pivot: THREE.Group, meshes: THREE.Mesh[]) {
  const targets = hotspots.map((h) => new THREE.Vector3(...h.position));
  const directions = targets.map((t) => t.clone().normalize());
  const tiers: (Candidate | null)[][] = hotspots.map(() => DIRECTION_CONES.map(() => null));
  if (!meshes.length) return targets;

  pivot.updateWorldMatrix(true, true);
  const toPivot = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const vertex = new THREE.Vector3();

  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    local.multiplyMatrices(toPivot, mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(local);
      const radius = vertex.length();
      for (let h = 0; h < targets.length; h++) {
        const distance = vertex.distanceToSquared(targets[h]);
        const cosine = radius > 1e-5 ? vertex.dot(directions[h]) / radius : 1;
        for (let t = 0; t < DIRECTION_CONES.length; t++) {
          if (cosine < DIRECTION_CONES[t]) continue;
          const best = tiers[h][t];
          if (best && best.distance <= distance) continue;
          if (best) { best.distance = distance; best.mesh = mesh; best.index = i; best.point.copy(vertex); }
          else { tiers[h][t] = { distance, mesh, index: i, point: vertex.clone() }; }
        }
      }
    }
  }

  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  return targets.map((target, h) => {
    const chosen = tiers[h].find(Boolean);
    if (!chosen) return target;
    const normals = chosen.mesh.geometry.getAttribute('normal');
    if (normals) {
      local.multiplyMatrices(toPivot, chosen.mesh.matrixWorld);
      normalMatrix.getNormalMatrix(local);
      normal.fromBufferAttribute(normals, chosen.index).applyMatrix3(normalMatrix).normalize();
    } else {
      normal.copy(chosen.point).normalize();
    }
    if (normal.dot(chosen.point) < 0) normal.negate();
    return chosen.point.addScaledVector(normal, SURFACE_LIFT);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SkinViewerEngine
// ─────────────────────────────────────────────────────────────────────────────

export class SkinViewerEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  private controls: OrbitControls;
  private callbacks: ViewerCallbacks;
  private container: HTMLElement;

  private skin: LoadedSkin | null = null;
  private plinth!: THREE.Mesh;
  private contactShadow!: THREE.Mesh;

  // Hotspot system
  private markers: Marker[] = [];
  private ringTexture = ringTexture();
  private hotspotGroup = new THREE.Group();
  private pixelScale = 0.021;
  private time = 0;
  private selectedAt = -PULSE_SECONDS;
  private lastSelectedId: string | null = null;

  // Picking reuse vectors
  private readonly worldVec = new THREE.Vector3();
  private readonly toCameraVec = new THREE.Vector3();
  private readonly outwardVec = new THREE.Vector3();
  private readonly centerVec = new THREE.Vector3();
  private readonly projectedVec = new THREE.Vector3();
  private readonly localCameraVec = new THREE.Vector3();
  private readonly liftVec = new THREE.Vector3();

  private calloutEl: HTMLElement | null = null;
  private frame = 0;
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;

  // Render-on-demand
  private dirty = true;
  private busyUntil = 0;
  private width = 1;
  private height = 1;
  private isVisible = true;
  private isPageVisible = true;
  private disposed = false;

  // State
  private autoRotateWanted = true;
  private interactionUntil = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private hoverProbe: { x: number; y: number } | null = null;
  private pointerId: number | null = null;
  private pointerStart = { x: 0, y: 0 };
  private dragged = false;

  // Tools
  private crossSection = false;
  private isolated = false;
  private clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private depthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: true, depthTest: true,
  });

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const lowPower = window.matchMedia('(max-width: 780px)').matches ||
      (navigator.hardwareConcurrency ?? 8) < 6;
    const pixelRatio = Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !lowPower,
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = false;
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Modelo 3D interactivo de la piel. Arrastra para rotar, scroll para zoom, haz clic en un punto para más información.',
    );
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(HOME_CAMERA.x, HOME_CAMERA.y, HOME_CAMERA.z);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 4.8;
    this.controls.maxDistance = 12;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.target.set(HOME_TARGET.x, HOME_TARGET.y, HOME_TARGET.z);

    this.buildEnvironment();

    this.hotspotGroup.name = 'hotspot-layer';
    this.hotspotGroup.renderOrder = 10;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => { this.isVisible = entry.isIntersecting; if (this.isVisible) this.dirty = true; },
      { rootMargin: '120px' },
    );
    this.intersectionObserver.observe(container);

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.addEventListener('start', this.onControlStart);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('keydown', this.onKeyDown);

    this.resize();
    this.animate();
  }

  // ── Escena ───────────────────────────────────────────────────────────────

  private buildEnvironment() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x33252d, 0.72));

    const key = new THREE.DirectionalLight(0xfff3e7, 3.5);
    key.position.set(4.8, 6.5, 6.8);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xe6ecff, 1.12);
    fill.position.set(-4.5, 1.2, 5.2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffb7a5, 1.6);
    rim.position.set(-4, 3.5, -5.5);
    this.scene.add(rim);

    const warm = new THREE.PointLight(0xff8d70, 0.72, 11, 2);
    warm.position.set(-3, -1.4, 3.5);
    this.scene.add(warm);

    const glow = new THREE.PointLight(0xc99277, 0.5, 8, 2);
    glow.name = 'skin-glow';
    glow.position.set(2.8, 0.4, 2.8);
    this.scene.add(glow);

    this.scene.environment = this.buildEnvironmentMap();

    this.plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 2.48, 0.34, 56),
      new THREE.MeshStandardMaterial({ color: 0xf0e4d0, roughness: 0.85, metalness: 0 }),
    );
    this.plinth.position.y = PLINTH_Y;
    this.scene.add(this.plinth);

    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 4.2),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.62,
        toneMapped: false,
      }),
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = PLINTH_TOP + 0.005;
    this.contactShadow.renderOrder = 1;
    this.scene.add(this.contactShadow);

    // Partículas decorativas
    const positions = new Float32Array(48 * 3);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = (Math.random() - 0.5) * 9;
      positions[i + 1] = (Math.random() - 0.5) * 6;
      positions[i + 2] = (Math.random() - 0.5) * 5 - 2;
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.scene.add(new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({ color: 0xc99277, size: 0.013, transparent: true, opacity: 0.16 }),
    ));
  }

  private buildEnvironmentMap() {
    const width = 16, height = 32;
    const data = new Uint8Array(width * height * 4);
    // Gradiente crema → marrón dorado, combina con el fondo claro del visor
    const top = new THREE.Color(0xfff8ee);
    const bottom = new THREE.Color(0xc49a6a);
    const mixed = new THREE.Color();
    for (let y = 0; y < height; y++) {
      mixed.copy(bottom).lerp(top, Math.pow(1 - y / (height - 1), 0.7));
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = mixed.r * 255; data[i + 1] = mixed.g * 255;
        data[i + 2] = mixed.b * 255; data[i + 3] = 255;
      }
    }
    const source = new THREE.DataTexture(data, width, height);
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    source.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(source).texture;
    pmrem.dispose(); source.dispose();
    return env;
  }

  // ── Carga del modelo ─────────────────────────────────────────────────────

  async loadSkin(url: string, hotspots: Hotspot[]) {
    this.callbacks.onLoading(true, 0);

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    try {
      gltf = await loader.loadAsync(url, (evt) => {
        if (evt.total > 0) this.callbacks.onLoading(true, evt.loaded / evt.total);
      });
    } catch {
      this.callbacks.onLoading(false, 0);
      return;
    }

    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = FIT_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    model.scale.setScalar(scale);
    model.position.copy(center.multiplyScalar(-scale));

    const pivot = new THREE.Group();
    pivot.name = 'skin-pivot';
    pivot.add(model);
    pivot.rotation.set(0.05, -0.28, 0);

    const meshes: THREE.Mesh[] = [];
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      meshes.push(child);
      child.frustumCulled = false;
      child.castShadow = false;
      child.receiveShadow = false;

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        mat.transparent = false; mat.opacity = 1;
        mat.depthWrite = true; mat.depthTest = true;
        mat.side = THREE.FrontSide;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.roughness = THREE.MathUtils.clamp(mat.roughness ?? 0.5, 0.3, 0.75);
          mat.metalness = 0;
          mat.envMapIntensity = 1.0;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 0;
          // KHR_materials_volume crea un MeshPhysicalMaterial con transmission > 0.
          // Sin render pass de transmisión, el material renderiza blanco — desactivar.
          if (mat instanceof THREE.MeshPhysicalMaterial) {
            mat.transmission = 0;
            mat.thickness = 0;
            mat.ior = 1.5;
          }
          if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
          if (mat.normalMap) mat.normalScale.multiplyScalar(0.62);
          for (const map of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap]) {
            if (!map) continue;
            map.anisotropy = maxAnisotropy;
            map.generateMipmaps = true;
            map.minFilter = THREE.LinearMipmapLinearFilter;
            map.magFilter = THREE.LinearFilter;
            map.needsUpdate = true;
          }
        }
        mat.needsUpdate = true;
      }
    });

    let mixer: THREE.AnimationMixer | null = null;
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      gltf.animations.forEach((clip) => mixer?.clipAction(clip).play());
    }

    this.skin = { pivot, meshes, mixer };
    this.scene.add(pivot);
    pivot.updateWorldMatrix(true, true);

    this.attachHotspots(hotspots, pivot, meshes);
    this.setHotspotPixelSize();

    this.callbacks.onLoading(false, 1);
    this.busy(1.5);
    this.dirty = true;

    // Fade-in suave sin GSAP — interpolación por frame
    const mats = this.getMaterials();
    mats.forEach((m) => { m.transparent = true; m.opacity = 0; });
    const startTime = performance.now();
    const fadeDuration = 700;
    const fadeIn = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - startTime) / fadeDuration, 1);
      const ease = 1 - Math.pow(1 - t, 2);
      mats.forEach((m) => { m.opacity = ease; });
      this.dirty = true;
      if (t < 1) requestAnimationFrame(fadeIn);
      else { mats.forEach((m) => { m.transparent = false; m.opacity = 1; }); }
    };
    requestAnimationFrame(fadeIn);
  }

  private getMaterials() {
    const list: THREE.Material[] = [];
    this.skin?.meshes.forEach((mesh) => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => list.includes(m) || list.push(m));
    });
    return list;
  }

  // ── Hotspots ─────────────────────────────────────────────────────────────

  private attachHotspots(hotspots: Hotspot[], pivot: THREE.Group, meshes: THREE.Mesh[]) {
    this.clearMarkers();
    if (!hotspots.length) return;

    const anchors = snapToSurface(hotspots, pivot, meshes);
    hotspots.forEach((hotspot, i) => {
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dotTexture(hotspot.color),
        transparent: true,
        depthWrite: false,
        depthTest: true,
        sizeAttenuation: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -12,
      }));
      dot.position.copy(anchors[i]);
      dot.renderOrder = 11;

      const pulse = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.ringTexture,
        color: new THREE.Color(hotspot.color),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,
        sizeAttenuation: false,
        toneMapped: false,
      }));
      pulse.position.copy(anchors[i]);
      pulse.renderOrder = 10;

      this.hotspotGroup.add(pulse, dot);
      this.markers.push({ hotspot, dot, pulse, anchor: anchors[i].clone(), opacity: 0, emphasis: 0 });
    });

    this.hotspotGroup.position.set(0, 0, 0);
    pivot.add(this.hotspotGroup);
    this.applyHotspotScale();
  }

  private setHotspotPixelSize() {
    const fov = THREE.MathUtils.degToRad(CAMERA_FOV);
    this.pixelScale = 2 * (DOT_PIXELS / Math.max(this.height, 1)) * Math.tan(fov / 2);
    this.applyHotspotScale();
  }

  private applyHotspotScale() {
    this.markers.forEach((marker) => {
      const scale = this.pixelScale * (1 + marker.emphasis * 0.3) * (0.74 + 0.26 * marker.opacity);
      marker.dot.scale.setScalar(scale);
    });
  }

  private updateHotspots(delta: number): boolean {
    if (!this.markers.length) return true;
    this.time += delta;
    this.hotspotGroup.updateWorldMatrix(true, false);
    this.hotspotGroup.getWorldPosition(this.centerVec);
    this.localCameraVec.copy(this.camera.position);
    this.hotspotGroup.worldToLocal(this.localCameraVec);

    if (this.selectedId !== this.lastSelectedId) {
      this.lastSelectedId = this.selectedId;
      this.selectedAt = this.time;
    }
    const beating = this.time - this.selectedAt < PULSE_SECONDS;
    let settled = true;

    for (const marker of this.markers) {
      this.liftVec.copy(this.localCameraVec).sub(marker.anchor);
      const span = this.liftVec.length();
      if (span > 1e-4) this.liftVec.multiplyScalar(VIEW_LIFT / span);
      else this.liftVec.set(0, 0, 0);
      marker.dot.position.copy(marker.anchor).add(this.liftVec);
      marker.pulse.position.copy(marker.dot.position);

      marker.dot.getWorldPosition(this.worldVec);
      this.outwardVec.copy(this.worldVec).sub(this.centerVec);
      const radius = this.outwardVec.length();
      this.toCameraVec.copy(this.camera.position).sub(this.worldVec).normalize();
      const facing = radius > 1e-4 ? this.outwardVec.divideScalar(radius).dot(this.toCameraVec) : 1;
      const target = THREE.MathUtils.smoothstep(facing, -0.05, 0.3);

      const active = marker.hotspot.id === this.selectedId || marker.hotspot.id === this.hoveredId;
      const emphasisTarget = active ? 1 : 0;
      const ease = 1 - Math.exp(-delta * 12);

      if (Math.abs(target - marker.opacity) > 0.002) settled = false;
      if (Math.abs(emphasisTarget - marker.emphasis) > 0.002) settled = false;
      marker.opacity += (target - marker.opacity) * ease;
      marker.emphasis += (emphasisTarget - marker.emphasis) * ease;

      marker.dot.material.opacity = marker.opacity;
      marker.dot.visible = marker.opacity > 0.01;

      if (marker.emphasis > 0.01) {
        marker.pulse.visible = true;
        if (beating || marker.hotspot.id === this.hoveredId) {
          const beat = (this.time * 0.75) % 1;
          marker.pulse.material.opacity = marker.emphasis * marker.opacity * (1 - beat) * 0.85;
          marker.pulse.scale.setScalar(this.pixelScale * (1.15 + beat * 1.5));
          settled = false;
        } else {
          marker.pulse.material.opacity = marker.emphasis * marker.opacity * 0.42;
          marker.pulse.scale.setScalar(this.pixelScale * 1.6);
        }
      } else if (marker.pulse.visible) {
        marker.pulse.visible = false;
      }
    }
    this.applyHotspotScale();
    return settled;
  }

  pickHotspot(x: number, y: number, radius = 32) {
    let best: Marker | null = null;
    let bestDistance = radius;
    for (const marker of this.markers) {
      if (marker.opacity < 0.35) continue;
      marker.dot.getWorldPosition(this.projectedVec).project(this.camera as THREE.PerspectiveCamera);
      if (this.projectedVec.z > 1) continue;
      const px = (this.projectedVec.x * 0.5 + 0.5) * this.width;
      const py = (-this.projectedVec.y * 0.5 + 0.5) * this.height;
      const distance = Math.hypot(px - x, py - y);
      if (distance < bestDistance) { bestDistance = distance; best = marker; }
    }
    return best;
  }

  screenPosition(id: string) {
    const marker = this.markers.find((m) => m.hotspot.id === id);
    if (!marker) return null;
    marker.dot.getWorldPosition(this.projectedVec).project(this.camera);
    return {
      x: (this.projectedVec.x * 0.5 + 0.5) * this.width,
      y: (-this.projectedVec.y * 0.5 + 0.5) * this.height,
      opacity: marker.opacity,
    };
  }

  private clearMarkers() {
    this.markers.forEach((m) => {
      m.dot.material.map?.dispose();
      m.dot.material.dispose();
      m.pulse.material.dispose();
    });
    this.markers = [];
    this.hotspotGroup.clear();
    this.hotspotGroup.removeFromParent();
  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    if (!this.isVisible || !this.isPageVisible) return;

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();

    this.applyAutoRotate(now);
    if (this.controls.update(delta)) this.dirty = true;

    if (this.skin?.mixer) {
      this.skin.mixer.update(delta);
      this.dirty = true;
    }

    if (this.hoverProbe) this.resolveHover();
    if (!this.dirty && now >= this.busyUntil) return;

    if (!this.updateHotspots(delta)) this.dirty = true;
    else this.dirty = false;
    if (now < this.busyUntil) this.dirty = true;

    this.positionCallout();
    this.renderer.render(this.scene, this.camera);
  };

  private busy(seconds: number) {
    this.busyUntil = Math.max(this.busyUntil, performance.now() + seconds * 1000);
    this.dirty = true;
  }

  private applyAutoRotate(now: number) {
    this.controls.autoRotate =
      this.autoRotateWanted && !this.selectedId && now >= this.interactionUntil;
  }

  private onVisibilityChange = () => {
    this.isPageVisible = !document.hidden;
    if (this.isPageVisible) { this.clock.start(); this.dirty = true; }
  };

  private resize() {
    this.width = Math.max(this.container.clientWidth, 1);
    this.height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.setHotspotPixelSize();
    this.dirty = true;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private onControlStart = () => {
    this.interactionUntil = performance.now() + 3000;
    this.dirty = true;
  };

  private onPointerDown = (event: PointerEvent) => {
    this.pointerId = event.pointerId;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.dragged = false;
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointerId !== null) {
      if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5)
        this.dragged = true;
      return;
    }
    this.hoverProbe = { x: event.offsetX, y: event.offsetY };
    this.dirty = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    const wasDragging = this.dragged;
    this.pointerId = null;
    this.dragged = false;
    if (wasDragging) return;
    const marker = this.pickHotspot(event.offsetX, event.offsetY);
    this.select(marker && marker.hotspot.id !== this.selectedId ? marker.hotspot.id : null);
  };

  private onPointerLeave = () => {
    this.pointerId = null;
    this.hoverProbe = null;
    if (this.hoveredId) { this.hoveredId = null; this.dirty = true; }
  };

  private resolveHover() {
    const probe = this.hoverProbe;
    this.hoverProbe = null;
    if (!probe) return;
    const marker = this.pickHotspot(probe.x, probe.y);
    const id = marker?.hotspot.id ?? null;
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.dirty = true;
  }

  private select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.busy(0.4);
    const marker = this.markers.find((m) => m.hotspot.id === id);
    this.callbacks.onSelect(marker?.hotspot ?? null);
  }

  clearSelection() { this.select(null); }

  // ── Callout positioning ───────────────────────────────────────────────────

  attachCallout(element: HTMLElement | null) {
    this.calloutEl = element;
    this.positionCallout();
    this.dirty = true;
  }

  private positionCallout() {
    if (!this.calloutEl || !this.selectedId) return;
    const point = this.screenPosition(this.selectedId);
    if (!point) return;
    this.calloutEl.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
    this.calloutEl.dataset.side = point.x > this.width * 0.6 ? 'left' : 'right';
    this.calloutEl.dataset.behind = point.opacity < 0.3 ? 'true' : 'false';
  }

  private onKeyDown = (event: KeyboardEvent) => {
    const pivot = this.skin?.pivot;
    if (event.key === 'ArrowLeft' && pivot) pivot.rotation.y -= 0.08;
    if (event.key === 'ArrowRight' && pivot) pivot.rotation.y += 0.08;
    if (event.key === '+') this.camera.position.z = Math.max(4.8, this.camera.position.z - 0.35);
    if (event.key === '-') this.camera.position.z = Math.min(12, this.camera.position.z + 0.35);
    if (event.key === 'Escape') this.select(null);
    this.dirty = true;
  };

  // ── Herramientas ─────────────────────────────────────────────────────────

  setAutoRotate(enabled: boolean) {
    this.autoRotateWanted = enabled;
    if (enabled) this.interactionUntil = 0;
    this.dirty = true;
  }

  reset() {
    this.select(null);
    // Lerp suave hacia posición inicial
    const start = this.camera.position.clone();
    const target = new THREE.Vector3(HOME_CAMERA.x, HOME_CAMERA.y, HOME_CAMERA.z);
    const startTime = performance.now();
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - startTime) / 800, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(start, target, ease);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);

    if (this.skin) {
      const startRot = this.skin.pivot.rotation.clone();
      const lerpRot = () => {
        if (this.disposed) return;
        const t = Math.min((performance.now() - startTime) / 800, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        this.skin!.pivot.rotation.x = THREE.MathUtils.lerp(startRot.x, 0.05, ease);
        this.skin!.pivot.rotation.y = THREE.MathUtils.lerp(startRot.y, -0.28, ease);
        this.skin!.pivot.rotation.z = THREE.MathUtils.lerp(startRot.z, 0, ease);
        this.dirty = true;
        if (t < 1) requestAnimationFrame(lerpRot);
      };
      requestAnimationFrame(lerpRot);
    }
  }

  zoom(direction: 1 | -1) {
    const start = this.camera.position.z;
    const target = THREE.MathUtils.clamp(start + direction * 1.2, 4.8, 12);
    const startTime = performance.now();
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - startTime) / 500, 1);
      const ease = 1 - Math.pow(1 - t, 2);
      this.camera.position.z = THREE.MathUtils.lerp(start, target, ease);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);
  }

  toggleIsolate() {
    this.isolated = !this.isolated;
    const plinthMat = this.plinth.material as THREE.MeshStandardMaterial;
    plinthMat.transparent = true;
    const targetPlinth = this.isolated ? 0.15 : 1;
    const targetShadow = this.isolated ? 0.08 : 0.55;
    const start = { p: plinthMat.opacity, s: (this.contactShadow.material as THREE.MeshBasicMaterial).opacity };
    const startTime = performance.now();
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - startTime) / 450, 1);
      plinthMat.opacity = THREE.MathUtils.lerp(start.p, targetPlinth, t);
      (this.contactShadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.lerp(start.s, targetShadow, t);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);
    return this.isolated;
  }

  toggleCrossSection() {
    this.crossSection = !this.crossSection;
    this.applyClipping(this.crossSection);
    const startConstant = this.crossSection ? -1.8 : 0;
    const endConstant = this.crossSection ? 0 : -1.8;
    const startTime = performance.now();
    this.clipPlane.constant = startConstant;
    const lerp = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - startTime) / 850, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.clipPlane.constant = THREE.MathUtils.lerp(startConstant, endConstant, ease);
      this.dirty = true;
      if (t < 1) requestAnimationFrame(lerp);
    };
    requestAnimationFrame(lerp);
    this.busy(0.95);
    return this.crossSection;
  }

  private applyClipping(enabled: boolean) {
    if (!this.skin) return;
    const planes = enabled ? [this.clipPlane] : null;
    [...this.getMaterials(), this.depthMaterial].forEach((mat) => {
      mat.clippingPlanes = planes;
      mat.needsUpdate = true;
    });
    this.dirty = true;
  }

  toggleLayers() {
    if (!this.skin) return false;
    let enabled = false;
    this.getMaterials().forEach((mat) => {
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.wireframe = !mat.wireframe;
        enabled = mat.wireframe;
      }
    });
    this.dirty = true;
    return enabled;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('keydown', this.onKeyDown);

    this.clearMarkers();
    this.ringTexture.dispose();
    this.depthMaterial.dispose();
    this.scene.environment?.dispose();
    (this.contactShadow.material as THREE.MeshBasicMaterial).map?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
