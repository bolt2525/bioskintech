/**
 * SkinCanvas — Visor 3D con configuración EXACTA del repo thebuggeddev/anatomy.
 *
 * Problemas resueltos definitivamente:
 * - Color: env map PMREM idéntico + ACESFilmic + outputColorSpace SRGBColorSpace
 * - Hotspots: dentro del mismo grupo rotado que el modelo (mismo espacio local)
 * - Material: transmission=0 + envMapIntensity=0.32 exactamente como el repo original
 * - Plinto: cilindro bajo el modelo igual que en el visor original
 * - FIT_SIZE=3.8 (matches las posiciones de hotspots del repo)
 */
import { Suspense, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { Microscope } from 'lucide-react';
import type { Hotspot } from './skin-data';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes idénticas al repo de referencia (viewer.ts + loaders.ts)
// ─────────────────────────────────────────────────────────────────────────────
const FIT_SIZE    = 3.8;
const CAMERA_POS: [number, number, number] = [0, 1.05, 8.2];
const CAM_TARGET: [number, number, number] = [0, 0.02, 0];
const PLINTH_Y    = -2.5;
const VIEWER_BG   = 'radial-gradient(circle at 55% 45%, rgba(255,255,255,0.92), rgba(255,250,242,0.72) 45%, rgba(246,236,224,0.70)), #f7f0e7';

useGLTF.preload('/models/clinical/skin.glb');

// ─────────────────────────────────────────────────────────────────────────────
// Environment map idéntico al repo (gradiente crema→marrón vía PMREM)
// ─────────────────────────────────────────────────────────────────────────────
function EnvironmentSetup() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const width = 16, height = 32;
    const data = new Uint8Array(width * height * 4);
    const top    = new THREE.Color(0xfff3e4);
    const bottom = new THREE.Color(0x6b4f45);
    const mixed  = new THREE.Color();
    for (let y = 0; y < height; y++) {
      mixed.copy(bottom).lerp(top, Math.pow(1 - y / (height - 1), 0.7));
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i]   = Math.round(mixed.r * 255);
        data[i+1] = Math.round(mixed.g * 255);
        data[i+2] = Math.round(mixed.b * 255);
        data[i+3] = 255;
      }
    }
    const source = new THREE.DataTexture(data, width, height);
    source.mapping    = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    source.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromEquirectangular(source).texture;
    scene.environment = env;
    pmrem.dispose();
    source.dispose();
    return () => { env.dispose(); scene.environment = null; };
  }, [gl, scene]);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modelo de piel con procesamiento de materiales exacto del repo
// ─────────────────────────────────────────────────────────────────────────────
function SkinMesh() {
  const { scene } = useGLTF('/models/clinical/skin.glb');
  const didSetup = useRef(false);

  useEffect(() => {
    if (didSetup.current) return;
    didSetup.current = true;

    // 1. Normalizar a FIT_SIZE (loaders.ts del repo original)
    const box    = new THREE.Box3().setFromObject(scene);
    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = FIT_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    scene.scale.setScalar(s);
    scene.position.copy(center.multiplyScalar(-s));

    // 2. Procesar materiales — EXACTAMENTE como loaders.ts del repo
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      child.castShadow    = false;
      child.receiveShadow = false;

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((material) => {
        material.transparent = false;
        material.opacity     = 1;
        material.depthWrite  = true;
        material.depthTest   = true;
        material.side        = THREE.FrontSide;

        if (material instanceof THREE.MeshStandardMaterial) {
          material.roughness        = THREE.MathUtils.clamp(material.roughness ?? 0.5, 0.42, 0.62);
          material.metalness        = 0;
          material.envMapIntensity  = 0.32;  // valor exacto del repo
          material.emissive.set(0x000000);
          material.emissiveIntensity = 0;

          // KHR_materials_volume → MeshPhysicalMaterial con transmission > 0
          // Sin render pass de transmisión esto hace el modelo blanco.
          // El repo lo corrige con "clearcoat" in material.
          if ('clearcoat' in material) {
            const physical = material as THREE.MeshPhysicalMaterial;
            physical.clearcoat          = Math.min(Math.max(physical.clearcoat ?? 0, 0.08), 0.12);
            physical.clearcoatRoughness = 0.62;
            physical.transmission       = 0;  // ← la clave
            physical.thickness          = 0;
          }

          if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
          if (material.normalMap) material.normalScale.multiplyScalar(0.62);

          const maxAniso = 8; // configurado en canvas
          for (const map of [material.map, material.normalMap, material.roughnessMap,
                              (material as any).metalnessMap, material.aoMap, material.emissiveMap]) {
            if (!map) continue;
            map.anisotropy      = maxAniso;
            map.generateMipmaps = true;
            map.minFilter       = THREE.LinearMipmapLinearFilter;
            map.magFilter       = THREE.LinearFilter;
            map.needsUpdate     = true;
          }
        }
        material.needsUpdate = true;
      });
    });
  }, [scene]);

  // No ponemos rotation aquí — la pone el grupo padre para compartirla con los hotspots
  return <primitive object={scene} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotspot dot animado — DENTRO del grupo rotado para alinear con el modelo
// ─────────────────────────────────────────────────────────────────────────────
function HotspotDot({ hotspot, isSelected, onSelect }: {
  hotspot: Hotspot;
  isSelected: boolean;
  onSelect: (h: Hotspot) => void;
}) {
  const dotRef   = useRef<THREE.Mesh>(null!);
  const pulseRef = useRef<THREE.Mesh>(null!);
  const t        = useRef(0);

  useFrame((_, delta) => {
    t.current += delta;
    if (dotRef.current) {
      dotRef.current.scale.setScalar(isSelected ? 1 + Math.sin(t.current * 3.5) * 0.18 : 1);
    }
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
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color={hotspot.color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Escena completa (dentro del contexto de fiber)
// ─────────────────────────────────────────────────────────────────────────────
interface SceneProps {
  hotspots: Hotspot[];
  selected: Hotspot | null;
  onSelect: (h: Hotspot | null) => void;
  autoRotate: boolean;
  onInteraction: () => void;
  innerRef: React.MutableRefObject<SceneInternals>;
}
type SceneInternals = { camera: THREE.PerspectiveCamera | null; controls: any };

function SceneContent({ hotspots, selected, onSelect, autoRotate, onInteraction, innerRef }: SceneProps) {
  const { camera } = useThree();
  const ctrlRef   = useRef<any>(null);

  // Exponer camera y controls al SkinCanvas para los botones de herramienta
  useEffect(() => { innerRef.current.camera = camera as THREE.PerspectiveCamera; });
  useEffect(() => { innerRef.current.controls = ctrlRef.current; }, []);

  return (
    <>
      {/* Env map idéntico al repo */}
      <EnvironmentSetup />

      {/* Iluminación EXACTA del repo (viewer.ts buildEnvironment) */}
      <ambientLight color={0xffffff} intensity={0.42} />
      <hemisphereLight color={0xfff8ee} groundColor={0x33252d} intensity={0.72} />
      <directionalLight position={[4.8, 6.5, 6.8]} intensity={3.5} color={0xfff3e7} />
      <directionalLight position={[-4.5, 1.2, 5.2]} intensity={1.12} color={0xe6ecff} />
      <directionalLight position={[-4, 3.5, -5.5]} intensity={1.6} color={0xffb7a5} />
      <pointLight position={[-3, -1.4, 3.5]} intensity={0.72} color={0xff8d70} decay={2} distance={11} />
      <pointLight position={[2.8, 0.4, 2.8]} intensity={0.5} color={0xee7c6a} decay={2} distance={8} />

      {/* Plinto (idéntico al repo) */}
      <mesh position={[0, PLINTH_Y, 0]} receiveShadow={false}>
        <cylinderGeometry args={[2.3, 2.48, 0.34, 56]} />
        <meshStandardMaterial color={0xead7c1} roughness={0.78} metalness={0} />
      </mesh>

      {/* Modelo + hotspots dentro del MISMO grupo rotado — comparten el espacio local */}
      <group rotation={[0.05, -0.28, 0]}>
        <Suspense fallback={null}>
          <SkinMesh />
        </Suspense>
        {hotspots.map((h) => (
          <HotspotDot
            key={h.id}
            hotspot={h}
            isSelected={selected?.id === h.id}
            onSelect={onSelect}
          />
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

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────
export interface SkinCanvasHandle {
  zoom: (dir: 1 | -1) => void;
  reset: () => void;
}
export interface SkinCanvasProps {
  hotspots: Hotspot[];
  selected: Hotspot | null;
  onSelect: (h: Hotspot | null) => void;
  autoRotate: boolean;
  onInteraction: () => void;
}

export const SkinCanvas = forwardRef<SkinCanvasHandle, SkinCanvasProps>(
  ({ hotspots, selected, onSelect, autoRotate, onInteraction }, ref) => {
    const { progress, active } = useProgress();
    const internals = useRef<SceneInternals>({ camera: null, controls: null });

    useImperativeHandle(ref, () => ({
      zoom(dir) {
        const cam = internals.current.camera;
        if (!cam) return;
        cam.position.z = THREE.MathUtils.clamp(cam.position.z + dir * 1.2, 4.8, 12);
      },
      reset() {
        const cam  = internals.current.camera;
        const ctrl = internals.current.controls;
        if (!cam) return;
        const sp = cam.position.clone();
        const ep = new THREE.Vector3(...CAMERA_POS);
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
          camera={{ position: CAMERA_POS, fov: 34 }}
          gl={{
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
            // Ajustes idénticos al repo (viewer.ts constructor)
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.02,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
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
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20" style={{ background: 'rgba(251,246,238,0.75)', backdropFilter: 'blur(4px)' }}>
            <div className="w-14 h-14 rounded-2xl bg-[#deb887] flex items-center justify-center mb-4 animate-pulse">
              <Microscope size={28} className="text-white" />
            </div>
            <p className="text-[#2f2a27] font-semibold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>Preparando el modelo</p>
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
