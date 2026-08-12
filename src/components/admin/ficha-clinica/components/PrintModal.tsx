import React, { useState, useEffect } from 'react';
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
  const { user, checkAuth } = useAuth();
  const [opts, setOpts] = useState<PrintOptions>(DEFAULT_OPTIONS);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, string[] | null>>({});
  const [showProfForm, setShowProfForm] = useState(false);
  const [profTemp, setProfTemp] = useState({
    name: user?.full_name || user?.username || '',
    cedula: user?.cedula_profesional || '',
    matricula: user?.matricula_senescyt || '',
    especialidad: user?.especialidad || '',
  });

  // Refresh user data from DB on open — master admin may have updated professional fields
  useEffect(() => {
    checkAuth().then(() => {}).catch(() => {});
  }, []);

  // Sync profTemp with fresh user data; only fill still-empty slots to preserve manual edits
  useEffect(() => {
    if (!user) return;
    setProfTemp(prev => ({
      name:        prev.name        || user.full_name        || user.username || '',
      cedula:      prev.cedula      || user.cedula_profesional || '',
      matricula:   prev.matricula   || user.matricula_senescyt || '',
      especialidad: prev.especialidad || user.especialidad     || '',
    }));
  }, [user?.cedula_profesional, user?.matricula_senescyt, user?.especialidad, user?.full_name]);

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
    const esc = (s: any) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const formatDate = (d: string) => d ? new Date(d).toLocaleDateString('es-EC', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
    const formatDateShort = (d: string) => d ? new Date(d).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const field = (label: string, val: any) =>
      val ? `<div class="field"><span class="label">${label}:</span> <span class="val">${esc(String(val))}</span></div>` : '';
    const sectionHtml = (title: string, content: string, subtitle = '') =>
      `<div class="section"><div class="section-head"><h2>${title}</h2>${subtitle ? `<span class="section-sub">${subtitle}</span>` : ''}</div><div class="content">${content}</div></div>`;
    const trow = (cells: string[]) => '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';

    // Clinic info
    const clinicName    = clinic.general.name || user?.clinic_name || 'Cl\u00ednica';
    const clinicTagline = clinic.general.tagline || '';
    const clinicAddr    = clinic.general.address || '';
    const clinicCity    = clinic.general.city || '';
    const clinicPhone   = clinic.general.phone || '';
    const clinicEmail   = clinic.email?.staff_email || '';
    const clinicTaxId   = clinic.general.tax_id || '';
    const logoHtml      = clinic.general.logo_url
      ? `<img src="${clinic.general.logo_url}" alt="${esc(clinicName)}" class="clinic-logo" />`
      : `<div class="clinic-logo-placeholder">${esc(clinicName.substring(0,2).toUpperCase())}</div>`;

    // Professional info
    const profName       = profTemp.name || user?.full_name || '';
    const profEsp        = profTemp.especialidad || '';
    const profMatricula  = profTemp.matricula || '';
    const profCedula     = profTemp.cedula || '';

    // Patient calculated age
    const patientAge = patient?.birth_date
      ? Math.floor((Date.now() - new Date(patient.birth_date).getTime()) / (365.25 * 86400000))
      : null;

    // Today formatted
    const todayLong = new Date().toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    let sections = '';

    if (opts.antecedentes) {
      const content = [
        field('Antecedentes patol\u00f3gicos',   h.pathological),
        field('Antecedentes no patol\u00f3gicos', h.non_pathological),
        field('Antecedentes familiares',     h.family_history),
        field('Antecedentes quir\u00fargicos',    h.surgical_history),
        field('Alergias',                    h.allergies),
        field('Medicaci\u00f3n actual',           h.current_medications),
        field('Antecedentes est\u00e9ticos',      h.aesthetic_history),
        field('Antecedentes ginecol\u00f3gicos',  h.gynecological_history),
        field('Rutina facial',               h.facial_routine),
      ].filter(Boolean).join('') || '<em class="empty">Sin datos registrados</em>';
      sections += sectionHtml('Antecedentes Cl\u00ednicos', content);
    }

    if (opts.consulta && consultation) {
      const subtitle = opts.includeDates && consultation.created_at ? formatDateShort(consultation.created_at) : '';
      const content = [
        field('Motivo de consulta',               consultation.reason),
        field('Historia de la enfermedad actual',  consultation.current_illness),
        field('Observaciones',                     consultation.observations),
      ].filter(Boolean).join('') || '<em class="empty">Sin datos</em>';
      sections += sectionHtml('Consulta', content, subtitle);
    }

    if (opts.examenFisico) {
      const items = filterItems('examenFisico');
      if (items.length === 0) {
        sections += sectionHtml('Examen F\u00edsico', '<em class="empty">Sin datos registrados</em>');
      } else {
        items.forEach((ex: any, i: number, arr: any[]) => {
          const subtitle = opts.includeDates && ex.created_at ? formatDateShort(ex.created_at) : '';
          const titleSuffix = arr.length > 1 ? ` #${i+1}` : '';
          const paramRows = ([
            ['Tipo de piel', ex.skin_type], ['Fototipo', ex.phototype],
            ['Escala Glogau', ex.glogau_scale], ['Hidrataci\u00f3n', ex.hydration],
            ['Elasticidad', ex.elasticity], ['Fotoprotecci\u00f3n', ex.photoprotection],
            ['Textura', ex.texture], ['Poros', ex.poros],
            ['Pigmentaci\u00f3n', ex.pigmentation], ['Sensibilidad', ex.sensitivity],
          ] as [string, string][]).filter(([,v]) => v)
            .map(([k,v]) => trow([`<span class="param-key">${esc(k)}</span>`, `<span class="param-val">${esc(v)}</span>`])).join('');
          const tableHtml = paramRows
            ? `<table class="param-table"><tbody>${paramRows}</tbody></table>`
            : '';
          const lesionsHtml = ex.lesions_description
            ? `<div class="field" style="margin-top:6px"><span class="label">Descripci\u00f3n de lesiones:</span> <span class="val">${esc(ex.lesions_description)}</span></div>`
            : '';
          const fm: any[] = (() => { try { return JSON.parse(ex.face_map_data || '[]'); } catch { return []; } })();
          const bm: any[] = (() => { try { return JSON.parse(ex.body_map_data || '[]'); } catch { return []; } })();
          const marks = [
            fm.length ? `<div class="marks-title">Marcaciones faciales (${fm.length}):</div><div class="marks-list">${fm.map((m:any)=>`<span class="mark">${esc(m.category)}${m.tercio ? ' &middot; '+esc(m.tercio) : ''}${m.notes ? ' &mdash; '+esc(m.notes) : ''}</span>`).join('')}</div>` : '',
            bm.length ? `<div class="marks-title">Marcaciones corporales (${bm.length}):</div><div class="marks-list">${bm.map((m:any)=>`<span class="mark">${esc(m.category)}${m.tercio ? ' &middot; '+esc(m.tercio) : ''}${m.notes ? ' &mdash; '+esc(m.notes) : ''}</span>`).join('')}</div>` : '',
          ].filter(Boolean).join('');
          const empty = !paramRows && !lesionsHtml && !marks;
          sections += sectionHtml('Examen F\u00edsico' + titleSuffix, (empty ? '<em class="empty">Sin datos</em>' : tableHtml + lesionsHtml + marks), subtitle);
        });
      }
    }

    if (opts.diagnostico) {
      const items = filterItems('diagnostico');
      if (!items.length) {
        sections += sectionHtml('Diagn\u00f3sticos', '<em class="empty">Sin diagn\u00f3sticos registrados</em>');
      } else {
        const rows = items.map((d: any, i: number, arr: any[]) => {
          const sub = opts.includeDates && d.date ? `<span class="item-date">${formatDateShort(d.date)}</span>` : '';
          return `<div class="item-block">${arr.length > 1 ? `<div class="item-num">${sub}Diagn\u00f3stico ${i+1}</div>` : sub}`
            + field('Diagn\u00f3stico', d.diagnosis_text)
            + field('Plan de tratamiento', d.treatment_plan)
            + field('Observaciones', d.observations)
            + '</div>';
        }).join('');
        sections += sectionHtml('Diagn\u00f3sticos', rows);
      }
    }

    if (opts.tratamientos) {
      const items = filterItems('tratamientos');
      if (!items.length) {
        sections += sectionHtml('Tratamientos', '<em class="empty">Sin tratamientos registrados</em>');
      } else {
        const rows = items.map((t: any, i: number, arr: any[]) => {
          const sub = opts.includeDates && t.date ? `<span class="item-date">${formatDateShort(t.date)}</span>` : '';
          return `<div class="item-block">${arr.length > 1 ? `<div class="item-num">${sub}Tratamiento ${i+1}</div>` : sub}`
            + field('Procedimiento', t.procedure_name)
            + field('\u00c1rea', t.area)
            + field('Cantidad de sesiones', t.sessions)
            + field('Estado', t.status)
            + field('Notas', t.notes)
            + '</div>';
        }).join('');
        sections += sectionHtml('Tratamientos', rows);
      }
    }

    // Annex references
    const annexSections: string[] = [];
    if (opts.recetas) {
      const count = filterItems('recetas').length;
      annexSections.push(`Receta${count > 1 ? 's m\u00e9dicas (' + count + ')' : ' m\u00e9dica'}`);
    }
    if (opts.inyectables) {
      const count = filterItems('inyectables').length;
      annexSections.push(`Registro de inyectable${count > 1 ? 's (' + count + ')' : ''}`);
    }
    if (opts.consentimientos) {
      const count = filterItems('consentimientos').length;
      annexSections.push(`Consentimiento${count > 1 ? 's informados (' + count + ')' : ' informado'}`);
    }
    if (annexSections.length) {
      const list = annexSections.map((a, i) => `<li><strong>${i+1}. ${a}</strong> &mdash; imprimir desde el tab correspondiente de la ficha cl\u00ednica.</li>`).join('');
      sections += sectionHtml('Documentos Anexos a Imprimir', `<p class="annex-intro">Los siguientes documentos forman parte de esta historia cl\u00ednica. Imp\u00edmalos desde sus respectivos tabs en la ficha del paciente:</p><ul class="annex-list">${list}</ul>`);
    }

    // Signature block
    const signatureHtml = opts.includeSignature ? `
    <div class="sig-section">
      <div class="sig-block">
        <div class="sig-line-space"></div>
        <div class="sig-line"></div>
        <div class="sig-name">${esc(profName) || '&nbsp;'}</div>
        ${profEsp ? `<div class="sig-detail">${esc(profEsp)}</div>` : ''}
        ${profMatricula ? `<div class="sig-detail">Matr. SENESCYT: ${esc(profMatricula)}</div>` : ''}
        ${profCedula ? `<div class="sig-detail">C\u00e9dula/RUC: ${esc(profCedula)}</div>` : ''}
      </div>
      <div class="sig-block">
        <div class="sig-line-space"></div>
        <div class="sig-line"></div>
        <div class="sig-name">Firma del Paciente / Representante</div>
        <div class="sig-detail">${esc(patient?.first_name || '')} ${esc(patient?.last_name || '')}</div>
      </div>
    </div>` : '';

    // Footer contact
    const contactItems = [
      clinicAddr ? '\u{1F4CD} ' + clinicAddr + (clinicCity ? ', ' + clinicCity : '') : '',
      clinicPhone ? '\u{1F4DE} ' + clinicPhone : '',
      clinicEmail ? '\u2709 ' + clinicEmail : '',
      clinicTaxId ? 'RUC: ' + clinicTaxId : '',
    ].filter(Boolean);

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ficha Cl\u00ednica \u2014 ${esc(patient?.first_name || '')} ${esc(patient?.last_name || '')}</title>
  <style>
    @page{size:A4 portrait;margin:18mm 15mm 20mm 15mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:9.5pt;color:#2d2d2d;background:#fff}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #deb887;padding-bottom:12px;margin-bottom:6px}
    .lh-left{display:flex;align-items:flex-start;gap:12px}
    .clinic-logo{height:56px;width:auto;object-fit:contain}
    .clinic-logo-placeholder{width:56px;height:56px;background:#deb887;color:#fff;font-size:18pt;font-weight:700;border-radius:6px;display:flex;align-items:center;justify-content:center}
    .clinic-name{font-size:15pt;font-weight:700;color:#b8944d;font-family:Georgia,serif;line-height:1.1}
    .clinic-tag{font-size:8pt;color:#888;margin-top:2px}
    .lh-right{text-align:right;font-size:8pt;color:#666;min-width:170px}
    .lh-right .exp-num{font-size:11pt;font-weight:700;color:#b8944d}
    .lh-right .lh-date{font-size:8.5pt;color:#444;margin-top:3px;text-transform:capitalize}
    .lh-right .lh-city{font-size:8pt;color:#888}
    .prof-bar{display:flex;justify-content:space-between;align-items:center;background:#fdf8f0;border:1px solid #e8d5b0;border-radius:5px;padding:7px 12px;margin-bottom:14px;margin-top:8px}
    .prof-name{font-size:10pt;font-weight:700;color:#222}
    .prof-details{font-size:8pt;color:#666;margin-top:2px}
    .doc-label{font-size:8pt;font-weight:600;color:#b8944d;text-transform:uppercase;letter-spacing:.5px}
    .patient-block{border:1.5px solid #deb887;border-radius:6px;padding:10px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .patient-name{font-size:12pt;font-family:Georgia,serif;font-weight:700;color:#1a1a1a}
    .patient-sub{font-size:8.5pt;color:#555;margin-top:3px;line-height:1.7}
    .patient-right{text-align:right;font-size:8.5pt;color:#666;flex-shrink:0}
    .section{margin-bottom:13px;page-break-inside:avoid}
    .section-head{display:flex;align-items:baseline;gap:8px;border-bottom:1.5px solid #e8d5b0;padding-bottom:3px;margin-bottom:7px}
    .section h2{font-size:8pt;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#b8944d;margin:0}
    .section-sub{font-size:7.5pt;color:#999}
    .content{font-size:9pt;line-height:1.55}
    .field{margin-bottom:4px}
    .label{font-weight:600;color:#444}
    .val{color:#111}
    .empty{color:#aaa;font-style:italic;font-size:8.5pt}
    .param-table{width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:6px}
    .param-table tbody tr:nth-child(odd){background:#fdf8f0}
    .param-table td{padding:3px 8px;border-bottom:1px solid #f0ebe0}
    .param-key{font-weight:600;color:#555;display:inline-block;min-width:160px}
    .param-val{color:#222}
    .marks-title{font-size:7.5pt;font-weight:700;color:#999;margin-top:7px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px}
    .marks-list{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
    .mark{font-size:7.5pt;padding:2px 8px;background:#fdf8f0;border:1px solid #e8d5b0;border-radius:3px;color:#555}
    .item-block{padding:6px 0;border-bottom:1px solid #f5f0e8}
    .item-block:last-child{border-bottom:none}
    .item-num{font-size:7.5pt;font-weight:700;color:#b8944d;margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px}
    .item-date{font-size:7.5pt;color:#999;margin-right:6px}
    .annex-intro{font-size:8.5pt;color:#555;margin-bottom:8px;font-style:italic}
    .annex-list{list-style:none;padding:0}
    .annex-list li{font-size:8.5pt;padding:5px 10px;margin-bottom:4px;background:#fdf8f0;border-left:3px solid #deb887;border-radius:0 4px 4px 0;color:#333}
    .sig-section{display:flex;justify-content:space-around;margin-top:40px;page-break-inside:avoid;gap:20px}
    .sig-block{flex:1;text-align:center;max-width:220px}
    .sig-line-space{height:52px}
    .sig-line{border-top:1px solid #333;margin-bottom:5px}
    .sig-name{font-size:9pt;font-weight:700;color:#111}
    .sig-detail{font-size:7.5pt;color:#555;margin-top:1px}
    .contact-footer{margin-top:18px;border-top:1.5px solid #e8d5b0;padding-top:8px;font-size:7.5pt;color:#666;text-align:center;line-height:1.8}
    .gen-footer{margin-top:5px;font-size:7pt;color:#bbb;text-align:center}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style>
</head>
<body>
  <div class="letterhead">
    <div class="lh-left">
      ${logoHtml}
      <div>
        <div class="clinic-name">${esc(clinicName)}</div>
        ${clinicTagline ? `<div class="clinic-tag">${esc(clinicTagline)}</div>` : ''}
      </div>
    </div>
    <div class="lh-right">
      <div style="font-size:8pt;color:#aaa;text-transform:uppercase;letter-spacing:.5px">Historia Cl\u00ednica</div>
      <div class="exp-num">Exp. #${recordId}</div>
      <div class="lh-date">${todayLong}</div>
      ${clinicCity ? `<div class="lh-city">${esc(clinicCity)}</div>` : ''}
    </div>
  </div>

  ${(profName || profEsp) ? `
  <div class="prof-bar">
    <div>
      <div class="prof-name">${esc(profName)}</div>
      <div class="prof-details">${[profEsp, profMatricula ? 'Matr. SENESCYT: ' + profMatricula : '', profCedula ? 'C\u00e9dula/RUC: ' + profCedula : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ')}</div>
    </div>
    <div class="doc-label">Ficha Cl\u00ednica</div>
  </div>` : ''}

  <div class="patient-block">
    <div>
      <div class="patient-name">${esc(patient?.first_name || '')} ${esc(patient?.last_name || '')}</div>
      <div class="patient-sub">
        ${patient?.rut ? `<strong>C\u00e9dula/ID:</strong> ${esc(patient.rut)} &nbsp;&nbsp;` : ''}
        ${patient?.birth_date ? `<strong>Nac:</strong> ${formatDateShort(patient.birth_date)} &nbsp;&nbsp;` : ''}
        ${patientAge !== null ? `<strong>Edad:</strong> ${patientAge} a\u00f1os &nbsp;&nbsp;` : ''}
        ${patient?.gender ? `<strong>Sexo:</strong> ${esc(patient.gender)}` : ''}
      </div>
      ${patient?.phone ? `<div class="patient-sub"><strong>Tel:</strong> ${esc(patient.phone)}</div>` : ''}
      ${patient?.email ? `<div class="patient-sub"><strong>Email:</strong> ${esc(patient.email)}</div>` : ''}
    </div>
    <div class="patient-right">
      <div><strong>Fecha de atenci\u00f3n</strong></div>
      <div>${new Date().toLocaleDateString('es-EC')}</div>
    </div>
  </div>

  ${sections}

  ${signatureHtml}

  ${contactItems.length ? `<div class="contact-footer">${contactItems.join(' &nbsp;&nbsp;|&nbsp;&nbsp; ')}</div>` : ''}
  <div class="gen-footer">Documento generado el ${new Date().toLocaleString('es-EC')} &mdash; ${esc(clinicName)}</div>
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
