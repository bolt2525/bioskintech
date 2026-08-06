/**
 * SkinCanvas — Visor 3D usando @react-three/fiber + @react-three/drei.
 * useGLTF maneja KHR_materials_volume, MeshoptDecoder y textures correctamente.
 * Los hotspots usan el sistema de eventos de fiber (raycasting nativo, 100% confiable).
 */
import { forwardRef, Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, OrbitControls, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { Microscope } from 'lucide-react';
import type { Hotspot } from './skin-data';

const FIT_SIZE = 2.8;
const CAMERA_POS: [number, number, number] = [0, 1.3, 10];
const ORBIT_TARGET: [number, number, number] = [0, 0.7, 0];
const VIEWER_BG = 'radial-gradient(circle at 55% 45%, rgba(255,255,255,0.92), rgba(255,250,242,0.72) 45%, rgba(246,236,224,0.70)), #f7f0e7';

useGLTF.preload('/models/clinical/skin.glb');

// ── Modelo de piel ────────────────────────────────────────────────────────────

function SkinMesh() {
  const { scene } = useGLTF('/models/clinical/skin.glb');

  useEffect(() => {
    // Centrar y escalar igual que el motor original
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = FIT_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    scene.scale.setScalar(s);
    const sc = center.multiplyScalar(s);
    scene.position.set(-sc.x, -sc.y, -sc.z);
  }, [scene]);

  return <primitive object={scene} rotation={[0.05, -0.28, 0]} />;
}

// ── Hotspot interactivo ───────────────────────────────────────────────────────

function HotspotDot({ hotspot, isSelected, onSelect }: {
  hotspot: Hotspot;
  isSelected: boolean;
  onSelect: (h: Hotspot) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const pulseRef = useRef<THREE.Mesh>(null!);
  const [hovered, setHovered] = useState(false);
  const t = useRef(0);

  useFrame((_, delta) => {
    t.current += delta;
    if (meshRef.current) {
      meshRef.current.scale.setScalar(hovered ? 1.35 : isSelected ? 1 + Math.sin(t.current * 3.5) * 0.18 : 1);
    }
    if (pulseRef.current) {
      const beat = (t.current * 0.75) % 1;
      pulseRef.current.scale.setScalar(isSelected ? 1.3 + beat * 1.8 : 0.001);
      const mat = pulseRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = isSelected ? (1 - beat) * 0.55 : 0;
    }
  });

  return (
    <group position={hotspot.position as [number, number, number]}>
      {/* Anillo de pulso */}
      <mesh ref={pulseRef} renderOrder={9}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshBasicMaterial color={hotspot.color} transparent opacity={0} depthTest={false} />
      </mesh>
      {/* Dot principal */}
      <mesh
        ref={meshRef}
        renderOrder={10}
        onClick={(e) => { e.stopPropagation(); onSelect(hotspot); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color={hotspot.color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}

// ── Escena interior (necesita contexto de fiber) ──────────────────────────────

interface SceneInnerProps {
  hotspots: Hotspot[];
  selected: Hotspot | null;
  onSelect: (h: Hotspot | null) => void;
  autoRotate: boolean;
  onInteraction: () => void;
  innerRef: React.MutableRefObject<SceneInternals>;
}

type SceneInternals = {
  camera: THREE.PerspectiveCamera | null;
  controls: { target: THREE.Vector3; update: () => void } | null;
};

function SceneInner({ hotspots, selected, onSelect, autoRotate, onInteraction, innerRef }: SceneInnerProps) {
  const { camera } = useThree();
  const ctrlRef = useRef<any>(null);

  useEffect(() => {
    innerRef.current.camera = camera as THREE.PerspectiveCamera;
  });

  useEffect(() => {
    innerRef.current.controls = ctrlRef.current;
  }, [ctrlRef.current]);

  return (
    <>
      <ambientLight intensity={0.55} color={0xfff8ee} />
      <hemisphereLight args={[0xffe8d0 as unknown as number, 0x8b7060 as unknown as number, 0.80]} />
      <directionalLight position={[4.8, 6.5, 6.8]} intensity={2.0} color={0xffeedd} />
      <directionalLight position={[-4.5, 1.2, 5.2]} intensity={0.75} color={0xe0e8ff} />
      <directionalLight position={[-4, 3.5, -5.5]} intensity={0.9} color={0xffb090} />

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

      <OrbitControls
        ref={ctrlRef}
        target={ORBIT_TARGET}
        minDistance={4.5}
        maxDistance={14}
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
      zoom(dir: 1 | -1) {
        const cam = internals.current.camera;
        if (!cam) return;
        cam.position.z = THREE.MathUtils.clamp(cam.position.z + dir * 1.2, 4.5, 14);
      },
      reset() {
        const cam = internals.current.camera;
        const ctrl = internals.current.controls;
        if (!cam) return;
        const startPos = cam.position.clone();
        const endPos = new THREE.Vector3(...CAMERA_POS);
        const startTarget = ctrl?.target.clone() ?? new THREE.Vector3(...ORBIT_TARGET);
        const endTarget = new THREE.Vector3(...ORBIT_TARGET);
        const t0 = performance.now();
        const lerp = () => {
          const t = Math.min((performance.now() - t0) / 800, 1);
          const e = 1 - Math.pow(1 - t, 3);
          cam.position.lerpVectors(startPos, endPos, e);
          if (ctrl) { ctrl.target.lerpVectors(startTarget, endTarget, e); ctrl.update(); }
          if (t < 1) requestAnimationFrame(lerp);
        };
        requestAnimationFrame(lerp);
      },
    }));

    return (
      <div className="absolute inset-0" style={{ background: VIEWER_BG }}>
        <Canvas
          camera={{ position: CAMERA_POS, fov: 34 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          onPointerMissed={() => onSelect(null)}
          style={{ width: '100%', height: '100%' }}
        >
          <SceneInner
            hotspots={hotspots}
            selected={selected}
            onSelect={onSelect}
            autoRotate={autoRotate}
            onInteraction={onInteraction}
            innerRef={internals}
          />
        </Canvas>

        {active && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center z-20"
            style={{ background: 'rgba(251,246,238,0.75)', backdropFilter: 'blur(4px)' }}
          >
            <div className="w-14 h-14 rounded-2xl bg-[#deb887] flex items-center justify-center mb-4 animate-pulse">
              <Microscope size={28} className="text-white" />
            </div>
            <p className="text-[#2f2a27] font-semibold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>
              Preparando el modelo
            </p>
            <p className="text-[#8d847c] text-xs mt-1 mb-4">Cargando estructura de la piel...</p>
            <div className="w-48 rounded-full h-1.5" style={{ backgroundColor: 'rgba(117,91,70,0.15)' }}>
              <div
                className="h-1.5 rounded-full bg-[#deb887] transition-all"
                style={{ width: `${Math.max(8, Math.round(progress))}%` }}
              />
            </div>
            <p className="text-[#8d847c] text-xs mt-2">{Math.max(8, Math.round(progress))}%</p>
          </div>
        )}
      </div>
    );
  }
);
