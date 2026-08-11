import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Printer, X, AlertCircle, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { useClinicSettings } from '../../../../hooks/useClinicSettings';
import { useAuth } from '../../../../context/AuthContext';

interface PrintOptions {
  antecedentes: boolean;
  consulta: boolean;
  examenFisico: boolean;
  diagnostico: boolean;
  tratamientos: boolean;
  recetas: boolean;
  inyectables: boolean;
  consentimientos: boolean;
  includeDates: boolean;
  includeSignature: boolean;
}

interface Props {
  patient: any;
  recordId: number;
  recordData: any;
  activeConsultation: any;
  onClose: () => void;
}

const DEFAULT_OPTIONS: PrintOptions = {
  antecedentes: true,
  consulta: true,
  examenFisico: true,
  diagnostico: true,
  tratamientos: true,
  recetas: true,
  inyectables: false,
  consentimientos: false,
  includeDates: true,
  includeSignature: true,
};

const SECTIONS = [
  { key: 'antecedentes', label: 'Antecedentes Clínicos' },
  { key: 'consulta', label: 'Consulta activa' },
  { key: 'examenFisico', label: 'Examen Físico' },
  { key: 'diagnostico', label: 'Diagnósticos' },
  { key: 'tratamientos', label: 'Tratamientos' },
  { key: 'recetas', label: 'Recetas' },
  { key: 'inyectables', label: 'Inyectables' },
  { key: 'consentimientos', label: 'Consentimientos' },
] as const;

function CheckboxUI({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button type="button" onClick={onChange}
      className={`w-4 h-4 rounded flex items-center justify-center border-2 flex-shrink-0 ${
        checked ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300 bg-white'
      }`}>
      {checked && (
        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}

export default function PrintModal({ patient, recordId, recordData, activeConsultation, onClose }: Props) {
  const { settings: clinic } = useClinicSettings();
  const { user } = useAuth();
  const [opts, setOpts] = useState<PrintOptions>(DEFAULT_OPTIONS);
  // Per-section expanded state and item-level selection
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, string[] | null>>({});
  // Temporary professional data (not saved to DB)
  const [showProfForm, setShowProfForm] = useState(false);
  const [profTemp, setProfTemp] = useState({
    name: user?.full_name || user?.username || '',
    cedula: user?.cedula_profesional || '',
    matricula: user?.matricula_senescyt || '',
    especialidad: user?.especialidad || '',
  });

  const missingFields: string[] = [];
  if (!profTemp.matricula) missingFields.push('matrícula SENESCYT');
  if (!profTemp.especialidad) missingFields.push('especialidad');

  const toggle = (key: keyof PrintOptions) => setOpts(p => ({ ...p, [key]: !p[key] }));

  // Per-section item helpers
  const getSectionItems = (key: string): any[] => {
    switch (key) {
      case 'examenFisico': return recordData?.physicalExams || [];
      case 'diagnostico': return recordData?.diagnoses || [];
      case 'tratamientos': return recordData?.treatments || [];
      case 'recetas': return recordData?.prescriptions || [];
      case 'inyectables': return recordData?.injectables || [];
      case 'consentimientos': return recordData?.consentForms || [];
      default: return [];
    }
  };

  const getItemId = (item: any, idx: number) => String(item.id ?? idx);

  const getItemLabel = (key: string, item: any, idx: number) => {
    const d = (s: string) => s ? new Date(s).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    switch (key) {
      case 'examenFisico': return (item.skin_type || 'Examen') + (item.created_at ? ' — ' + d(item.created_at) : '');
      case 'diagnostico': return (item.diagnosis_text?.slice(0, 45) || 'Diagnóstico') + (item.date ? ' — ' + d(item.date) : '');
      case 'tratamientos': return (item.procedure_name?.slice(0, 45) || 'Tratamiento') + (item.date ? ' — ' + d(item.date) : '');
      case 'recetas': return 'Receta' + (item.date ? ' — ' + d(item.date) : '') + (item.diagnosis ? ': ' + item.diagnosis.slice(0, 30) : '');
      case 'inyectables': return (item.product_type === 'toxina' ? 'Toxina' : 'Relleno') + ' — ' + (item.product_name || '') + (item.date ? ' — ' + d(item.date) : '');
      case 'consentimientos': return (item.procedure_type || item.form_type || 'Consentimiento') + (item.created_at ? ' — ' + d(item.created_at) : '');
      default: return '#' + (idx + 1);
    }
  };

  const isItemSelected = (key: string, item: any, idx: number) => {
    const sel = selected[key];
    if (sel === null || sel === undefined) return true;
    return sel.includes(getItemId(item, idx));
  };

  const toggleItem = (key: string, item: any, idx: number) => {
    const id = getItemId(item, idx);
    const items = getSectionItems(key);
    const allIds = items.map((it, i) => getItemId(it, i));
    const current = selected[key] ?? allIds;
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
    setSelected(p => ({ ...p, [key]: next }));
  };

  const toggleAllItems = (key: string) => {
    const items = getSectionItems(key);
    const allIds = items.map((it, i) => getItemId(it, i));
    const current = selected[key] ?? allIds;
    setSelected(p => ({ ...p, [key]: allIds.every(id => current.includes(id)) ? [] : allIds }));
  };

  const filterItems = (key: string) => {
    const items = getSectionItems(key);
    const sel = selected[key];
    return sel === null || sel === undefined ? items : items.filter((it, i) => sel.includes(getItemId(it, i)));
  };

  const handlePrint = () => {
    const h = recordData?.history || {};
    const consultation = activeConsultation;

    const formatDate = (d: string) => d ? new Date(d).toLocaleDateString('es') : '';
    const sectionHtml = (title: string, content: string) =>
      `<div class="section"><h2>${title}</h2><div class="content">${content}</div></div>`;
    const field = (label: string, val: any) =>
      val ? `<div class="field"><span class="label">${label}:</span> <span>${val}</span></div>` : '';
    const datePrefix = (d: string) => opts.includeDates && d ? `<span class="date">${formatDate(d)}</span> ` : '';
    const trow = (cells: string[]) => '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    const esc = (s: any) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    let sections = '';

    if (opts.antecedentes) {
      sections += sectionHtml('Antecedentes Clínicos', [
        field('Antecedentes patológicos', h.pathological),
        field('Antecedentes no patológicos', h.non_pathological),
        field('Antecedentes familiares', h.family_history),
        field('Antecedentes quirúrgicos', h.surgical_history),
        field('Alergias', h.allergies),
        field('Medicación actual', h.current_medications),
        field('Antecedentes estéticos', h.aesthetic_history),
        field('Antecedentes ginecológicos', h.gynecological_history),
        field('Rutina facial', h.facial_routine),
      ].filter(Boolean).join('') || '<em>Sin datos</em>');
    }

    if (opts.consulta && consultation) {
      sections += sectionHtml(
        'Consulta' + (opts.includeDates ? ` — ${formatDate(consultation.created_at)}` : ''),
        [field('Motivo', consultation.reason), field('Historia de la enfermedad actual', consultation.current_illness)].filter(Boolean).join('') || '<em>Sin datos</em>'
      );
    }

    if (opts.examenFisico) {
      const esc = (s: any) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const trow = (cells: string[]) => '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
      filterItems('examenFisico').forEach((ex: any, i: number, arr: any[]) => {
        const title = 'Examen Físico' + (arr.length > 1 ? ` #${i+1}` : '') + (opts.includeDates && ex.created_at ? ` â€” ${formatDate(ex.created_at)}` : '');
        const paramRows = [['Tipo de piel',ex.skin_type],['Fototipo',ex.phototype],['Escala Glogau',ex.glogau_scale],['Hidratación',ex.hydration],['Elasticidad',ex.elasticity],['Fotoprotección',ex.photoprotection],['Textura',ex.texture],['Poros',ex.poros],['Pigmentación',ex.pigmentation],['Sensibilidad',ex.sensitivity]].filter(([,v])=>v).map(([k,v])=>trow([k+'',esc(v)])).join('');
        const fm: any[] = (() => { try { return JSON.parse(ex.face_map_data || '[]'); } catch { return []; } })();
        const bm: any[] = (() => { try { return JSON.parse(ex.body_map_data || '[]'); } catch { return []; } })();
        const marks = [
          fm.length ? `<div class="marks-title">Marcaciones faciales (${fm.length}):</div><div class="marks-list">${fm.map((m:any)=>`<span class="mark">${esc(m.category)}${m.tercio?' &bull; '+esc(m.tercio):''}${m.notes?' â€” '+esc(m.notes):''}</span>`).join('')}</div>` : '',
          bm.length ? `<div class="marks-title">Marcaciones corporales (${bm.length}):</div><div class="marks-list">${bm.map((m:any)=>`<span class="mark">${esc(m.category)}${m.tercio?' &bull; '+esc(m.tercio):''}${m.notes?' â€” '+esc(m.notes):''}</span>`).join('')}</div>` : '',
        ].filter(Boolean).join('');
        sections += sectionHtml(title, (paramRows ? `<table class="param-table"><tbody>${paramRows}</tbody></table>` : '') + (ex.lesions_description ? field('Descripción de lesiones', ex.lesions_description) : '') + marks || '<em>Sin datos</em>');
      });
    }

    const logoHtml = clinic.general.logo_url
      ? `<img src="${clinic.general.logo_url}" alt="Logo" style="height:50px;object-fit:contain;" />`
      : '';

    if (opts.diagnostico) {
      const items = filterItems('diagnostico');
      if (items.length) {
        const rows = items.map((d: any, i: number, arr: any[]) =>
          (arr.length > 1 ? `<div style="font-size:8pt;color:#999;margin-bottom:2px">#${i+1}${opts.includeDates && d.date ? ' — '+formatDate(d.date) : ''}</div>` : '')
          + field('Diagnóstico', d.diagnosis_text)
          + field('Plan de tratamiento', d.treatment_plan)
        ).join('<hr style="border:none;border-top:1px solid #f0f0f0;margin:6px 0"/>');
        sections += sectionHtml('Diagnósticos', rows || '<em>Sin datos</em>');
      }
    }

    if (opts.tratamientos) {
      const items = filterItems('tratamientos');
      if (items.length) {
        const rows = items.map((t: any, i: number, arr: any[]) =>
          (arr.length > 1 ? `<div style="font-size:8pt;color:#999;margin-bottom:2px">#${i+1}${opts.includeDates && t.date ? ' — '+formatDate(t.date) : ''}</div>` : '')
          + field('Procedimiento', t.procedure_name)
          + field('Área', t.area)
          + field('Estado', t.status)
          + field('Notas', t.notes)
        ).join('<hr style="border:none;border-top:1px solid #f0f0f0;margin:6px 0"/>');
        sections += sectionHtml('Tratamientos', rows || '<em>Sin datos</em>');
      }
    }

    if (opts.recetas) {
      const count = filterItems('recetas').length;
      sections += sectionHtml('Recetas', `<p class="annex-ref">→ Ver receta${count > 1 ? `s (${count})` : ''} — anexo a este documento</p>`);
    }

    if (opts.inyectables) {
      const count = filterItems('inyectables').length;
      sections += sectionHtml('Inyectables', `<p class="annex-ref">→ Ver registro de inyectable${count > 1 ? `s (${count})` : ''} — anexo a este documento</p>`);
    }

    if (opts.consentimientos) {
      const count = filterItems('consentimientos').length;
      sections += sectionHtml('Consentimientos', `<p class="annex-ref">→ Ver consentimiento${count > 1 ? `s informados (${count})` : ' informado'} — anexo a este documento</p>`);
    }

    const signatureSection = opts.includeSignature ? `
      <div class="professional-block">
        <div class="sig-line"></div>
        <div class="sig-name">${profTemp.name}</div>
        ${profTemp.cedula ? `<div class="sig-detail">Cédula/RUC: ${profTemp.cedula}</div>` : ''}
        ${profTemp.matricula ? `<div class="sig-detail">Matrícula SENESCYT: ${profTemp.matricula}</div>` : ''}
        ${profTemp.especialidad ? `<div class="sig-detail">${profTemp.especialidad}</div>` : ''}
      </div>` : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ficha Clínica — ${patient?.first_name} ${patient?.last_name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;font-size:10pt;color:#333;padding:15mm;max-width:210mm}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #deb887;padding-bottom:10px;margin-bottom:14px}
    .clinic-h1{font-size:14pt;color:#b8944d;font-family:Georgia,serif}
    .clinic-sub{font-size:8.5pt;color:#666;line-height:1.4}
    .patient-block{background:#fdf8f0;border:1px solid #e8d5b0;border-radius:5px;padding:8px 12px;margin-bottom:14px}
    .patient-name{font-size:12pt;color:#333;font-family:Georgia,serif;font-weight:bold}
    .patient-sub{font-size:8.5pt;color:#666;margin-top:2px}
    .section{margin-bottom:14px;page-break-inside:avoid}
    .section h2{font-size:8.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;color:#b8944d;border-bottom:1px solid #e8d5b0;padding-bottom:3px;margin-bottom:6px}
    .content{font-size:9.5pt;line-height:1.5}
    .field{margin-bottom:3px}
    .label{font-weight:bold;color:#555}
    .date{font-size:8pt;color:#999;margin-right:3px}
    .table{width:100%;border-collapse:collapse;font-size:8.5pt;margin-top:4px}
    .table th{background:#fdf8f0;color:#b8944d;text-align:left;padding:4px 6px;border:1px solid #e8d5b0;font-size:7.5pt;text-transform:uppercase}
    .table td{padding:3px 6px;border:1px solid #e8d5b0;vertical-align:top}
    .table tr:nth-child(even) td{background:#fafaf8}
    .param-table{width:100%;border-collapse:collapse;font-size:8.5pt}
    .param-table td{padding:2px 6px;border-bottom:1px solid #f0f0f0}
    .param-table td:first-child{font-weight:bold;color:#555;width:35%;white-space:nowrap}
    .marks-title{font-size:8pt;font-weight:bold;color:#888;margin-top:6px;margin-bottom:3px;text-transform:uppercase}
    .marks-list{display:flex;flex-wrap:wrap;gap:4px}
    .mark{font-size:8pt;padding:2px 7px;background:#fdf8f0;border:1px solid #e8d5b0;border-radius:3px;color:#666}
    .professional-block{margin-top:36px;text-align:center;page-break-inside:avoid}
    .sig-line{border-top:1px solid #333;width:200px;margin:0 auto 5px}
    .sig-name{font-weight:bold;font-size:10pt}
    .sig-detail{font-size:8.5pt;color:#666}
    .footer{margin-top:20px;font-size:7.5pt;color:#aaa;text-align:center;border-top:1px solid #eee;padding-top:6px}
    .annex-ref{font-style:italic;color:#666;padding:8px 12px;background:#fdf8f0;border:1px dashed #e8d5b0;border-radius:4px;margin:4px 0}
    @media print{body{padding:8mm}}
  </style>
</head>
<body>
  <div class="header">
    <div>${logoHtml}<p class="clinic-h1">${clinic.general.name||'Clínica'}</p>
      <p class="clinic-sub">${[clinic.general.address, clinic.general.phone?'Tel: '+clinic.general.phone:''].filter(Boolean).join(' &bull; ')}</p>
    </div>
    <div style="text-align:right;font-size:8.5pt;color:#999"><div>Expediente #${recordId}</div><div>${new Date().toLocaleDateString('es')}</div></div>
  </div>
  <div class="patient-block">
    <p class="patient-name">${patient?.first_name} ${patient?.last_name}</p>
    <p class="patient-sub">${[patient?.rut?'RUT: '+patient.rut:'', patient?.birth_date?'Nac: '+formatDate(patient.birth_date):'', patient?.gender||''].filter(Boolean).join(' &bull; ')}</p>
  </div>
  ${sections}
  ${signatureSection}
  <div class="footer">Generado el ${new Date().toLocaleString('es')} &mdash; ${clinic.general.name||'BioSkinTech'}</div>
  <script>window.onload=()=>window.print();<\/script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.93, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col"
        style={{ maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Printer className="w-5 h-5 text-[#b8944d]" />
            <h3 className="text-base font-bold text-gray-800">Imprimir Ficha Clínica</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">

          {/* Professional data warning + inline temporary form */}
          {missingFields.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
              <div className="flex items-start gap-3 p-3">
                <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-amber-800 font-medium">
                    Faltan datos del profesional: <strong>{missingFields.join(', ')}</strong>
                  </p>
                  <button type="button" onClick={() => setShowProfForm(p => !p)}
                    className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2">
                    <Settings className="w-3 h-3" />
                    {showProfForm ? 'Ocultar' : 'Completar para esta impresión'}
                  </button>
                </div>
              </div>
              <AnimatePresence>
                {showProfForm && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    className="px-4 pb-3 pt-1 border-t border-amber-100 bg-white/60 space-y-2">
                    {[
                      { key: 'name', label: 'Nombre profesional', placeholder: 'Dr. / Dra. Nombre Apellido' },
                      { key: 'cedula', label: 'Cédula / RUC', placeholder: '0987654321' },
                      { key: 'matricula', label: 'Matrícula SENESCYT', placeholder: '1020-12-86012345' },
                      { key: 'especialidad', label: 'Especialidad', placeholder: 'Medicina Estética' },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="block text-xs font-semibold text-gray-600 mb-0.5">{f.label}</label>
                        <input type="text"
                          value={profTemp[f.key as keyof typeof profTemp]}
                          onChange={e => setProfTemp(p => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887]"
                        />
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Sections with expandable item selection */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Secciones e Historial</p>
            <div className="space-y-1.5">
              {SECTIONS.map(s => {
                const items = getSectionItems(s.key);
                const isExpanded = expanded[s.key];
                const selCount = (() => {
                  if (!items.length) return null;
                  const sel = selected[s.key];
                  return sel === null || sel === undefined ? items.length : sel.length;
                })();

                return (
                  <div key={s.key} className={`rounded-xl border overflow-hidden ${opts[s.key as keyof PrintOptions] ? 'border-[#deb887]/50 bg-amber-50/30' : 'border-gray-100'}`}>
                    <div className="flex items-center gap-2 p-2.5">
                      <CheckboxUI checked={!!opts[s.key as keyof PrintOptions]} onChange={() => toggle(s.key as keyof PrintOptions)} />
                      <span className={`text-sm font-medium flex-1 ${opts[s.key as keyof PrintOptions] ? 'text-gray-800' : 'text-gray-400'}`}>
                        {s.label}
                      </span>
                      {items.length > 0 && opts[s.key as keyof PrintOptions] && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400">{selCount}/{items.length}</span>
                          <button type="button" onClick={() => setExpanded(p => ({ ...p, [s.key]: !p[s.key] }))}
                            className="text-gray-400 hover:text-[#b8944d] p-0.5 rounded">
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      )}
                    </div>
                    <AnimatePresence>
                      {items.length > 0 && opts[s.key as keyof PrintOptions] && isExpanded && (
                        <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
                          className="border-t border-[#deb887]/20 overflow-hidden">
                          <div className="px-3 py-2 bg-white space-y-1">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs text-gray-400 font-medium">Seleccionar registros</span>
                              <button type="button" onClick={() => toggleAllItems(s.key)}
                                className="text-[10px] text-[#b8944d] font-semibold hover:underline">
                                {(selected[s.key]?.length ?? items.length) === items.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                              </button>
                            </div>
                            {items.map((item, idx) => {
                              const isSel = isItemSelected(s.key, item, idx);
                              return (
                                <label key={getItemId(item, idx)}
                                  className={`flex items-center gap-2 p-1.5 rounded-lg cursor-pointer transition-colors ${isSel ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                                  <CheckboxUI checked={isSel} onChange={() => toggleItem(s.key, item, idx)} />
                                  <span className={`text-xs ${isSel ? 'text-gray-700' : 'text-gray-400 line-through'}`}>
                                    {getItemLabel(s.key, item, idx)}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Options */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Opciones</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: 'includeDates', label: 'Incluir fechas' },
                { key: 'includeSignature', label: 'Incluir firma' },
              ].map(o => (
                <label key={o.key}
                  className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${opts[o.key as keyof PrintOptions] ? 'bg-amber-50 border-[#deb887]/50' : 'border-gray-100 hover:border-gray-200'}`}>
                  <CheckboxUI checked={!!opts[o.key as keyof PrintOptions]} onChange={() => toggle(o.key as keyof PrintOptions)} />
                  <span className="text-xs font-medium text-gray-700">{o.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-4 flex gap-3 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors font-medium">
            Cancelar
          </button>
          <button onClick={handlePrint}
            className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-xl transition-colors flex items-center justify-center gap-2">
            <Printer className="w-4 h-4" /> Imprimir / PDF
          </button>
        </div>
      </motion.div>
    </div>
  );
}
