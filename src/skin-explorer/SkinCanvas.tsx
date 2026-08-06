/**
 * SkinCanvas — Motor 3D definitivo.
 *
 * Hallazgos clave de la investigación:
 * 1. El material del GLB es MeshStandardMaterial puro (sin KHR_materials_volume en el material mismo).
 * 2. El `gl` prop de Canvas en R3F no aplica toneMapping/outputColorSpace (no son ctor params).
 *    → Usar `onCreated` callback que SÍ los aplica sobre el renderer construido.
 * 3. useGLTF cachea la escena; hay que resetear transforms antes de normalizar.
 * 4. Los hotspots deben estar DENTRO del mismo grupo rotado que el modelo.
 */
import { Suspense, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { Microscope } from 'lucide-react';
import type { Hotspot } from './skin-data';

const FIT_SIZE  = 3.8;
const CAM_POS: [number, number, number]    = [0, 1.05, 8.2];
const CAM_TARGET: [number, number, number] = [0, 0.02, 0];
const PLINTH_Y  = -2.5;
const VIEWER_BG = 'radial-gradient(circle at 55% 45%,rgba(255,255,255,0.92),rgba(255,250,242,0.72) 45%,rgba(246,236,224,0.70)),#f7f0e7';

useGLTF.preload('/models/clinical/skin.glb');

// ── Configurar el renderer exactamente como el repo original ─────────────────
// onCreated es la única forma garantizada de aplicar props post-constructor en R3F.
function RendererConfig() {
  const { gl, scene } = useThree();
  useEffect(() => {
    gl.outputColorSpace     = THREE.SRGBColorSpace;
    gl.toneMapping          = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure  = 1.02;
    gl.shadowMap.enabled    = false;
    gl.localClippingEnabled = true;

    // Env map PMREM idéntico al repo (viewer.ts buildEnvironmentMap)
    const w = 16, h = 32;
    const data = new Uint8Array(w * h * 4);
    const top  = new THREE.Color(0xfff3e4);
    const bot  = new THREE.Color(0x6b4f45);
    const mix  = new THREE.Color();
    for (let y = 0; y < h; y++) {
      mix.copy(bot).lerp(top, Math.pow(1 - y / (h - 1), 0.7));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i]   = Math.round(mix.r * 255);
        data[i+1] = Math.round(mix.g * 255);
        data[i+2] = Math.round(mix.b * 255);
        data[i+3] = 255;
      }
    }
    const src = new THREE.DataTexture(data, w, h);
    src.mapping    = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    src.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(gl);
    scene.environment = pmrem.fromEquirectangular(src).texture;
    pmrem.dispose();
    src.dispose();
  }, [gl, scene]);
  return null;
}

// ── Modelo de piel ───────────────────────────────────────────────────────────
function SkinMesh() {
  const { scene } = useGLTF('/models/clinical/skin.glb');

  useEffect(() => {
    // Resetear transforms de cachés anteriores antes de normalizar
    scene.scale.set(1, 1, 1);
    scene.position.set(0, 0, 0);

    // Normalizar a FIT_SIZE (loaders.ts del repo original)
    const box    = new THREE.Box3().setFromObject(scene);
    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = FIT_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    scene.scale.setScalar(s);
    scene.position.copy(center.multiplyScalar(-s));

    // Procesar materiales exactamente como loaders.ts del repo
    const maxAniso = 8;
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      child.castShadow    = false;
      child.receiveShadow = false;

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        mat.transparent = false;
        mat.opacity     = 1;
        mat.depthWrite  = true;
        mat.depthTest   = true;
        mat.side        = THREE.FrontSide;

        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.roughness       = THREE.MathUtils.clamp(mat.roughness ?? 0.5, 0.42, 0.62);
          mat.metalness       = 0;
          mat.envMapIntensity = 0.32;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 0;

          // Solo MeshPhysicalMaterial tiene clearcoat; esto es safe
          if ('clearcoat' in mat) {
            const p = mat as THREE.MeshPhysicalMaterial;
            p.clearcoat          = Math.min(Math.max(p.clearcoat, 0.08), 0.12);
            p.clearcoatRoughness = 0.62;
            p.transmission       = 0;
            p.thickness          = 0;
          }

          if (mat.map)       mat.map.colorSpace = THREE.SRGBColorSpace;
          if (mat.normalMap) mat.normalScale.set(0.62, 0.62);

          for (const map of [mat.map, mat.normalMap, mat.roughnessMap,
                              (mat as any).metalnessMap, mat.aoMap, mat.emissiveMap]) {
            if (!map) continue;
            map.anisotropy      = maxAniso;
            map.generateMipmaps = true;
            map.minFilter       = THREE.LinearMipmapLinearFilter;
            map.magFilter       = THREE.LinearFilter;
            map.needsUpdate     = true;
          }
        }
        mat.needsUpdate = true;
      });
    });
  }, [scene]);

  // Sin rotation aquí — la pone el grupo padre compartido con los hotspots
  return <primitive object={scene} />;
}

// ── Hotspot ──────────────────────────────────────────────────────────────────
function HotspotDot({ hotspot, isSelected, onSelect }: {
  hotspot: Hotspot; isSelected: boolean; onSelect: (h: Hotspot) => void;
}) {
  const dotRef   = useRef<THREE.Mesh>(null!);
  const pulseRef = useRef<THREE.Mesh>(null!);
  const t = useRef(0);

  useFrame((_, delta) => {
    t.current += delta;
    if (dotRef.current)
      dotRef.current.scale.setScalar(isSelected ? 1 + Math.sin(t.current * 3.5) * 0.18 : 1);
    if (pulseRef.current) {
      const beat = (t.current * 0.75) % 1;
      pulseRef.current.scale.setScalar(isSelected ? 1.3 + beat * 1.8 : 0.001);
      (pulseRef.current.material as THREE.MeshBasicMaterial).opacity =
        isSelected ? (1 - beat) * 0.55 : 0;
    }
  });

  return (
    <group position={hotspot.position as [number, number, number]}>
      <mesh ref={pulseRef} renderOrder={9}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshBasicMaterial color={hotspot.color} transparent opacity={0} depthTest={false} />
      </mesh>
      <mesh
        ref={dotRef}
        renderOrder={10}
        onClick={(e) => { e.stopPropagation(); onSelect(hotspot); }}
        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'auto'; }}
      >
        <sphereGeometry args={[0.12, 20, 20]} />
        <meshBasicMaterial color={hotspot.color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}

// ── Escena ───────────────────────────────────────────────────────────────────
type SceneInternals = { camera: THREE.PerspectiveCamera | null; controls: any };

function SceneContent({ hotspots, selected, onSelect, autoRotate, onInteraction, innerRef }: {
  hotspots: Hotspot[]; selected: Hotspot | null;
  onSelect: (h: Hotspot | null) => void;
  autoRotate: boolean; onInteraction: () => void;
  innerRef: React.MutableRefObject<SceneInternals>;
}) {
  const { camera } = useThree();
  const ctrlRef = useRef<any>(null);
  useEffect(() => { innerRef.current.camera   = camera as THREE.PerspectiveCamera; });
  useEffect(() => { innerRef.current.controls = ctrlRef.current; }, []);

  return (
    <>
      <RendererConfig />

      {/* Iluminación idéntica al repo (viewer.ts buildEnvironment) */}
      <ambientLight    color={0xffffff} intensity={0.42} />
      <hemisphereLight color={0xfff8ee} groundColor={0x33252d} intensity={0.72} />
      <directionalLight position={[ 4.8,  6.5,  6.8]} intensity={3.5}  color={0xfff3e7} />
      <directionalLight position={[-4.5,  1.2,  5.2]} intensity={1.12} color={0xe6ecff} />
      <directionalLight position={[-4,    3.5, -5.5]} intensity={1.6}  color={0xffb7a5} />
      <pointLight position={[-3, -1.4, 3.5]} intensity={0.72} color={0xff8d70} decay={2} distance={11} />
      <pointLight position={[ 2.8, 0.4, 2.8]} intensity={0.5}  color={0xee7c6a} decay={2} distance={8} />

      {/* Plinto (mismo que el repo) */}
      <mesh position={[0, PLINTH_Y, 0]}>
        <cylinderGeometry args={[2.3, 2.48, 0.34, 56]} />
        <meshStandardMaterial color={0xead7c1} roughness={0.78} metalness={0} />
      </mesh>

      {/* Modelo + hotspots en el MISMO grupo rotado — comparten espacio local */}
      <group rotation={[0.05, -0.28, 0]}>
        <Suspense fallback={null}>
          <SkinMesh />
        </Suspense>
        {hotspots.map((h) => (
          <HotspotDot key={h.id} hotspot={h} isSelected={selected?.id === h.id} onSelect={onSelect} />
        ))}
      </group>

      <OrbitControls
        ref={ctrlRef}
        target={CAM_TARGET}
        minDistance={4.8}
        maxDistance={12}
        enablePan={false}
        autoRotate={autoRotate}
        autoRotateSpeed={0.65}
        dampingFactor={0.055}
        enableDamping
        onStart={onInteraction}
      />
    </>
  );
}

// ── API pública ───────────────────────────────────────────────────────────────
export interface SkinCanvasHandle { zoom: (dir: 1 | -1) => void; reset: () => void; }
export interface SkinCanvasProps {
  hotspots: Hotspot[]; selected: Hotspot | null;
  onSelect: (h: Hotspot | null) => void;
  autoRotate: boolean; onInteraction: () => void;
}

export const SkinCanvas = forwardRef<SkinCanvasHandle, SkinCanvasProps>(
  ({ hotspots, selected, onSelect, autoRotate, onInteraction }, ref) => {
    const { progress, active } = useProgress();
    const internals = useRef<SceneInternals>({ camera: null, controls: null });

    useImperativeHandle(ref, () => ({
      zoom(dir) {
        const cam = internals.current.camera;
        if (cam) cam.position.z = THREE.MathUtils.clamp(cam.position.z + dir * 1.2, 4.8, 12);
      },
      reset() {
        const cam = internals.current.camera;
        const ctrl = internals.current.controls;
        if (!cam) return;
        const sp = cam.position.clone();
        const ep = new THREE.Vector3(...CAM_POS);
        const st = ctrl?.target.clone() ?? new THREE.Vector3(...CAM_TARGET);
        const et = new THREE.Vector3(...CAM_TARGET);
        const t0 = performance.now();
        const lerp = () => {
          const t = Math.min((performance.now() - t0) / 800, 1);
          const e = 1 - Math.pow(1 - t, 3);
          cam.position.lerpVectors(sp, ep, e);
          if (ctrl) { ctrl.target.lerpVectors(st, et, e); ctrl.update(); }
          if (t < 1) requestAnimationFrame(lerp);
        };
        requestAnimationFrame(lerp);
      },
    }));

    return (
      <div className="absolute inset-0" style={{ background: VIEWER_BG }}>
        <Canvas
          camera={{ position: CAM_POS, fov: 34 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          onPointerMissed={() => onSelect(null)}
          style={{ width: '100%', height: '100%' }}
        >
          <SceneContent
            hotspots={hotspots}
            selected={selected}
            onSelect={onSelect}
            autoRotate={autoRotate}
            onInteraction={onInteraction}
            innerRef={internals}
          />
        </Canvas>

        {active && (
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
              <div className="h-1.5 rounded-full bg-[#deb887] transition-all" style={{ width: `${Math.max(8, Math.round(progress))}%` }} />
            </div>
            <p className="text-[#8d847c] text-xs mt-2">{Math.max(8, Math.round(progress))}%</p>
          </div>
        )}
      </div>
    );
  }
);
