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
const compileComponent = path => {
  const output = buildSync({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  }).outputFiles[0].text;
  const componentModule = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, componentModule, componentModule.exports);
  return componentModule.exports;
};
const termsModule = compileComponent('../src/pages/TermsOfService.tsx');
const TermsOfService = termsModule.default;
const PrivacyPolicy = compileComponent('../src/pages/PrivacyPolicy.tsx').default;

test('legal versions stay synchronized between server and published documents', () => {
  const frontend = readFileSync(new URL('../src/components/legal/LegalLayout.tsx', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
  const version = frontend.match(/export const LEGAL_VERSION = '([^']+)'/)[1];
  assert.equal(backend.match(/export const LEGAL_VERSION = '([^']+)'/)[1], version);
  assert.equal(version, '2026-10-07-r2');
  assert.equal(termsModule.PAID_PHOTO_BACKUP_POLICY_VERSION, 'paid-grace15-recovery30-v1');
});

test('prospective paid policy is explicitly scoped and matches the accepted lifecycle and prices', () => {
  const publicTerms = renderToStaticMarkup(React.createElement(TermsOfService));
  const termsText = publicTerms.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(termsText, /Información operativa actual: exportaciones y fotos/);
  assert.match(termsText, /no está implementada una exportación general JSON por lotes/);
  assert.match(termsText, /solo admite pacientes, hasta 5 MiB y 5\.000 registros/);
  assert.match(termsText, /no restaura datos financieros/);
  assert.match(termsText, /puede repetirse sin límite diario y no consume cuota anual/);
  assert.match(termsText, /paid-grace15-recovery30-v1/);
  assert.match(termsText, /no se incorpora por el uso de la Plataforma, el registro ni la aceptación de las Condiciones versión 2026-10-07-r2/);
  assert.match(termsText, /contrato nuevo o en una adenda firmada expresamente/);
  assert.match(termsText, /T\+15/);
  assert.match(termsText, /T\+45/);
  assert.match(termsText, /todos los módulos contratados/);
  assert.match(termsText, /No se habilitan uso clínico ordinario, importaciones, restauraciones ni snapshots manuales/);
  assert.match(termsText, /eliminación automática por lotes/);
  assert.match(termsText, /Neon y de los objetos correspondientes en R2, incluidos los respaldos/);
  assert.match(termsText, /no se declara completada de inmediato/);
  assert.match(termsText, /hasta 6 horas/);
  assert.match(termsText, /bloqueo de 30 días de las copias programadas ya creadas vence como máximo en T\+45/);
  assert.match(termsText, /copias R2 hasta su vencimiento máximo de 35 días desde la creación/);
  assert.match(termsText, /una ejecución que ya estuviera en curso puede terminar/);
  assert.match(termsText, /comprobantes administrativos mínimos/);
  assert.match(termsText, /cuota del período contractual registrado de 12 meses está vigente y no se ha usado/);
  assert.match(termsText, /no se acumula ni se duplica por renovar/);
  assert.match(termsText, /aceptación previa del Proveedor y pago confirmado/);
  assert.match(termsText, /Una cotización pendiente, negociación o solicitud sin pago no extiende la conservación/);
  assert.match(termsText, /disponible en un máximo de 24 horas/);
  assert.match(termsText, /no se garantiza disponibilidad instantánea/);
  assert.match(termsText, /reintentos persistentes de notificación/);
  assert.match(termsText, /hasta 15 fotos y 100 MiB/);
  assert.match(termsText, /sin límite diario/);
  assert.match(termsText, /no consume la cuota anual/);
  assert.match(termsText, /hasta 5 GB, USD 10/);
  assert.match(termsText, /más de 5 y hasta 20 GB, USD 20/);
  assert.match(termsText, /más de 20 y hasta 50 GB, USD 35/);
  assert.match(termsText, /Más de 50 GB requiere cotización manual/);
  assert.match(termsText, /Todos los importes incluyen IVA/);
  assert.match(termsText, /no condicionan derechos legales de acceso o portabilidad/);
  assert.match(termsText, /50 MiB comprimidos y 200 MiB expandidos/);
  assert.match(termsText, /ni describen futuras funciones de exportación por lotes/);
  assert.match(termsText, /hasta 5 MiB y 5\.000 registros/);
  assert.match(termsText, /no restaura datos financieros/);

  const publicPrivacy = renderToStaticMarkup(React.createElement(PrivacyPolicy));
  const privacyText = publicPrivacy.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(privacyText, /Esta Política conserva la versión global 2026-10-07-r2/);
  assert.match(privacyText, /ni se acepta por el uso de la Plataforma/);
  assert.match(privacyText, /ni se incorporan retroactivamente a contratos/);
  const embeddedTerms = renderToStaticMarkup(React.createElement(TermsOfService, { embedded: true }));
  const embeddedPrivacy = renderToStaticMarkup(React.createElement(PrivacyPolicy, { embedded: true }));
  assert.doesNotMatch(embeddedTerms, /Anexo comercial prospectivo · paid-grace15-recovery30-v1/);
  assert.doesNotMatch(embeddedPrivacy, /Aviso de anexo contractual prospectivo/);
});

test('contract generator requires express inclusion and supports a narrowly scoped signed addendum', () => {
  const source = readFileSync(new URL('../src/components/admin/ContractGenerator.tsx', import.meta.url), 'utf8');
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(source, /paidPhotoBackupPolicy: false/);
  assert.match(html, /name="paidPhotoBackupPolicy"/);
  assert.match(html, /Incorporar y aceptar el anexo paid-grace15-recovery30-v1/);
  assert.match(source, /Para un contrato nuevo, incorpore y acepte expresamente/);
  assert.match(source, /No reabre, renueva ni reemplaza el contrato vigente/);
  assert.match(source, /La firma manuscrita o electrónica válida de este paquete expresa la aceptación del acuerdo completo/);
  assert.match(source, /El Cliente declara haber leído y aceptar expresamente el anexo identificado/);

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
  let tree = render();
  nodes(tree).find(node => node.type === 'select' && node.props.name === 'documentMode')
    .props.onChange({ target: { value: 'addendum' } });
  tree = render();
  assert.match(renderToStaticMarkup(tree), /Fecha de firma del contrato vigente/);
  nodes(tree).find(node => node.type === 'input' && node.props.name === 'paidPhotoBackupPolicy')
    .props.onChange({ target: { checked: true } });
  tree = render();
  const addendum = renderToStaticMarkup(tree);
  assert.match(addendum, /Adenda de vencimiento, recuperación y entregas fotográficas/);
  assert.match(addendum, /Referencia del contrato original/);
  assert.match(addendum, /paid-grace15-recovery30-v1/);
  assert.doesNotMatch(addendum, /Contrato anual de acceso a la plataforma/);
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
  assert.doesNotMatch(html, /Alejandro Codón|Bárbara Atenea Beauty Club/);
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
  assert.match(source, /if \(documentMode === 'new-contract' && !includedModules\.length\)/);
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
  assert.match(text, /reclamaciones contractuales del Cliente por divulgación no autorizada/);
  assert.match(text, /No limita por contrato sanciones administrativas/);
  assert.match(text, /La confidencialidad subsiste después de terminar el contrato/);
  assert.match(text, /obligaciones de prevención, contención, investigación, aviso y asistencia se mantienen/);
  assert.match(text, /Desactivar una clínica suspende el acceso y no equivale a eliminar sus datos/);
  assert.match(text, /no se reutilizarán para reactivar datos cuya supresión ya se haya confirmado/);
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
  assert.match(text, /35 días desde la creación de cada copia/);
  assert.match(text, /el bloqueo impide borrarlas antes de cumplir 30 días/);
  assert.match(text, /Una vez registrada la purga no se inician nuevas copias de la clínica/);
  assert.match(text, /una ejecución que ya hubiera comenzado puede concluir durante el período de drenaje/);
  assert.match(text, /se aplicarán de nuevo las instrucciones de eliminación antes de reanudar el uso ordinario/);
  assert.doesNotMatch(text, /Pendiente de implementación\/verificación/);
});

test('registration and invitation reject stale or missing legal versions before database operations', async () => {
  const { default: handler } = await import('../api/admin-auth.js');
  for (const action of ['register', 'useInvite']) {
    for (const version of [undefined, '2026-10-01', '2026-10-06-r2', '2026-10-07']) {
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
  let tree = render();
  nodes(tree).find(node => node.type === 'select' && node.props.name === 'jurisdiction')
    .props.onChange({ target: { value: 'Quito' } });
  tree = render();
  assert.match(markup(tree), /B\.5\. Jurisdicción particular/);
  assert.match(markup(tree), /Solo para este contrato/);
  nodes(tree).find(node => node.type === 'select' && node.props.name === 'jurisdiction')
    .props.onChange({ target: { value: 'Cuenca' } });
  assert.doesNotMatch(markup(render()), /B\.5\. Jurisdicción particular/);
});

test('both onboarding forms submit the displayed legal version', () => {
  for (const page of ['AdminRegister', 'InviteRegister']) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /import \{ LEGAL_VERSION \}/);
    assert.match(source, /accepted_legal_version: LEGAL_VERSION/);
  }
});
