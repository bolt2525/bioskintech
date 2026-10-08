import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

// Ejecutar el helper real sin herramientas/dependencias adicionales ni archivos temporales.
const source = readFileSync(new URL('../src/utils/clinicalPhotoDownload.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("import('@zip.js/zip.js')", `import(${JSON.stringify(import.meta.resolve('@zip.js/zip.js'))})`);
const { ClinicalPhotoDownloader, MAX_DOWNLOAD_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const photos = count => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  r2_url: `https://r2.example.test/private/patient-name-${index}.jpg?signature=secret`,
}));

function browser(t, fetcher, clickError = false) {
  const saved = { fetch: globalThis.fetch, document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timer: globalThis.setTimeout };
  const blobs = [];
  const revoked = [];
  const timers = [];
  const links = [];
  const requests = [];
  let attached = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.mode, 'cors');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined, 'Sin Authorization ni otros encabezados');
    return fetcher(url, options, requests.length);
  };
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'a');
      const link = {
        click() { if (clickError) throw new Error('click falló'); },
        remove() { attached--; },
      };
      links.push(link);
      return link;
    },
    body: { appendChild() { attached++; } },
  };
  t.after(() => {
    for (const callback of timers.splice(0)) callback();
    globalThis.fetch = saved.fetch;
    globalThis.document = saved.document;
    globalThis.setTimeout = saved.timer;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  });
  return { blobs, requests, links, revoked, cleanup() {
    for (const callback of timers.splice(0)) callback();
    assert.equal(attached, 0);
    assert.equal(revoked.length, blobs.length);
  } };
}

function streamed(size, { declared, onCancel, fill = 37 } = {}) {
  let remaining = size;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!remaining) { controller.close(); return; }
      const length = Math.min(1024 * 1024, remaining);
      remaining -= length;
      controller.enqueue(new Uint8Array(length).fill(fill));
    },
    cancel() { onCancel?.(); },
  }, { highWaterMark: 0 }), {
    headers: { 'content-type': 'image/jpeg', ...(declared === undefined ? {} : { 'content-length': String(declared) }) },
  });
}

async function readZip(blob) {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    return await Promise.all(entries.map(async entry => ({
      name: entry.filename,
      compression: entry.compressionMethod,
      bytes: await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false }),
    })));
  } finally { await reader.close(); }
}

test('ZIP real: 15 originales exactos, STORE, nombres únicos sin PHI y fetch secuencial sin auth', async t => {
  const originals = Array.from({ length: 15 }, (_, index) => new Uint8Array([0, index, 255, 128, 17]));
  let active = 0;
  let peak = 0;
  const env = browser(t, (_url, _options, count) => {
    active++;
    peak = Math.max(peak, active);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(originals[count - 1]); },
      pull(controller) { active--; controller.close(); },
    }), { headers: { 'content-type': count === 15 ? 'image/unknown' : 'image/jpeg' } });
  });
  const progress = [];
  const downloader = new ClinicalPhotoDownloader();
  await downloader.download(photos(15), true, value => progress.push(value));
  assert.equal(peak, 1);
  assert.equal(env.requests.length, 15);
  assert.equal(env.blobs.length, 1);
  const entries = await readZip(env.blobs[0]);
  assert.equal(entries.length, 15);
  assert.equal(new Set(entries.map(entry => entry.name)).size, 15);
  entries.forEach((entry, index) => {
    assert.equal(entry.name, `foto-${index + 1}.${index === 14 ? 'bin' : 'jpg'}`);
    assert.equal(entry.compression, 0);
    assert.deepEqual(entry.bytes, originals[index]);
  });
  assert.equal(env.links[0].download, 'fotos-originales.zip');
  assert.equal(progress.at(-1).bytes, 75);
  assert.equal(downloader.busy, false);
  env.cleanup();
});

test('16 fotos se rechazan antes de fetch o creación de ZIP', async t => {
  const env = browser(t, () => { throw new Error('No debe llamar fetch'); });
  await assert.rejects(new ClinicalPhotoDownloader().download(photos(16), true), /1 y 15/);
  assert.equal(env.requests.length, 0);
  assert.equal(env.blobs.length, 0);
});

test('guardas en frontera: vacío, ID inseguro, duplicado, URL inválida y descarga individual múltiple', async t => {
  const env = browser(t, () => { throw new Error('No debe llamar fetch'); });
  const downloader = new ClinicalPhotoDownloader();
  for (const selection of [
    [], [{ id: 0, r2_url: photos(1)[0].r2_url }],
    [{ id: Number.MAX_SAFE_INTEGER + 1, r2_url: photos(1)[0].r2_url }],
    [photos(1)[0], photos(1)[0]], [{ id: 1, r2_url: 'javascript:alert(1)' }],
    [{ id: 1, r2_url: 'https://user:password@r2.example.test/photo' }],
    [{ id: 1, r2_url: undefined }], [null],
  ]) await assert.rejects(downloader.download(selection, true));
  await assert.rejects(downloader.download(photos(2), false));
  assert.equal(env.requests.length, 0);
});

test('100 MiB agregados exactos sin Content-Length: ZIP completo, ambas entradas y bytes intactos', async t => {
  const half = MAX_DOWNLOAD_BYTES / 2;
  const env = browser(t, () => streamed(half));
  await new ClinicalPhotoDownloader().download(photos(2), true);
  const entries = await readZip(env.blobs[0]);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.bytes.length, half);
    assert.equal(entry.compression, 0);
    assert.ok(entry.bytes.every(byte => byte === 37));
  }
  env.cleanup();
});

test('100 MiB + 1 real agregado con Content-Length falso: cancela lector, no descarga ZIP parcial', async t => {
  let canceled = 0;
  const env = browser(t, (_url, _options, count) => streamed(
    count === 1 ? MAX_DOWNLOAD_BYTES / 2 : MAX_DOWNLOAD_BYTES / 2 + 1,
    { declared: 1, onCancel: () => canceled++ },
  ));
  const downloader = new ClinicalPhotoDownloader();
  await assert.rejects(downloader.download(photos(2), true), /supera 100 MiB/);
  assert.equal(canceled, 1);
  assert.equal(env.blobs.length, 0);
  assert.equal(downloader.busy, false);
});

test('Content-Length excesivo cancela antes de leer el cuerpo', async t => {
  let reads = 0;
  let canceled = 0;
  const env = browser(t, () => new Response(new ReadableStream({
    pull() { reads++; },
    cancel() { canceled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } }));
  await assert.rejects(new ClinicalPhotoDownloader().download(photos(1), true), /100 MiB/);
  assert.equal(reads, 0);
  assert.equal(canceled, 1);
  assert.equal(env.blobs.length, 0);
});

for (const status of [401, 403, 404, 500]) {
  test(`HTTP ${status} tras un original: error explícito, sin ZIP parcial ni bypass`, async t => {
    let canceled = 0;
    const env = browser(t, (_url, _options, count) => count === 1
      ? streamed(8)
      : new Response(new ReadableStream({ cancel() { canceled++; } }), { status }));
    const downloader = new ClinicalPhotoDownloader();
    await assert.rejects(downloader.download(photos(3), true), error =>
      error.message.includes(`HTTP ${status}`) && /Actualiza la lista/.test(error.message));
    assert.equal(env.requests.length, 2, 'No continuar ni reintentar automáticamente');
    assert.equal(canceled, 1);
    assert.equal(env.blobs.length, 0);
    assert.equal(downloader.busy, false);
  });
}

test('fallo CORS/red explícito sin archivo ni reintento automático', async t => {
  const env = browser(t, () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(new ClinicalPhotoDownloader().download(photos(1), false), /red o CORS.*Actualiza la lista/);
  assert.equal(env.requests.length, 1);
  assert.equal(env.blobs.length, 0);
});

test('fallo de red a mitad del cuerpo no omite bytes ni entrega un ZIP parcial', async t => {
  const env = browser(t, (_url, _options, count) => count === 1 ? streamed(4) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    pull(controller) { controller.error(new TypeError('Connection lost')); },
  })));
  const downloader = new ClinicalPhotoDownloader();
  await assert.rejects(downloader.download(photos(3), true), /Lectura interrumpida.*red o CORS.*Actualiza la lista/);
  assert.equal(env.requests.length, 2);
  assert.equal(env.blobs.length, 0);
  assert.equal(downloader.busy, false);
});

test('paquetes ZIP repetibles sin contador diario ni anual', async t => {
  const env = browser(t, () => streamed(5));
  const downloader = new ClinicalPhotoDownloader();
  for (let index = 0; index < 3; index++) {
    await downloader.download(photos(2), true);
    const entries = await readZip(env.blobs[index]);
    assert.equal(entries.length, 2);
    for (const entry of entries) assert.deepEqual(entry.bytes, new Uint8Array(5).fill(37));
  }
  assert.equal(env.requests.length, 6);
  env.cleanup();
});

test('descarga individual blob original (sin abrir imagen), repetible y revoca todas las URLs', async t => {
  const bytes = new Uint8Array([255, 0, 3, 4, 5]);
  const env = browser(t, () => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
  const downloader = new ClinicalPhotoDownloader();
  for (let index = 0; index < 3; index++) await downloader.download(photos(1), false);
  assert.equal(env.blobs.length, 3);
  for (const blob of env.blobs) assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  for (const link of env.links) {
    assert.equal(link.download, 'foto-1.png');
    assert.match(link.href, /^blob:/);
    assert.equal(link.target, undefined);
  }
  env.cleanup();
});

test('doble descarga en vuelo se bloquea; cancelación interrumpe lectura y permite otra descarga', async t => {
  let began;
  const reading = new Promise(resolve => { began = resolve; });
  let canceled = 0;
  const env = browser(t, (_url, _options, count) => count === 1
    ? new Response(new ReadableStream({
      pull() { began(); },
      cancel() { canceled++; },
    }, { highWaterMark: 0 }))
    : streamed(10));
  const downloader = new ClinicalPhotoDownloader();
  const first = downloader.download(photos(1), true);
  const aborted = assert.rejects(first, { name: 'AbortError' });
  await reading;
  assert.equal(downloader.busy, true);
  await assert.rejects(downloader.download(photos(1), false), /en curso/);
  assert.equal(env.requests.length, 1);
  downloader.cancel();
  await aborted;
  assert.equal(canceled, 1);
  assert.equal(env.blobs.length, 0);
  assert.equal(downloader.busy, false);
  await downloader.download(photos(1), false);
  assert.equal(env.blobs.length, 1);
  env.cleanup();
});

test('cancelación durante fetch: AbortSignal, sin archivo y desbloqueo', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const env = browser(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    began();
  }));
  const downloader = new ClinicalPhotoDownloader();
  const pending = downloader.download(photos(1), false);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  downloader.cancel();
  await rejected;
  assert.equal(env.blobs.length, 0);
  assert.equal(downloader.busy, false);
});

test('limpia link y URL aunque iniciar la descarga falle', async t => {
  const env = browser(t, () => streamed(3), true);
  const downloader = new ClinicalPhotoDownloader();
  await assert.rejects(downloader.download(photos(1), false), /click falló/);
  assert.equal(downloader.busy, false);
  env.cleanup();
});

test('selección capturada antes del await: no usar URL ni IDs mutados durante la descarga', async t => {
  const selection = photos(1);
  const env = browser(t, () => streamed(3));
  const pending = new ClinicalPhotoDownloader().download(selection, true);
  selection[0].id = 99;
  selection[0].r2_url = 'https://another.example.test/changed';
  await pending;
  assert.match(env.requests[0].url, /r2\.example\.test/);
  assert.equal((await readZip(env.blobs[0]))[0].name, 'foto-1.jpg');
  env.cleanup();
});

// Harness de hooks/elementos React 18: prueba eventos y efectos reales del componente.
// No sustituye QA de teclado, foco, CORS ni descarga real en el navegador.
const require = createRequire(import.meta.url);
const tabSource = readFileSync(new URL('../src/components/admin/ficha-clinica/components/tabs/PhotosTab.tsx', import.meta.url), 'utf8');
function tabHarness(listRequest, Downloader = ClinicalPhotoDownloader) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let props = { recordId: 1, patientName: 'Nombre ficticio NO exportar' };
  let tree;
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    ...require('react'),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = {
          value: typeof initial === 'function' ? initial() : initial,
          setter: value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; },
        };
      }
      return [slots[index].value, slots[index].setter];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { deps, cleanup };
        effects.push(() => { cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const context = {
    exports: {}, console,
    setTimeout: () => 1, clearTimeout: () => undefined,
    window: { addEventListener() {}, removeEventListener() {} },
    confirm: () => true,
    DOMException,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'framer-motion') return { motion: { div: 'div', img: 'img' }, AnimatePresence: 'div' };
      if (name === 'lucide-react') return new Proxy({}, { get: (_target, key) => key });
      if (name.endsWith('/recordsFetch')) return { default: listRequest, __esModule: true };
      if (name.endsWith('/clinicalPhotoDownload')) return { ClinicalPhotoDownloader: Downloader, MAX_DOWNLOAD_PHOTOS: 15 };
      if (name.endsWith('/Dialog')) return { Dialog: 'dialog' };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(ts.transpileModule(tabSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, context);
  function render(nextProps) {
    if (nextProps) props = { ...props, ...nextProps };
    cursor = 0;
    effects = [];
    tree = context.exports.default(props);
    for (const effect of effects) effect();
    return tree;
  }
  function nodes() {
    const found = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object' || !node.props) return;
      found.push(node);
      visit(node.props.children);
    }
    visit(tree);
    return found;
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    return text(node.props?.children);
  }
  const button = label => nodes().find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  const cards = () => nodes().filter(node => node.type?.name === 'PhotoCard');
  return {
    render, cards, text: () => text(tree), button,
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

const clinicalPhotos = count => photos(count).map(photo => ({
  ...photo, record_id: 1, photo_type: photo.id % 2 ? 'before' : 'after',
  created_at: '2026-10-07T12:00:00Z',
}));
const listResponse = entries => ({
  ok: true,
  json: async () => ({ photos: entries, total: entries.length, hasMore: false }),
});

test('galería: límite de 15 selectores y cambio de filtro limpia explícitamente toda la selección', async t => {
  const harness = tabHarness(async () => listResponse(clinicalPhotos(16)));
  t.after(() => harness.unmount());
  harness.render();
  await harness.settle();
  for (let index = 0; index < 15; index++) {
    const card = harness.cards()[index];
    card.props.onDownloadToggle(card.props.photo);
    harness.render();
  }
  assert.match(harness.text(), /15\/15 seleccionadas/);
  assert.equal(harness.cards()[15].props.downloadSelectionDisabled, true);
  // Incluso un evento obsoleto no excede el límite del estado.
  const sixteenth = harness.cards()[15];
  sixteenth.props.onDownloadToggle(sixteenth.props.photo);
  harness.render();
  assert.match(harness.text(), /15\/15 seleccionadas/);
  // La línea de tiempo no consume ni modifica la selección de descarga.
  harness.button('Línea de tiempo').props.onClick();
  harness.render();
  assert.match(harness.text(), /15\/15 seleccionadas/);
  harness.button('Galería').props.onClick();
  harness.render();
  const filter = harness.button('Después(8)');
  assert.ok(filter);
  filter.props.onClick();
  harness.render();
  assert.match(harness.text(), /0\/15 seleccionadas/);
  assert.match(harness.text(), /borrada al cambiar el filtro/);
});

test('eliminar una foto seleccionada no excluye silenciosamente una entrada: borra todo el paquete', async t => {
  const harness = tabHarness(async url => url.includes('listPhotos') ? listResponse(clinicalPhotos(2)) : { ok: true });
  t.after(() => harness.unmount());
  harness.render();
  await harness.settle();
  for (const card of harness.cards()) card.props.onDownloadToggle(card.props.photo);
  harness.render();
  const card = harness.cards()[0];
  await card.props.onDelete(card.props.photo);
  harness.render();
  harness.render();
  assert.match(harness.text(), /0\/15 seleccionadas/);
  assert.match(harness.text(), /una foto fue eliminada/);
});

test('actualizar enlaces usa listPhotos existente y requiere reselección, sin fetch R2 automático', async t => {
  const requests = [];
  const harness = tabHarness(async url => {
    requests.push(url);
    return listResponse(clinicalPhotos(2));
  });
  t.after(() => harness.unmount());
  harness.render();
  await harness.settle();
  const card = harness.cards()[0];
  card.props.onDownloadToggle(card.props.photo);
  harness.render();
  harness.button('Actualizar lista y enlaces').props.onClick();
  harness.render();
  await harness.settle();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.startsWith('/api/records?action=listPhotos')));
  assert.match(harness.text(), /0\/15 seleccionadas/);
  assert.match(harness.text(), /vuelve a seleccionar las fotos/);
});

test('cambio de ficha descarta respuestas tardías; cancela descarga activa y no restaura selección', async t => {
  let resolveOld;
  const oldList = new Promise(resolve => { resolveOld = resolve; });
  const harness = tabHarness(url => url.includes('record_id=1&') ? oldList : Promise.resolve(listResponse(
    clinicalPhotos(1).map(photo => ({ ...photo, id: 22, record_id: 2 })),
  )));
  t.after(() => harness.unmount());
  harness.render();
  harness.render({ recordId: 2 });
  await harness.settle();
  resolveOld(listResponse(clinicalPhotos(2)));
  await harness.settle();
  assert.deepEqual(harness.cards().map(card => card.props.photo.id), [22]);
  assert.match(harness.text(), /0\/15 seleccionadas/);

  let began;
  const started = new Promise(resolve => { began = resolve; });
  let canceled = 0;
  const env = browser(t, () => new Response(new ReadableStream({
    pull() { began(); }, cancel() { canceled++; },
  }, { highWaterMark: 0 })));
  const card = harness.cards()[0];
  const pending = card.props.onDownload(card.props.photo);
  await started;
  await card.props.onDownload(card.props.photo);
  assert.equal(env.requests.length, 1, 'También bloquea doble clic desde la UI antes del render');
  harness.render({ recordId: 3 });
  await pending;
  harness.render();
  assert.equal(canceled, 1);
  assert.equal(env.blobs.length, 0);
  assert.match(harness.text(), /0\/15 seleccionadas/);
  assert.doesNotMatch(harness.text(), /Descarga preparada/);
});

test('desmontaje aborta descarga activa sin actualizar UX ni producir ZIP parcial', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let canceled = 0;
  const env = browser(t, () => new Response(new ReadableStream({
    pull() { began(); }, cancel() { canceled++; },
  }, { highWaterMark: 0 })));
  const harness = tabHarness(async () => listResponse(clinicalPhotos(1)));
  harness.render();
  await harness.settle();
  const card = harness.cards()[0];
  card.props.onDownloadToggle(card.props.photo);
  harness.render();
  const pending = harness.button('Descargar ZIP de originales').props.onClick();
  await started;
  harness.unmount();
  await pending;
  assert.equal(canceled, 1);
  assert.equal(env.blobs.length, 0);
});
