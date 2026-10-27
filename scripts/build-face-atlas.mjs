/**
 * Generación local SIN pacientes/red/dependencias nuevas.
 * Terminal 1: node scripts/build-face-atlas.mjs
 * Terminal 2: agent-browser --session face-atlas-build open http://127.0.0.1:5201/__face-atlas
 * Al recibir la detección real, escribe el JSON, cierra Vite y termina.
 * Cerrar después: agent-browser --session face-atlas-build close
 * --check: solo verifica hash del GLB y geometría normalizada, sin navegador.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const modelPath = 'public/models/clinical/male_head.glb';
const atlasPath = 'src/lab/faceSim/genericFaceAtlas.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Exactamente bbox mundial de meshes (excepto SCALP_HAIR_SOURCE), scale primero, offset después. */
export function normalizeModel(model, THREE) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  model.traverse(mesh => {
    if (!mesh.isMesh || mesh.name === 'SCALP_HAIR_SOURCE') return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const scale = 5 / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  model.position.copy(center).multiplyScalar(-scale);
  model.updateMatrixWorld(true);
  return { center: center.toArray(), scale, maxDim: 5, axes: 'x derecha, y arriba, z frontal' };
}

export function extractMesh(model, THREE) {
  const positions = [], triangles = [];
  model.traverse(mesh => {
    if (!mesh.isMesh || mesh.name === 'SCALP_HAIR_SOURCE') return;
    const attribute = mesh.geometry.getAttribute('position'), offset = positions.length / 3;
    for (let i = 0; i < attribute.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld);
      positions.push(p.x, p.y, p.z);
    }
    const indices = mesh.geometry.index;
    for (let i = 0; i < (indices?.count ?? attribute.count); i++) triangles.push(offset + (indices ? indices.getX(i) : i));
  });
  return { positions, triangles };
}

export async function readNormalizedModel() {
  const bytes = await readFile(modelPath);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const normalization = normalizeModel(gltf.scene, THREE);
  return { surface: extractMesh(gltf.scene, THREE), normalization, hash: sha256(bytes) };
}

async function browserBuild() {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const model = (await new GLTFLoader().loadAsync('/models/clinical/male_head.glb')).scene;
  const normalization = normalizeModel(model, THREE);
  const surface = extractMesh(model, THREE);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d9dce1');
  scene.add(model, new THREE.HemisphereLight(0xffffff, 0x645344, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-3, 5, 8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  fill.position.set(3, 1, 5);
  scene.add(fill);
  model.traverse(mesh => {
    if (mesh.isMesh) mesh.material = new THREE.MeshStandardMaterial({ color: '#cda48c', roughness: 0.8 });
  });
  // El encuadre incluye el GLB completo, sin perspectiva ni transformación del rostro.
  const frame = { left: -2.65, right: 2.65, top: 2.65, bottom: -2.65, width: 1400, height: 1400 };
  const camera = new THREE.OrthographicCamera(frame.left, frame.right, frame.top, frame.bottom, 0.1, 30);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(frame.width, frame.height);
  renderer.setPixelRatio(1);
  document.body.append(renderer.domElement);
  renderer.render(scene, camera);
  const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  const detector = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/models/face/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 1, minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  const detection = detector.detect(renderer.domElement);
  const landmarks = detection.faceLandmarks[0]?.slice(0, 468);
  if (landmarks?.length !== 468) throw new Error('MediaPipe no detectó mesh468 en el render original.');
  const positions = [], rayHits = [], adjustments = [];
  const raycaster = new THREE.Raycaster();
  for (let index = 0; index < landmarks.length; index++) {
    const p = landmarks[index];
    raycaster.setFromCamera(new THREE.Vector2(p.x * 2 - 1, 1 - p.y * 2), camera);
    let hit = raycaster.intersectObject(model, true)[0];
    // Los ojos del GLB son agujeros reales. El detector puede situar un borde
    // subpíxel dentro del agujero: buscar SOLO geometría original contigua,
    // con corrección acotada y registrada; jamás fabricar un globo/cierre.
    if (!hit) {
      const xy = new THREE.Vector3(frame.left + p.x * (frame.right - frame.left),
        frame.top - p.y * (frame.top - frame.bottom), 0);
      let closest = null, distance = Infinity;
      for (let t = 0; t < surface.triangles.length; t += 3) {
        const points = surface.triangles.slice(t, t + 3).map(i => new THREE.Vector3(...surface.positions.slice(i * 3, i * 3 + 3)));
        const normal = new THREE.Vector3().crossVectors(points[1].clone().sub(points[0]), points[2].clone().sub(points[0]));
        if (normal.z <= 0 || points.some(q => q.z < 0)) continue;
        const flat = points.map(q => new THREE.Vector3(q.x, q.y, 0));
        const triangle = new THREE.Triangle(...flat);
        const q = triangle.closestPointToPoint(xy, new THREE.Vector3());
        const d = q.distanceTo(xy);
        if (d >= distance) continue;
        // Desplazamiento hacia el interior de la cara original, no hacia el agujero.
        closest = q.lerp(triangle.getMidpoint(new THREE.Vector3()), 0.001);
        distance = d;
      }
      if (!closest || distance > 0.08) throw new Error(`Landmark ${index} fuera del mesh (${distance}); no inferir.`);
      const uv = new THREE.Vector2((closest.x - frame.left) / (frame.right - frame.left),
        (frame.top - closest.y) / (frame.top - frame.bottom));
      raycaster.setFromCamera(new THREE.Vector2(uv.x * 2 - 1, 1 - uv.y * 2), camera);
      hit = raycaster.intersectObject(model, true)[0];
      adjustments.push({ index, reason: 'borde de agujero real: snap acotado a triángulo original', distance, xy: closest.toArray().slice(0, 2) });
    }
    if (!hit) throw new Error(`Landmark ${index} sin intersección real; no se permite inferirlo.`);
    positions.push(...hit.point.toArray());
    rayHits.push({ mesh: hit.object.name, face: hit.faceIndex, distance: hit.distance });
  }
  const triangles = [];
  const edges = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  for (let i = 0; i + 2 < edges.length; i += 3) {
    const [a, b, c] = [edges[i], edges[i + 1], edges[i + 2]];
    if (a.end !== b.start || b.end !== c.start || c.end !== a.start) throw new Error('Teselación no compatible.');
    triangles.push(a.start, b.start, c.start);
  }
  // El detector puede producir pliegues subpíxel junto al ala nasal. Corregir
  // únicamente esas inversiones (área firmada positiva), nunca hacer warp
  // desde los 27 anclajes ni suavizar el labio. Después SIEMPRE repetir raycast.
  const detectedPositions = positions.slice();
  for (let iteration = 0; iteration < 200; iteration++) {
    let corrected = false;
    for (let t = 0; t < triangles.length; t += 3) {
      const indices = triangles.slice(t, t + 3);
      const [a, b, c] = indices.map(i => [positions[i * 3], positions[i * 3 + 1]]);
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area >= 1e-6) continue;
      const gradients = [[b[1] - c[1], c[0] - b[0]], [c[1] - a[1], a[0] - c[0]], [a[1] - b[1], b[0] - a[0]]];
      const denominator = gradients.flat().reduce((s, v) => s + v * v, 0);
      if (denominator < 1e-12) throw new Error('Chart colapsado; requiere revisar detección.');
      const step = (1.1e-6 - area) / denominator;
      indices.forEach((id, i) => {
        positions[id * 3] += gradients[i][0] * step;
        positions[id * 3 + 1] += gradients[i][1] * step;
      });
      corrected = true;
    }
    if (!corrected) break;
    if (iteration === 199) throw new Error('No se pudo eliminar un pliegue sin inferencia.');
  }
  const topologyCorrections = [];
  for (let i = 0; i < 468; i++) {
    const distance = Math.hypot(positions[i * 3] - detectedPositions[i * 3], positions[i * 3 + 1] - detectedPositions[i * 3 + 1]);
    if (!distance) continue;
    if (distance > 0.015) throw new Error(`Corrección topológica excesiva en ${i}.`);
    raycaster.setFromCamera(new THREE.Vector2(
      (positions[i * 3] - frame.left) / (frame.right - frame.left) * 2 - 1,
      (positions[i * 3 + 1] - frame.bottom) / (frame.top - frame.bottom) * 2 - 1,
    ), camera);
    const hit = raycaster.intersectObject(model, true)[0];
    if (!hit) throw new Error(`Corrección ${i} fuera del mesh.`);
    topologyCorrections.push({ index: i, distance, from: detectedPositions.slice(i * 3, i * 3 + 3), to: hit.point.toArray() });
    positions.splice(i * 3, 3, ...hit.point.toArray());
    rayHits[i] = { mesh: hit.object.name, face: hit.faceIndex, distance: hit.distance };
  }
  // Prueba visual reproducible en la página, no se guarda ninguna foto.
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.canvas.width = frame.width;
  ctx.canvas.height = frame.height;
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.fillStyle = '#ff0044';
  for (let i = 0; i < positions.length; i += 3) {
    ctx.beginPath();
    ctx.arc((positions[i] - frame.left) / (frame.right - frame.left) * frame.width,
      (frame.top - positions[i + 1]) / (frame.top - frame.bottom) * frame.height, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  document.body.append(ctx.canvas);
  detector.close();
  const result = {
    positions, triangles, surface,
    modelId: 'clinical/male_head.glb:mesh468:v1',
    provenance: {
      schemaVersion: 1, normalization, frame,
      method: 'MediaPipe IMAGE CPU sobre render ortográfico +Z del GLB ORIGINAL, raycast de cada uno de los 468 landmarks',
      landmarkCount: 468, triangleCount: triangles.length / 3,
      detector: '@mediapipe/tasks-vision', detectorVersion: '1.1.0',
      render: { material: '#cda48c', roughness: 0.8, hemisphere: 2, key: [-3, 5, 8, 3], fill: [3, 1, 5, 1] },
      detection: landmarks.map(p => [p.x, p.y, p.z]), rayHits, adjustments, topologyCorrections,
      limitations: 'Un chart frontal observado; no orejas/nuca/casquete ni cierre de boca/ojos. Detección algorítmica, no validación clínica.',
    },
  };
  const response = await fetch('/__face-atlas/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
  });
  if (!response.ok) throw new Error(await response.text());
  document.title = 'Atlas generado: 468 intersecciones reales';
  document.querySelector('h1').textContent = document.title;
  window.__atlasResult = { count: positions.length / 3, triangles: triangles.length / 3 };
}

async function main() {
  const original = await readNormalizedModel();
  if (process.argv.includes('--check')) {
    const atlas = JSON.parse(await readFile(atlasPath, 'utf8'));
    if (atlas.provenance.glbSha256 !== original.hash || JSON.stringify(atlas.surface) !== JSON.stringify(original.surface)) {
      throw new Error('El atlas no coincide con el GLB original normalizado.');
    }
    console.log(`GLB y geometría exactos: ${original.hash}`);
    return;
  }
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, server: { host: '127.0.0.1', port: 5201, strictPort: true },
    plugins: [{
      name: 'local-face-atlas',
      resolveId(id) { if (id === '/__face-atlas-entry.js') return '\0face-atlas-entry'; },
      load(id) {
        if (id === '\0face-atlas-entry') return `${normalizeModel.toString()}\n${extractMesh.toString()}\n(${browserBuild.toString()})().catch(e=>{document.querySelector('h1').textContent=String(e);console.error(e)})`;
      },
      configureServer(vite) {
        vite.middlewares.use('/__face-atlas/result', async (req, res) => {
          try {
            if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:5201') {
              res.statusCode = 403; res.end('Solo generación local.'); return;
            }
            let body = '';
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 2_000_000) throw new Error('Resultado excesivo.');
            }
            const atlas = JSON.parse(body);
            if (atlas.positions.length !== 468 * 3 || atlas.provenance.rayHits.length !== 468
              || JSON.stringify(atlas.surface) !== JSON.stringify(original.surface)) throw new Error('Geometría/detección no compatible.');
            atlas.provenance.glbSha256 = original.hash;
            atlas.provenance.detectorSha256 = sha256(await readFile('public/models/face/face_landmarker.task'));
            atlas.provenance.generatorSha256 = sha256(await readFile(new URL(import.meta.url)));
            // JSON generado, no redirección de salidas de herramientas.
            await writeFile(atlasPath, `${JSON.stringify(atlas)}\n`);
            res.end('Atlas generado.');
            console.log(`Atlas: 468 puntos reales, ${atlas.triangles.length / 3} triángulos. GLB sha256=${original.hash}`);
            setTimeout(() => { void server.close(); }, 500);
          } catch (error) { res.statusCode = 400; res.end(String(error)); }
        });
        vite.middlewares.use('/__face-atlas', (req, res, next) => {
          if (req.url !== '/' && req.url !== '') return next();
          res.setHeader('Content-Type', 'text/html');
          // tasks-vision incluye telemetría: bloquear TODA conexión saliente,
          // incluso con assets locales. Solo WASM/modelo/POST y HMR locales.
          res.setHeader('Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; connect-src 'self' ws://127.0.0.1:5201; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
          res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Generando atlas facial</title><h1>Generando atlas del GLB original…</h1><script type="module" src="/__face-atlas-entry.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  console.log('Abra: agent-browser --session face-atlas-build open http://127.0.0.1:5201/__face-atlas');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
