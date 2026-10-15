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
const FinanceSummary = load('../src/components/admin/ficha-clinica/components/tabs/TreatmentFinanceSummary.tsx', {
  '../../types/treatment': types,
  'react/jsx-runtime': require('react/jsx-runtime'),
}).default;
const elementText = node => node == null ? '' : Array.isArray(node)
  ? node.map(elementText).join('')
  : typeof node === 'object' ? elementText(node.props?.children) : String(node);

test('Resumen financiero conserva importes anteriores en histórico plegado', () => {
  const tree = FinanceSummary({ pkg: {
    initial_payment: 0, sessions_paid: 40,
    finance_registered_total: 10, finance_record_count: 1,
    initial_finance_registered_total: 0, initial_finance_record_count: 0,
  } });
  const [visible, historical] = tree.props.children;
  assert.equal(elementText(visible), `En Finanzas ${types.formatTreatmentAmount(10)}`);
  assert.equal(historical.type, 'details');
  assert.equal(historical.props.open, undefined);
  assert.match(elementText(historical), /Histórico de importes/);
  assert.ok(elementText(historical).includes(types.formatTreatmentAmount(40)));
  assert.ok(elementText(historical).includes(types.formatTreatmentAmount(30)));
});

test('Resumen simplificado mantiene acceso restringido y datos no disponibles', () => {
  for (const [value, expected] of [[null, 'restringida'], [undefined, 'no disponible']]) {
    const tree = FinanceSummary({ pkg: {
      initial_payment: 0, sessions_paid: 40,
      finance_registered_total: value, finance_record_count: value,
    } });
    assert.ok(elementText(tree.props.children[0]).includes(expected));
    assert.ok(!elementText(tree).includes('Diferencia histórica'));
  }
});
const clinicalDataModalSource = readFileSync(new URL('../src/components/admin/ficha-clinica/components/tabs/ClinicalDataModal.tsx', import.meta.url), 'utf8');
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
test('Modal capilar agrupa escalas en patrones masculino y femenino', () => {
  assert.match(clinicalDataModalSource, /label: 'Masculino'.*scales: \['norwood'\]/);
  assert.match(clinicalDataModalSource, /label: 'Femenino'.*scales: \['ludwig', 'savin'\]/);
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

function harness(mode = 'capilar', history = null) {
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
        return { ok: true, json: async () => url.includes('listPackagesByRecord') ? [] : ({ id: 99 }) };
      } };
      if (name.endsWith('/AuthContext')) return { useAuth: () => ({ hasFeature: () => false }) };
      if (name.endsWith('/treatment_options.json')) return { procedures: {} };
      if (name.endsWith('/useTreatmentGrouping')) return { useTreatmentGrouping: items => ({
        groups: [{ key: 'prp', displayName: 'PRP', items }], expandedGroups: new Set(['prp']), toggleGroup() {}, expandGroup() {},
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
      mode, modelUrl: mode === 'corporal' ? '/models/clinical/male_body.glb' : '/models/clinical/male_head.glb',
      recordId: 7, consultationId: 10, treatments: history || [session({
        treatment_mode: mode,
        parameters: mode === 'capilar' ? { __scalp_assessment: assessment } : {},
      })],
      onSave: () => { saved += 1; },
    });
  };
  const all = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(all);
    return [node, ...all(node.props?.children)];
  };
  const renderExpanded = () => {
    let tree = render();
    const toggle = all(tree).find(node => node.type === 'button' && node.props?.['aria-label'] === 'Sesiones independientes');
    if (toggle?.props['aria-expanded'] === false) {
      toggle.props.onClick();
      tree = render();
    }
    return tree;
  };
  return { render: renderExpanded, renderCollapsed: render, all, requests, saved: () => saved };
}

test('UI: historial independiente empieza plegado y permite abrir sesiones bajo demanda', () => {
  const h = harness();
  let tree = h.renderCollapsed();
  const toggle = h.all(tree).find(node => node.type === 'button' && node.props?.['aria-label'] === 'Sesiones independientes');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(h.all(tree).find(node => node.props?.id === 'independent-sessions').props.hidden, true);
  toggle.props.onClick();
  tree = h.renderCollapsed();
  assert.equal(h.all(tree).find(node => node.props?.['aria-label'] === 'Sesiones independientes').props['aria-expanded'], true);
  assert.equal(h.all(tree).find(node => node.props?.id === 'independent-sessions').props.hidden, false);
  assert.equal(h.all(tree).filter(node => node.type === 'button' && node.props?.['data-treatment-id'] != null).length, 1);
  assert.equal(h.requests.length, 0);
});

    test('UI: historial unificado filtra sin cambiar ni perder el borrador y carga modo de cada sesión', () => {
      const h = harness('facial', [
        session({ id: 1, treatment_mode: 'facial', procedure_name: 'Facial ficticio' }),
        session({ id: 2, treatment_mode: 'corporal', procedure_name: 'Corporal ficticio', parameters: {} }),
        session({ id: 3, treatment_mode: 'capilar', procedure_name: 'Capilar ficticio' }),
        session({ id: 4, consultation_id: 11, procedure_name: 'Consulta anterior' }),
      ]);
      const cards = tree => h.all(tree).filter(node => node.type === 'button' && node.props?.['data-treatment-id'] != null);
      let tree = h.render();
      assert.equal(cards(tree).length, 3);
      cards(tree)[1].props.onClick();
      tree = h.render();
      const modal = h.all(tree).find(node => node.type === './ClinicalDataModal');
      assert.equal(modal.props.mode, 'corporal');
      const filterGroup = h.all(tree).find(node => node.props?.['aria-label'] === 'Filtrar historial por modo');
      h.all(filterGroup).filter(node => node.type === 'button')[1].props.onClick();
      tree = h.render();
      assert.equal(cards(tree).length, 1);
      assert.equal(h.all(tree).find(node => node.type === './ClinicalDataModal').props.mode, 'corporal');
      assert.equal(h.all(tree).find(node => node.props?.id === 'treatment-date').props.value, '2026-10-01');
      assert.equal(h.all(tree).find(node => node.props?.value === 'Corporal ficticio').props.value, 'Corporal ficticio');
      assert.equal(h.requests.length, 0);
    });

    test('UI: cambio anatómico requiere confirmación y conserva procedimiento, notas y abono', () => {
      const h = harness('facial');
      let tree = h.render();
      h.all(tree).find(node => node.type === 'button' && node.props?.['data-treatment-id'] != null).props.onClick();
      tree = h.render();
      const modeButton = h.all(tree).find(node => node.type === 'button'
        && node.props['aria-pressed'] === false && String(node.props.className).includes('min-h-[4rem]'));
      modeButton.props.onClick();
      tree = h.render();
      const confirm = h.all(tree).find(node => node.type === 'ConfirmationDialog' && node.props.title === 'Cambiar modo de la sesión');
      assert.equal(confirm.props.open, true);
      assert.equal(h.all(tree).find(node => node.type === './ClinicalDataModal').props.mode, 'facial');
      confirm.props.onConfirm();
      tree = h.render();
      assert.equal(h.all(tree).find(node => node.type === './ClinicalDataModal').props.mode, 'corporal');
      assert.equal(h.all(tree).find(node => node.type === './ClinicalDataModal').props.initialData, undefined);
      assert.equal(h.all(tree).find(node => node.props?.value === 'PRP').props.value, 'PRP');
      h.all(tree).filter(node => node.type === 'button' && String(node.props.className).includes('min-h-16'))[3].props.onClick();
      tree = h.render();
      const panel = h.all(tree).find(node => node.type === './TreatmentFollowUpPanel');
      assert.equal(panel.props.current.cost, 50);
      assert.equal(panel.props.current.notes, 'Hallazgos de la sesión previa');
      assert.equal(panel.props.current.area_treated, '');
      assert.equal(h.requests.length, 0);
    });

    test('UI: duplicación desde historial corporal conserva modo aunque formulario esté en facial', async () => {
      const h = harness('facial', [session({ treatment_mode: 'corporal', parameters: {} })]);
      const tree = h.render();
      const duplicate = h.all(tree).find(node => node.props?.['aria-label'] === 'Duplicar tratamiento'
        && node.props?.['data-duplicate-treatment-id'] != null);
      await duplicate.props.onClick({ stopPropagation() {} });
      await new Promise(resolve => setImmediate(resolve));
      const writes = h.requests.filter(request => request.options?.method === 'POST');
      assert.equal(writes.length, 1);
      const body = JSON.parse(writes[0].options.body);
      assert.equal(body.treatment_mode, 'corporal');
      assert.equal(body.id, undefined);
      assert.equal(body.consultation_id, 10);
      assert.equal(h.saved(), 1);
    });
test('UI: siguiente sesión es borrador sin request; Guardar persiste control con JSONB existente', async () => {
  const h = harness();
  let tree = h.render();
  const card = h.all(tree).find(node => node.type === 'button' && node.props?.['data-treatment-id'] != null);
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
  const writes = h.requests.filter(request => request.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /action=addTreatment/);
  const body = JSON.parse(writes[0].options.body);
  assert.equal(body.record_id, 7);
  assert.equal(body.consultation_id, 10);
  assert.equal(body.parameters.__follow_up.purpose, 'control');
  assert.equal(body.parameters.__follow_up.referenceId, '1');
  assert.equal(body.parameters.__scalp_assessment.stage, 'II-2');
  assert.equal(body.finance_posting.enabled, false);
  assert.equal(h.saved(), 1);
});

test('UI: retiro no describe el archivado reversible como irreversible', () => {
  const h = harness();
  const dialog = h.all(h.render()).find(node => node.type === 'ConfirmationDialog' && node.props.title === 'Retirar paquete vacío');
  assert.notEqual(dialog.props.variant, 'danger');
  assert.match(dialog.props.detail, /eliminará definitivamente.*no podrá recuperarse/);
  assert.match(dialog.props.detail, /archivará y podrás restaurarlo/);
});
test('UI: cambiar evaluación actualiza el groom Savin de Tratamientos Capilares', () => {
  const h = harness();
  let tree = h.render();
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
  h.all(tree).find(node => node.type === 'button' && node.props?.['data-treatment-id'] != null).props.onClick();
  tree = h.render();
  const modal = h.all(tree).find(node => node.type === './ClinicalDataModal');
  modal.props.onSave(assessment);
  tree = h.render();
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
  const stepButtons = h.all(tree).filter(node => node.type === 'button' && String(node.props.className).includes('min-h-16'));
  stepButtons[1].props.onClick();
  tree = h.render();
  const viewer = h.all(tree).find(node => node.type === '../Clinical3DViewer');
  assert.equal(viewer.props.scalpHair.scale, 'savin');
  assert.equal(viewer.props.scalpHair.stage, 'II-1');
  assert.equal(viewer.props.modelUrl, '/models/clinical/male_head.glb');
  assert.equal(viewer.props.showMarkerLabels, false);
  assert.ok(h.all(tree).some(node => node.type === 'p' && node.props.children === '2. Revisa el modelo capilar'));
  assert.ok(h.all(tree).some(node => node.type === 'p' && node.props.children === 'Se genera con la evaluación; las marcaciones son opcionales'));
  const clinicalNote = h.all(tree).find(node => node.props?.['aria-label'] === 'Evaluación capilar representada');
  assert.match(clinicalNote.props.className, /top-3/);
  assert.doesNotMatch(clinicalNote.props.className, /bottom-3/);
  stepButtons[0].props.onClick();
  tree = h.render();
  assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
});
test('UI: mapas Facial y Corporal conservan su carga opcional bajo demanda', () => {
  for (const mode of ['facial', 'corporal']) {
    const h = harness(mode);
    let tree = h.render();
    h.all(tree).find(node => node.type === 'button' && node.props?.['data-treatment-id'] != null).props.onClick();
    tree = h.render();
    const stepButtons = h.all(tree).filter(node => node.type === 'button' && String(node.props.className).includes('min-h-16'));
    stepButtons[1].props.onClick();
    tree = h.render();
    assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
    const toggle = h.all(tree).find(node => node.type === 'button' && node.props['aria-controls'] === `treatment-viewer-${mode}`);
    assert.equal(toggle.props['aria-expanded'], false);
    toggle.props.onClick();
    tree = h.render();
    assert.equal(h.all(tree).find(node => node.type === '../Clinical3DViewer').props.showMarkerLabels, true);
    h.all(tree).find(node => node.props?.['aria-controls'] === `treatment-viewer-${mode}`).props.onClick();
    tree = h.render();
    assert.equal(h.all(tree).some(node => node.type === '../Clinical3DViewer'), false);
  }
});
