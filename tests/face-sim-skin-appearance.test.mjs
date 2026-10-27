import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSkinAppearance } from '../src/lab/faceSim/skinAppearance.ts';

function fixture(pixel = () => [180, 130, 110], width = 128, height = width) {
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    image.data.set([...pixel(x, y), 255], (y * width + x) * 4);
  }
  return { image, mask };
}

function run(f) {
  return analyzeSkinAppearance(f.image, f.mask);
}

function assertEmpty(result, usable) {
  assert.equal(result.usable, usable, result.warnings.join('\n'));
  for (const channel of Object.values(result.channels)) {
    assert.equal(channel.coverage, 0);
    assert.equal(channel.status, usable ? 'no-signal' : 'unavailable');
    assert.equal(channel.highlightedPixels, 0);
    assert.ok(channel.rgba.every(value => value === 0));
  }
}

function fractionIn(channel, image, predicate) {
  let count = 0, highlighted = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (!predicate(x, y)) continue;
    count++;
    if (channel.rgba[(y * image.width + x) * 4 + 3]) highlighted++;
  }
  return highlighted / count;
}

test('superficie uniforme cálida: utilizable sin iluminar ningún canal; límites educativos explícitos', () => {
  const result = run(fixture());
  assertEmpty(result, true);
  assert.match(result.warnings.join(' '), /no es un diagnóstico/);
  assert.match(result.warnings.join(' '), /no identifican.*vasos superficiales o profundos ni poros reales/);
  assert.match(result.warnings.join(' '), /no un score clínico/);
});

test('manchas oscuras sintéticas: contraste localizado medible, no rojo ni textura uniforme', t => {
  const inside = (x, y) => (x - 64) ** 2 + (y - 64) ** 2 < 7 ** 2;
  const f = fixture((x, y) => inside(x, y) ? [125, 90, 76] : [180, 130, 110]);
  const result = run(f);
  assert.equal(result.usable, true);
  const coverage = result.channels.contrast.coverage;
  const localized = fractionIn(result.channels.contrast, f.image, inside);
  assert.ok(coverage > 0.001 && coverage < 0.035, `cobertura ${coverage}`);
  assert.ok(localized > 0.15, `fracción dentro ${localized}`);
  assert.equal(fractionIn(result.channels.contrast, f.image, (x, y) => Math.hypot(x - 64, y - 64) > 15), 0);
  assert.equal(result.channels.redness.coverage, 0);
  t.diagnostic(`mancha: coverage=${coverage}, fracción interior=${localized}`);
});

test('región roja sintética de transición suave: rojez relativa local y no toda la imagen', t => {
  const f = fixture((x, y) => {
    const strength = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 18);
    return [180 + 45 * strength, 130 - 30 * strength, 110 - 10 * strength];
  });
  const result = run(f);
  assert.equal(result.usable, true);
  const coverage = result.channels.redness.coverage;
  assert.ok(coverage > 0.001 && coverage < 0.025, `cobertura ${coverage}`);
  assert.equal(fractionIn(result.channels.redness, f.image, (x, y) => Math.hypot(x - 64, y - 64) > 12), 0);
  t.diagnostic(`rojez: coverage=${coverage}`);
});

test('microcontraste sintético: detecta oscilación pequeña localizada, sin afirmar poros', t => {
  const inside = (x, y) => x >= 44 && x < 84 && y >= 44 && y < 84;
  const f = fixture((x, y) => {
    const delta = inside(x, y) ? ((x + y) % 2 ? 8 : -8) : 0;
    return [180 + delta, 130 + delta, 110 + delta];
  });
  const result = run(f);
  assert.equal(result.usable, true);
  const coverage = result.channels.texture.coverage;
  const localized = fractionIn(result.channels.texture, f.image, inside);
  assert.ok(coverage > 0.07 && coverage < 0.11, `cobertura ${coverage}`);
  assert.ok(localized > 0.9, `fracción dentro ${localized}`);
  assert.equal(fractionIn(result.channels.texture, f.image, (x, y) => x < 40 || x > 88 || y < 40 || y > 88), 0);
  t.diagnostic(`microcontraste: coverage=${coverage}, fracción interior=${localized}`);
});

test('gradiente de iluminación suave y cuantización RGB no generan resaltados', () => {
  const f = fixture((x, y) => {
    const factor = 0.65 + 0.5 * (x + y) / 254;
    return [180 * factor, 130 * factor, 110 * factor];
  });
  assertEmpty(run(f), true);
});

test('cambio cromático no rojo con luminancia casi constante activa contraste local', t => {
  const f = fixture((x, y) => {
    const strength = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 18);
    return [180 - 35 * strength, 130 + 5 * strength, 110 + 35 * strength];
  });
  const result = run(f);
  assert.equal(result.usable, true);
  const coverage = result.channels.contrast.coverage;
  assert.ok(coverage > 0.0005 && coverage < 0.02, `cobertura ${coverage}`);
  assert.equal(result.channels.redness.coverage, 0);
  t.diagnostic(`cromático: coverage=${coverage}`);
});

test('cuantización y microvariación de un nivel no se amplifican con normalización', () => {
  assertEmpty(run(fixture((x, y) => {
    const delta = (x + y) % 2 ? 1 : -1;
    return [180 + delta, 130 + delta, 110 + delta];
  })), true);
});

test('regresión: textura extendida no se normaliza contra sí misma hasta dar 0%', t => {
  const result = run(fixture((x, y) => {
    const delta = (x + y) % 2 ? 8 : -8;
    return [180 + delta, 130 + delta, 110 + delta];
  }));
  assert.equal(result.usable, true);
  assert.ok(result.channels.texture.coverage > 0.6, `cobertura ${result.channels.texture.coverage}`);
  assert.equal(result.channels.texture.status, 'highlighted');
  assert.ok(result.channels.texture.threshold >= 0.025 && result.channels.texture.threshold <= 0.025 * 1.5);
  t.diagnostic(`textura extendida: coverage=${result.channels.texture.coverage}, threshold=${result.channels.texture.threshold}`);
});

test('regresión: variación cromática amplia no desaparece por usar solo un vecindario pequeño', t => {
  const result = run(fixture((x, y) => {
    const strength = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / (2 * 18 ** 2));
    return [180 + 45 * strength, 130 - 30 * strength, 110 - 10 * strength];
  }));
  assert.equal(result.usable, true);
  assert.ok(result.channels.redness.coverage > 0.005, `cobertura ${result.channels.redness.coverage}`);
  t.diagnostic(`rojez amplia: coverage=${result.channels.redness.coverage}`);
});

test('regresión: ROI pequeño con señal válida no falla por erosión de todo el filtro', () => {
  const f = fixture();
  f.mask.fill(0);
  for (let y = 52; y < 76; y++) for (let x = 60; x < 67; x++) f.mask[y * 128 + x] = 1;
  assertEmpty(run(f), true);
});

test('brillo aparente: aclaramiento desaturado localizado, sin inferir grasa ni zona T', t => {
  const f = fixture((x, y) => {
    const strength = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / (2 * 6 ** 2));
    return [180 + 50 * strength, 130 + 85 * strength, 110 + 100 * strength];
  });
  const result = run(f);
  assert.equal(result.usable, true);
  const channel = result.channels.shine;
  assert.equal(channel.status, 'highlighted');
  assert.ok(channel.coverage > 0.001 && channel.coverage < 0.04, `cobertura ${channel.coverage}`);
  assert.equal(fractionIn(channel, f.image, (x, y) => Math.hypot(x - 64, y - 64) > 16), 0);
  assert.match(result.warnings.join(' '), /no mide grasa, hidratación ni identifica zona T/);
  assert.match(result.warnings.join(' '), /no detecta arterias, venas, lesiones reales ni profundidad/);
  t.diagnostic(`brillo: coverage=${channel.coverage}`);
});

test('aclaramiento multiplicativo conserva cromaticidad y no se interpreta como brillo', () => {
  const result = run(fixture((x, y) => {
    const gain = 1 + 0.25 * Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 72);
    return [180 * gain, 130 * gain, 110 * gain];
  }));
  assert.equal(result.usable, true);
  assert.equal(result.channels.shine.coverage, 0);
  assert.equal(result.channels.redness.coverage, 0);
});

test('normalización cromática mantiene señal localizada a distintas exposiciones no recortadas', () => {
  for (const gain of [0.55, 0.8, 1]) {
    const f = fixture((x, y) => {
      const strength = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 32);
      return [gain * (180 + 45 * strength), gain * (130 - 30 * strength), gain * (110 - 10 * strength)];
    });
    const result = run(f);
    assert.equal(result.usable, true);
    assert.ok(result.channels.redness.coverage > 0.003);
    assert.equal(fractionIn(result.channels.redness, f.image, (x, y) => Math.hypot(x - 64, y - 64) > 14), 0);
  }
});

test('ruido impulsivo disperso no se pinta como textura ni contamina vecindarios uniformes', () => {
  assertEmpty(run(fixture((x, y) => {
    const delta = x % 19 === 0 && y % 17 === 0 ? 30 : 0;
    return [180 + delta, 130 + delta, 110 + delta];
  })), true);
});

test('ruido cromático extremo con luminancia parecida se rechaza explícitamente', () => {
  const result = run(fixture((x, y) => (x + y) % 2 ? [215, 115, 100] : [145, 145, 120]));
  assertEmpty(result, false);
  assert.match(result.warnings[0], /ruido/);
  assert.ok(result.diagnostics.noisyFraction > 0.35);
});

test('píxeles transparentes o recortados aislados no producen halos ni capas en su posición', () => {
  for (const rgba of [[0, 0, 255, 0], [255, 255, 255, 255], [0, 0, 0, 255]]) {
    const f = fixture();
    for (let y = 16; y < 112; y += 16) for (let x = 16; x < 112; x += 16) {
      f.image.data.set(rgba, (y * 128 + x) * 4);
    }
    const result = run(f);
    assertEmpty(result, true);
    assert.ok(result.diagnostics.analyzedPixels > 0);
    assert.ok(result.diagnostics.analyzedFraction < 1);
  }
});

test('tonos cálidos uniformes oscuros y claros válidos no fuerzan actividad', () => {
  for (const rgb of [[75, 48, 36], [120, 83, 65], [225, 190, 170]]) {
    assertEmpty(run(fixture(() => rgb)), true);
  }
});

test('ruido pequeño determinista y degradado curvo suave no se estiran a mapas artificiales', () => {
  let seed = 20261027;
  assertEmpty(run(fixture(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const delta = seed % 5 - 2;
    return [180 + delta, 130 + delta, 110 + delta];
  })), true);
  assertEmpty(run(fixture((x, y) => {
    const gain = 0.75 + 0.2 * Math.cos((x - 64) / 80) * Math.cos((y - 64) / 80);
    return [180 * gain, 130 * gain, 110 * gain];
  })), true);
});

test('soporte parcial cuantificado: cobertura sigue referida al ROI y no implica confianza clínica', () => {
  const f = fixture();
  f.mask.fill(0);
  for (let y = 52; y < 76; y++) for (let x = 60; x < 67; x++) f.mask[y * 128 + x] = 255;
  const result = run(f);
  assertEmpty(result, true);
  assert.equal(result.diagnostics.roiPixels, 168);
  assert.ok(result.diagnostics.analyzedFraction > 0 && result.diagnostics.analyzedFraction < 0.5);
  assert.match(result.warnings[0], /Soporte parcial/);
});

test('dimensiones rectangulares: salida alineada al RGBA y sin intercambio de ejes', () => {
  const f = fixture((x, y) => {
    const strength = Math.exp(-((x - 110) ** 2 + (y - 36) ** 2) / 32);
    return [180 + 45 * strength, 130 - 30 * strength, 110 - 10 * strength];
  }, 160, 80);
  const result = run(f);
  assert.equal(result.usable, true);
  assert.ok(result.channels.redness.coverage > 0);
  assert.equal(fractionIn(result.channels.redness, f.image, (x, y) => Math.hypot(x - 110, y - 36) > 14), 0);
  for (const channel of Object.values(result.channels)) assert.equal(channel.rgba.length, 160 * 80 * 4);
});

test('azul, cian y monocromía se rechazan con capas transparentes y motivo', () => {
  for (const [rgb, reason] of [
    [[35, 95, 220], /azul\/cian/],
    [[35, 190, 195], /azul\/cian/],
    [[180, 30, 25], /monocromática/],
    [[130, 130, 130], /monocromática/],
  ]) {
    const result = run(fixture(() => rgb));
    assertEmpty(result, false);
    assert.match(result.warnings[0], reason);
  }
});

test('oscuridad, saturación, transparencia y ruido extremo tienen rechazo explícito', () => {
  for (const [f, reason] of [
    [fixture(() => [18, 12, 8]), /oscuridad/],
    [fixture(() => [255, 230, 215]), /saturación/],
    [fixture((x, y) => (x + y) % 2 ? [220, 170, 150] : [100, 50, 30]), /ruido/],
  ]) {
    const result = run(f);
    assertEmpty(result, false);
    assert.match(result.warnings[0], reason);
  }
  const f = fixture();
  for (let i = 3; i < f.image.data.length; i += 4) f.image.data[i] = 0;
  const result = run(f);
  assertEmpty(result, false);
  assert.match(result.warnings[0], /transparentes/);
});

test('máscara: fuera del ROI no influye; bordes y huecos de ojos no se resaltan', () => {
  const f = fixture();
  const dirty = fixture();
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = y * 128 + x;
    const skin = x >= 16 && x < 112 && y >= 16 && y < 112
      && !((x - 64) ** 2 + (y - 48) ** 2 < 9 ** 2);
    f.mask[i] = dirty.mask[i] = Number(skin);
    if (!skin) dirty.image.data.set([0, 0, 255, 0], i * 4);
  }
  const result = run(dirty);
  assertEmpty(result, true);
  assert.deepEqual(result, run(f));
});

test('bordes abruptos internos no se convierten en microcontraste ni anillos de hallazgos', () => {
  const f = fixture((x, y) => x >= 50 && x < 78 && y >= 50 && y < 78
    ? [25, 20, 15] : [180, 130, 110]);
  assertEmpty(run(f), true);
});

test('imagen cubierta de bordes sin superficie analizable se rechaza, no éxito vacío', () => {
  const result = run(fixture(x => {
    const delta = x % 16 < 8 ? 30 : -30;
    return [180 + delta, 130 + delta, 110 + delta];
  }));
  assertEmpty(result, false);
  assert.match(result.warnings[0], /calidad insuficiente.*bordes/);
});

test('cualquier máscara no cero representa ROI, con resaltados y transparencia en huecos', () => {
  const f = fixture((x, y) => {
    const delta = x >= 60 && x < 80 && y >= 60 && y < 80 ? ((x + y) % 2 ? 8 : -8) : 0;
    return [180 + delta, 130 + delta, 110 + delta];
  });
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    f.mask[y * 128 + x] = Number(x >= 12 && x < 116 && y >= 12 && y < 116
      && !((x - 45) ** 2 + (y - 45) ** 2 < 9 ** 2));
  }
  const result = run(f);
  assert.equal(result.usable, true);
  assert.ok(result.channels.texture.coverage > 0);
  const roiCount = f.mask.reduce((sum, value) => sum + value, 0);
  for (const channel of Object.values(result.channels)) {
    let highlighted = 0;
    for (let i = 0; i < f.mask.length; i++) {
      if (channel.rgba[i * 4 + 3]) highlighted++;
      if (!f.mask[i]) assert.equal(channel.rgba[i * 4 + 3], 0);
    }
    assert.equal(channel.coverage, highlighted / roiCount);
  }
  f.mask = f.mask.map(value => value ? 255 : 0);
  assert.deepEqual(run(f), result);
  f.mask = f.mask.map(value => value ? 2 : 0);
  assert.deepEqual(run(f), result);
});

test('ROI vacío, estrecho y resolución pequeña: no éxito falso', () => {
  const empty = fixture();
  empty.mask.fill(0);
  const narrow = fixture();
  narrow.mask.fill(0);
  for (let y = 0; y < 128; y++) for (let x = 60; x < 65; x++) narrow.mask[y * 128 + x] = 1;
  for (const f of [empty, narrow, fixture(undefined, 8)]) {
    const result = run(f);
    assertEmpty(result, false);
    assert.match(result.warnings[0], /ROI|resolución/);
  }
});

test('entrada inválida lanza error explícito antes del análisis', () => {
  const { image, mask } = fixture();
  for (const invalid of [
    null, { ...image, width: 0 }, { ...image, height: -1 }, { ...image, width: 1.5 },
    { ...image, width: NaN }, { ...image, width: Infinity }, { ...image, width: 4097 },
    { ...image, width: 4096, height: 4096 },
  ]) assert.throws(() => analyzeSkinAppearance(invalid, mask), RangeError);
  for (const data of [null, [], new Uint8Array(image.data), image.data.slice(4)]) {
    assert.throws(() => analyzeSkinAppearance({ ...image, data }, mask), /RGBA inválido/);
  }
  for (const invalid of [null, [], new Uint8ClampedArray(mask), mask.slice(1)]) {
    assert.throws(() => analyzeSkinAppearance(image, invalid), /Máscara inválida/);
  }
});

test('contrato RGBA, cobertura exacta sobre ROI, determinismo y entradas inmutables a 384 px', t => {
  const f = fixture((x, y) => {
    const delta = x > 120 && x < 160 && y > 120 && y < 160 ? ((x + y) % 2 ? 8 : -8) : 0;
    return [180 + delta, 130 + delta, 110 + delta];
  }, 384);
  for (let i = 0; i < 384 * 20; i++) f.mask[i] = 0;
  const before = structuredClone(f);
  const start = performance.now();
  const result = run(f);
  const elapsed = performance.now() - start;
  assert.equal(result.usable, true);
  assert.deepEqual(f, before);
  assert.deepEqual(run(f), result);
  assert.deepEqual(Object.keys(result.channels).sort(), ['contrast', 'redness', 'shine', 'texture']);
  const roiCount = f.mask.reduce((sum, value) => sum + value, 0);
  for (const channel of Object.values(result.channels)) {
    assert.ok(channel.rgba instanceof Uint8ClampedArray);
    assert.equal(channel.rgba.length, 384 * 384 * 4);
    let count = 0;
    for (let i = 0; i < f.mask.length; i++) {
      if (channel.rgba[i * 4 + 3]) count++;
      if (!f.mask[i]) assert.deepEqual(channel.rgba.slice(i * 4, i * 4 + 4), new Uint8ClampedArray(4));
    }
    assert.equal(channel.coverage, count / roiCount);
    assert.equal(channel.highlightedPixels, count);
    assert.equal(channel.status, count ? 'highlighted' : 'no-signal');
    assert.ok(Number.isFinite(channel.threshold) && channel.threshold > 0);
    assert.ok(channel.coverage >= 0 && channel.coverage <= 1);
  }
  assert.equal(result.diagnostics.roiPixels, roiCount);
  assert.ok(result.diagnostics.analyzedPixels > 0 && result.diagnostics.analyzedPixels <= roiCount);
  assert.equal(result.diagnostics.analyzedFraction, result.diagnostics.analyzedPixels / roiCount);
  assert.ok(result.diagnostics.referenceRadius > result.diagnostics.localRadius);
  t.diagnostic(`384 px: ${elapsed.toFixed(2)} ms (observación, no umbral dependiente del equipo)`);
});
