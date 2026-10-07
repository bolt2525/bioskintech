import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/admin/ContractGenerator.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
}).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const ContractGenerator = module.exports.default;

test('legal versions stay synchronized between server and published documents', () => {
  const frontend = readFileSync(new URL('../src/components/legal/LegalLayout.tsx', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
  const version = frontend.match(/export const LEGAL_VERSION = '([^']+)'/)[1];
  assert.equal(backend.match(/export const LEGAL_VERSION = '([^']+)'/)[1], version);
});

test('default natural-person contract does not require a legal representative', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(html, /Persona natural, por sus propios derechos/);
  assert.doesNotMatch(html, /<input[^>]*name="representative"/);
  assert.doesNotMatch(html, /<input[^>]*name="representativeId"/);
  assert.doesNotMatch(html, /<input[^>]*name="representativeRole"/);
  assert.match(html, /name="clinicName"/);
  for (const name of ['contractReference', 'clientName', 'taxId', 'clinicName', 'address', 'email']) {
    assert.match(html, new RegExp(`<input[^>]*name="${name}"[^>]*value=""`));
  }
});

test('default package excludes chatbot and does not silently enable negotiated annex', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(html, /Excluido:.*?chatbot WhatsApp del sistema/);
  assert.doesNotMatch(html, /servicio opcional contratado durante esta vigencia anual/);
  assert.doesNotMatch(html, /Anexo B · Condiciones particulares seleccionadas/);
  assert.doesNotMatch(html, /B\.1\. Soporte particular/);
  assert.doesNotMatch(html, /B\.3\. Aviso de incidentes/);
  assert.match(html, /jurisdicción.*?Cuenca, Ecuador/s);
  assert.match(html, /dolo, culpa grave/);
  assert.match(html, /durante los 12 meses anteriores al hecho/);
});

test('particular options are independently disabled and client pricing has editable defaults', () => {
  const source = readFileSync(new URL('../src/components/admin/ContractGenerator.tsx', import.meta.url), 'utf8');
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  for (const option of ['support', 'refund', 'incidentNotice', 'aiInstructions', 'activation']) {
    assert.match(source, new RegExp(`${option}: false`));
    assert.match(html, new RegExp(`name="${option}"`));
  }
  assert.match(html, /name="platformPrice"[^>]*value="245"/);
  assert.match(html, /name="chatbotPrice"[^>]*value="100"/);
  assert.match(source, /jurisdiction: 'Cuenca'/);
  assert.match(source, /if \(!includedModules\.length\)/);
  assert.match(source, /setCustomValidity\('Ingrese una fecha de inicio válida\.'/);
  assert.match(source, /Number\.isFinite\(value\) && value > 0/);
  assert.doesNotMatch(source, /negotiated/);
});

test('common support refund incident notice and AI safeguards apply without a particular annex', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(html, /Anexo B · Condiciones particulares seleccionadas/);
  assert.match(text, /09:00 a 18:00, UTC−5/);
  assert.match(text, /primera respuesta en hasta 4 horas hábiles/);
  assert.match(text, /devolución proporcional del período anual pagado y no prestado/);
  assert.match(text, /dentro de las primeras 24 horas naturales/);
  assert.match(text, /autorización expresa, documentada y específica/);
  assert.match(text, /Contratar el plan o aceptar estas Condiciones no constituye esa autorización/);
  assert.match(text, /no eliminan las garantías comunes de soporte, devolución, aviso de incidentes ni autorización de IA/);
});

test('printed privacy safeguards distinguish automatic backups from the authorized annual delivery', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /vercel\.com\/legal\/dpa/);
  assert.match(text, /Vercel: aloja el entorno de producción/);
  assert.match(text, /protección automática frente a ataques de denegación de servicio/);
  assert.match(text, /cifra automáticamente los objetos y sus metadatos en reposo con AES-256/);
  assert.doesNotMatch(text, /Hobby|Enterprise|planes Pro|Debe verificarse el plan|requiere infraestructura habilitada/);
  assert.match(html, /neon\.com\/platform-terms/);
  assert.match(html, /cloudflare-customer-dpa/);
  assert.match(text, /no dentro del JSON ni de las copias automáticas diarias de datos estructurados/);
  assert.match(text, /un respaldo y entrega fotográfica gratuitos por clínica y período contractual de 12 meses registrado/);
  assert.match(text, /cuota no consumida del período terminado puede solicitarse por los canales oficiales dentro de los 30 días posteriores/);
  assert.match(text, /si ese canal no está disponible, BIOSKINTECH recibe y coordina la solicitud por los canales oficiales/);
  assert.match(text, /no son dos entregas gratuitas distintas/);
  assert.match(text, /requiere cotización y aceptación previa/);
  assert.match(text, /No se cobrarán correcciones o reintentos necesarios por fallos imputables al Proveedor/);
  assert.match(text, /ni se condicionará el ejercicio de derechos legales/);
  assert.doesNotMatch(text, /Pendiente de implementación\/verificación/);
});

test('registration and invitation reject stale or missing legal versions before database operations', async () => {
  const { default: handler } = await import('../api/admin-auth.js');
  for (const action of ['register', 'useInvite']) {
    for (const version of [undefined, '2026-10-01', '2026-10-06-r2']) {
      let status;
      let response;
      const res = {
        setHeader() {},
        status(value) { status = value; return this; },
        json(value) { response = value; return this; },
      };
      await handler({
        method: 'POST',
        query: { action },
        headers: {},
        body: { accepted_terms: true, accepted_legal_version: version },
      }, res);
      assert.equal(status, 400, `${action}: reject version ${version}`);
      assert.match(response.error, /versión|actualiz/i);
    }
  }
});

test('editable suggestions are opt-in, preserve edits and print only selected particular clauses', () => {
  const states = [];
  let cursor = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect() {},
    useRef() { return { current: null }; },
  };
  const isolated = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    name => name === 'react' ? hooks : require(name), isolated, isolated.exports);
  const render = () => { cursor = 0; return isolated.exports.default(); };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes)
    : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
  const markup = tree => renderToStaticMarkup(tree);
  for (const [option, field] of [
    ['support', 'supportTerms'], ['refund', 'refundTerms'],
    ['aiInstructions', 'aiInstructionTerms'], ['activation', 'activationTerms'],
  ]) {
    let tree = render();
    assert.ok(!nodes(tree).some(node => node.type === 'textarea' && node.props.name === field));
    const toggle = () => nodes(tree).find(node => node.type === 'input' && node.props.name === option);
    toggle().props.onChange({ target: { checked: true } });
    tree = render();
    let textarea = nodes(tree).find(node => node.type === 'textarea' && node.props.name === field);
    assert.equal(textarea.props.value, isolated.exports.CONTRACT_SUGGESTIONS[field]);
    const edited = `Condición particular ${field} <sin HTML>`;
    textarea.props.onChange({ target: { value: edited } });
    tree = render();
    assert.match(markup(tree), /Anexo B · Condiciones particulares seleccionadas/);
    assert.ok(markup(tree).includes(edited.replace('<', '&lt;').replace('>', '&gt;')));
    toggle().props.onChange({ target: { checked: false } });
    tree = render();
    assert.ok(!markup(tree).includes(edited.replace('<', '&lt;').replace('>', '&gt;')));
    toggle().props.onChange({ target: { checked: true } });
    tree = render();
    textarea = nodes(tree).find(node => node.type === 'textarea' && node.props.name === field);
    assert.equal(textarea.props.value, edited);
    nodes(tree).find(node => node.type === 'button' && String(node.props.children).startsWith('Restablecer sugerencia'))
      .props.onClick();
    tree = render();
    assert.equal(nodes(tree).find(node => node.type === 'textarea' && node.props.name === field).props.value,
      isolated.exports.CONTRACT_SUGGESTIONS[field]);
    toggle().props.onChange({ target: { checked: false } });
  }
});

test('both onboarding forms submit the displayed legal version', () => {
  for (const page of ['AdminRegister', 'InviteRegister']) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /import \{ LEGAL_VERSION \}/);
    assert.match(source, /accepted_legal_version: LEGAL_VERSION/);
  }
});
