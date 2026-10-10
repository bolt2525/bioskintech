import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const load = (path, dependencies = {}) => {
  const exports = {};
  vm.runInNewContext(compile(path), {
    exports, Date, crypto: globalThis.crypto,
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return exports;
};
const patterns = load('../src/data/scalpPatterns.ts');
const boundary = load('../src/data/scalpBoundaryPreset.ts');
const types = load('../src/components/admin/ficha-clinica/types/treatment.ts');
const followUp = load('../src/components/admin/ficha-clinica/types/treatmentFollowUp.ts', {
  './treatment': types,
  '../../../../data/scalpPatterns': patterns,
  '../../../../data/scalpBoundaryPreset': boundary,
});
const assessment = { scale: 'savin', stage: 'II-1', density: 'Media', alopecia_type: 'Androgenética', itching_flaking: false };
const session = (overrides = {}) => ({
  id: 1, consultation_id: 10, treatment_mode: 'capilar', date: '2026-10-01',
  procedure_name: 'PRP', equipment_used: 'Kit PRP', area_treated: 'Coronilla',
  area_marker: null, duration_minutes: 30, cost: 50, package_id: null,
  parameters: { __scalp_assessment: assessment }, notes: 'Hallazgos de la sesión previa', ...overrides,
});

test('Historial previo no adquiere evaluaciones iniciales ni se modifica', () => {
  const old = session();
  const before = JSON.stringify(old);
  assert.equal(followUp.getTreatmentFollowUp(old).purpose, null);
  assert.equal(followUp.getFollowUpLabel(old), 'Sin tipo de seguimiento');
  assert.equal(JSON.stringify(old), before);
});
test('Preparar un control conserva parámetros y zonas, pero elimina id, hallazgos y notas', () => {
  const current = session({ parameters: {
    'Kit PRP': { dose: 5 }, __scalp_assessment: assessment,
    __post_care: { erythema: 3 }, __anthropometrics: { before: { waist: '90' } },
    __follow_up: { purpose: 'initial', observations: 'Hallazgo inicial' },
  } });
  const before = JSON.stringify(current);
  const next = followUp.prepareNextTreatment(current, '2026-10-10');
  assert.equal(next.id, undefined);
  assert.equal(next.date, '2026-10-10');
  assert.equal(next.parameters['Kit PRP'].dose, 5);
  for (const key of Object.values(types.RESERVED_PARAM_KEYS)) assert.equal(next.parameters[key], undefined);
  assert.equal(next.notes, '');
  assert.equal(followUp.getTreatmentFollowUp(next).purpose, 'control');
  assert.equal(followUp.getTreatmentFollowUp(next).referenceId, '1');
  assert.equal(followUp.getTreatmentFollowUp(next).observations, '');
  assert.equal(next.area_treated, current.area_treated);
  assert.equal(JSON.stringify(current), before);
});
test('Seguimiento incluye otras consultas del expediente, sin mezclar modo, paquete o procedimiento', () => {
  const history = [
    session({ id: 2, consultation_id: 11, date: '2026-10-05', procedure_name: ' prp ' }),
    session({ id: 3, treatment_mode: 'facial' }),
    session({ id: 4, package_id: 7 }),
    session({ id: 5, procedure_name: 'Láser' }),
    session(),
  ];
  assert.deepEqual(Array.from(followUp.getFollowUpSessions(session(), history, 'capilar'), item => item.id), [1, 2]);
  assert.deepEqual(Array.from(followUp.getFollowUpSessions(session({ package_id: 7 }), history, 'capilar'), item => item.id), [4]);
  assert.equal(followUp.getFollowUpSessions(session({ procedure_name: '' }), history, 'capilar').length, 0);
});
test('Render clínico usa Savin, no muestra Norwood I por ausencia de evaluación', () => {
  assert.equal(followUp.getScalpVisualization(undefined), null);
  assert.equal(followUp.getScalpVisualization({ ...assessment, stage: null }), null);
  assert.equal(followUp.getScalpVisualization({ ...assessment, stage: 'desconocida' }), null);
  assert.equal(followUp.getScalpVisualization({ ...assessment, scale: 'toString' }), null);
  const visualization = followUp.getScalpVisualization(assessment);
  assert.equal(visualization.scale, 'savin');
  assert.equal(visualization.stage, 'II-1');
  assert.equal(visualization.density, 'Media');
  assert.equal(visualization.boundaryPoints, boundary.SCALP_BOUNDARY_PRESET);
});
test('Comparación descriptiva: no equivalencias entre escalas ni porcentajes de mejoría', () => {
  assert.match(followUp.compareTreatmentAssessments(session(), session({ parameters: { __scalp_assessment: { ...assessment, scale: 'ludwig', stage: 'II' } } }), 'capilar'), /Escalas distintas/);
  assert.match(followUp.compareTreatmentAssessments(session(), session({ parameters: { __scalp_assessment: { ...assessment, stage: 'Frontal' } } }), 'capilar'), /Variante/);
  assert.match(followUp.compareTreatmentAssessments(session(), session(), 'capilar'), /no demuestra/);
  assert.match(followUp.compareTreatmentAssessments(session(), session(), 'facial'), /no la eficacia acumulada/);
});
test('Medidas corporales aceptan coma decimal, no interpretan vacío como cero', () => {
  const first = session({ parameters: { __anthropometrics: { before: { waist: '90,5' } } } });
  const last = session({ parameters: { __anthropometrics: { after: { waist: '88' } } } });
  assert.match(followUp.compareTreatmentAssessments(first, last, 'corporal'), /-2[,.]5/);
  assert.match(followUp.compareTreatmentAssessments(first, session({ parameters: {} }), 'corporal'), /registra el valor/);
});

function harness() {
  const states = [];
  let cursor = 0;
  const requests = [];
  let saved = 0;
  const hooks = {
    ...require('react'),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
    useRef: () => ({ current: null }),
  };
  const exports = {};
  vm.runInNewContext(compile('../src/components/admin/ficha-clinica/components/tabs/TreatmentModeView.tsx'), {
    exports, Date, console, URLSearchParams, crypto: globalThis.crypto, setTimeout: () => 1,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'lucide-react') return require(name);
      if (name === 'framer-motion') return { motion: new Proxy({}, { get: (_, property) => `motion.${String(property)}` }), AnimatePresence: 'AnimatePresence' };
      if (name.endsWith('/recordsFetch')) return { __esModule: true, default: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ id: 99 }) };
      } };
      if (name.endsWith('/AuthContext')) return { useAuth: () => ({ hasFeature: () => false }) };
      if (name.endsWith('/treatment_options.json')) return { procedures: {} };
      if (name.endsWith('/useTreatmentGrouping')) return { useTreatmentGrouping: items => ({
        groups: [{ key: 'prp', displayName: 'PRP', items }], expandedGroups: new Set(['prp']), toggleGroup() {},
      }) };
      if (name.endsWith('/types/treatment')) return types;
      if (name.endsWith('/types/treatmentFollowUp')) return followUp;
      if (name.endsWith('/scalpPatterns')) return patterns;
      if (name.endsWith('/fieldHelpTexts')) return { HELP: { treatment: {}, parameters: {} } };
      if (name.endsWith('/TreatmentParametersModal')) return {
        __esModule: true, default: name, formatParametersAsText: () => '', upsertNotesBlock: text => text, removeNotesBlock: text => text,
      };
      return { __esModule: true, default: name,
        Tooltip: 'Tooltip', FieldHelp: 'FieldHelp', Dialog: 'Dialog', ConfirmationDialog: 'ConfirmationDialog',
      };
    },
  });
  const render = () => {
    cursor = 0;
    return exports.default({
      mode: 'capilar', modelUrl: '/models/clinical/male_head.glb',
      recordId: 7, consultationId: 10, treatments: [session()],
      onSave: () => { saved += 1; },
    });
  };
  const all = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(all);
    return [node, ...all(node.props?.children)];
  };
  return { render, all, requests, saved: () => saved };
}
test('UI: siguiente sesión es borrador sin request; Guardar persiste control con JSONB existente', async () => {
  const h = harness();
  let tree = h.render();
  const card = h.all(tree).find(node => node.type === 'motion.div' && node.props.onClick);
  assert.ok(card);
  card.props.onClick();
  tree = h.render();
  h.all(tree).find(node => node.props?.['aria-label'] === 'Preparar siguiente sesión').props.onClick();
  assert.equal(h.requests.length, 0);
  tree = h.render();
  const modal = h.all(tree).find(node => node.type === './ClinicalDataModal');
  modal.props.onSave({ ...assessment, stage: 'II-2' });
  tree = h.render();
  const stepButtons = h.all(tree).filter(node => node.type === 'button' && String(node.props.className).includes('min-h-16'));
  assert.equal(stepButtons.length, 4);
  stepButtons[3].props.onClick();
  tree = h.render();
  const panel = h.all(tree).find(node => node.type === './TreatmentFollowUpPanel');
  assert.equal(panel.props.current.id, undefined);
  assert.equal(panel.props.current.parameters.__scalp_assessment.stage, 'II-2');
  panel.props.onChange({ purpose: 'control', observations: 'Control ficticio, sin pacientes reales', referenceId: '1' });
  tree = h.render();
  const saveTooltip = h.all(tree).find(node => node.type === 'Tooltip' && node.props.content === 'Guardar');
  await saveTooltip.props.children.props.onClick();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /action=addTreatment/);
  const body = JSON.parse(h.requests[0].options.body);
  assert.equal(body.record_id, 7);
  assert.equal(body.consultation_id, 10);
  assert.equal(body.parameters.__follow_up.purpose, 'control');
  assert.equal(body.parameters.__follow_up.referenceId, '1');
  assert.equal(body.parameters.__scalp_assessment.stage, 'II-2');
  assert.equal(body.finance_posting.enabled, false);
  assert.equal(h.saved(), 1);
});
test('UI: cambiar evaluación actualiza el groom Savin de Tratamientos Capilares', () => {
  const h = harness();
  let tree = h.render();
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
  const modal = h.all(tree).find(node => node.type === './ClinicalDataModal');
  modal.props.onSave(assessment);
  tree = h.render();
  const stepButtons = h.all(tree).filter(node => node.type === 'button' && String(node.props.className).includes('min-h-16'));
  stepButtons[1].props.onClick();
  tree = h.render();
  const details = h.all(tree).find(node => node.type === 'details');
  assert.equal(details.props.open, false);
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
  details.props.onToggle({ currentTarget: { open: true } });
  tree = h.render();
  const viewer = h.all(tree).find(node => node.type === '../Clinical3DViewer');
  assert.equal(viewer.props.scalpHair.scale, 'savin');
  assert.equal(viewer.props.scalpHair.stage, 'II-1');
  assert.equal(viewer.props.modelUrl, '/models/clinical/male_head.glb');
  h.all(tree).find(node => node.type === 'details').props.onToggle({ currentTarget: { open: false } });
  tree = h.render();
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
});
