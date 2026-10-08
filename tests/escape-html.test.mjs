import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, safeImageSrc } from '../src/utils/escapeHtml.js';

test('escapeHtml neutralizes markup and quoted HTML attributes', () => {
  assert.equal(
    escapeHtml(`"><img src=x onerror='alert(1)'>&`),
    '&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;'
  );
});

test('safeImageSrc allows ordinary and raster image sources but rejects executable schemes', () => {
  assert.equal(safeImageSrc('https://cdn.example.test/logo.png'), 'https://cdn.example.test/logo.png');
  assert.equal(safeImageSrc('/images/logo.png'), '/images/logo.png');
  assert.equal(safeImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeImageSrc('javascript:alert(1)'), '');
  assert.equal(safeImageSrc('data:image/svg+xml,<svg/>'), '');
  assert.equal(safeImageSrc('//cdn.example.test/logo.png'), '');
});
