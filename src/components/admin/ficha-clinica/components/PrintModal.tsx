import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Printer, X, AlertCircle } from 'lucide-react';
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

export default function PrintModal({ patient, recordId, recordData, activeConsultation, onClose }: Props) {
  const { settings: clinic } = useClinicSettings();
  const { user } = useAuth();
  const [opts, setOpts] = useState<PrintOptions>(DEFAULT_OPTIONS);

  // Detect missing professional data
  const profesionalName = (user as any)?.full_name || (user as any)?.username || '';
  const cedula = (user as any)?.cedula_profesional || '';
  const especialidad = (user as any)?.especialidad || '';
  const missingFields: string[] = [];
  if (!cedula) missingFields.push('cédula/matrícula');
  if (!especialidad) missingFields.push('especialidad');

  const toggle = (key: keyof PrintOptions) =>
    setOpts(p => ({ ...p, [key]: !p[key] }));

  const handlePrint = () => {
    // Build HTML for each selected section
    const h = recordData?.history || {};
    const consultation = activeConsultation;
    const diagnoses = recordData?.diagnoses || [];
    const treatments = recordData?.treatments || [];
    const prescriptions = recordData?.prescriptions || [];

    const formatDate = (d: string) => d ? new Date(d).toLocaleDateString('es') : '';

    const sectionHtml = (title: string, content: string) => `
      <div class="section">
        <h2>${title}</h2>
        <div class="content">${content}</div>
      </div>`;

    const field = (label: string, val: string) =>
      val ? `<div class="field"><span class="label">${label}:</span> <span>${val}</span></div>` : '';

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
      sections += sectionHtml('Consulta' + (opts.includeDates ? ` — ${formatDate(consultation.created_at)}` : ''),
        [field('Motivo', consultation.reason), field('Historia de la enfermedad actual', consultation.current_illness)].filter(Boolean).join('') || '<em>Sin datos</em>'
      );
    }

    if (opts.diagnostico && diagnoses.length) {
      const items = diagnoses.map((d: any) =>
        `<div class="list-item">${opts.includeDates ? `<span class="date">${formatDate(d.date)}</span> ` : ''}${d.diagnosis_text}${d.cie10_code ? ` [${d.cie10_code}]` : ''}</div>`
      ).join('');
      sections += sectionHtml('Diagnósticos', items);
    }

    if (opts.tratamientos && treatments.length) {
      const items = treatments.map((t: any) =>
        `<div class="list-item">${opts.includeDates ? `<span class="date">${formatDate(t.date)}</span> ` : ''}${t.procedure_name}${t.area_treated ? ` — ${t.area_treated}` : ''}</div>`
      ).join('');
      sections += sectionHtml('Tratamientos', items);
    }

    if (opts.recetas && prescriptions.length) {
      const items = prescriptions.map((p: any) => {
        const itemsArr = Array.isArray(p.items) ? p.items : (typeof p.items === 'string' ? JSON.parse(p.items) : []);
        const drugs = itemsArr.map((i: any) => `${i.medicamento || i.nombre_comercial} ${i.dosis || ''}`).filter(Boolean).join(', ');
        return `<div class="list-item">${opts.includeDates ? `<span class="date">${formatDate(p.date)}</span> ` : ''}${drugs}</div>`;
      }).join('');
      sections += sectionHtml('Recetas', items);
    }

    const logoHtml = clinic.general.logo_url
      ? `<img src="${clinic.general.logo_url}" alt="Logo" style="height:60px;object-fit:contain;" />`
      : '';

    const signatureSection = opts.includeSignature ? `
      <div class="professional-block">
        <div class="sig-line"></div>
        <div class="sig-name">${profesionalName}</div>
        ${cedula ? `<div class="sig-detail">Cédula: ${cedula}</div>` : ''}
        ${especialidad ? `<div class="sig-detail">${especialidad}</div>` : ''}
      </div>` : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ficha Clínica — ${patient?.first_name} ${patient?.last_name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #333; padding: 30mm 20mm; max-width: 210mm; }
    .header { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid #deb887; padding-bottom: 12px; margin-bottom: 16px; }
    .clinic-info h1 { font-size: 16pt; color: #b8944d; font-family: 'Georgia', serif; }
    .clinic-info p { font-size: 9pt; color: #666; line-height: 1.4; }
    .patient-block { background: #fdf8f0; border: 1px solid #e8d5b0; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; }
    .patient-block h2 { font-size: 13pt; color: #333; font-family: 'Georgia', serif; }
    .patient-block p { font-size: 9pt; color: #666; margin-top: 2px; }
    .section { margin-bottom: 18px; page-break-inside: avoid; }
    .section h2 { font-size: 10pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: #b8944d; border-bottom: 1px solid #e8d5b0; padding-bottom: 4px; margin-bottom: 8px; }
    .content { font-size: 10pt; line-height: 1.5; }
    .field { margin-bottom: 5px; }
    .label { font-weight: bold; color: #555; }
    .list-item { margin-bottom: 5px; padding-left: 12px; }
    .date { font-size: 9pt; color: #999; }
    .professional-block { margin-top: 50px; text-align: center; }
    .sig-line { border-top: 1px solid #333; width: 200px; margin: 0 auto 6px; }
    .sig-name { font-weight: bold; font-size: 10pt; }
    .sig-detail { font-size: 9pt; color: #666; }
    .footer { margin-top: 30px; font-size: 8pt; color: #aaa; text-align: center; border-top: 1px solid #eee; padding-top: 8px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="clinic-info">
      ${logoHtml}
      <h1>${clinic.general.name || 'Clínica'}</h1>
      ${clinic.general.address ? `<p>${clinic.general.address}${clinic.general.city ? ', ' + clinic.general.city : ''}</p>` : ''}
      ${clinic.general.phone ? `<p>Tel: ${clinic.general.phone}</p>` : ''}
    </div>
    <div style="text-align:right;font-size:9pt;color:#999;">
      <div>Expediente #${recordId}</div>
      <div>${new Date().toLocaleDateString('es')}</div>
    </div>
  </div>

  <div class="patient-block">
    <h2>${patient?.first_name} ${patient?.last_name}</h2>
    <p>${[patient?.rut ? 'RUT: ' + patient.rut : '', patient?.birth_date ? 'Nac: ' + formatDate(patient.birth_date) : '', patient?.gender || ''].filter(Boolean).join(' · ')}</p>
  </div>

  ${sections}
  ${signatureSection}

  <div class="footer">Generado el ${new Date().toLocaleString('es')} — ${clinic.general.name || 'BIOSKIN'}</div>
  <script>window.onload=()=>window.print();</script>
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
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <Printer className="w-5 h-5 text-[#b8944d]" />
            <h3 className="text-base font-bold text-gray-800">Imprimir Ficha Clínica</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Missing professional data warning */}
          {missingFields.length > 0 && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Faltan datos del profesional: <strong>{missingFields.join(', ')}</strong>. Puedes configurarlos en <em>Admin Master → Usuarios</em> o continuar sin ellos.</span>
            </div>
          )}

          {/* Sections to include */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Secciones a incluir</p>
            <div className="grid grid-cols-2 gap-2">
              {SECTIONS.map(s => (
                <label key={s.key} className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-all ${
                  opts[s.key as keyof PrintOptions] ? 'bg-amber-50 border-[#deb887]/60' : 'border-gray-100 hover:border-gray-200'
                }`}>
                  <input type="checkbox" checked={!!opts[s.key as keyof PrintOptions]}
                    onChange={() => toggle(s.key as keyof PrintOptions)} className="sr-only" />
                  <div className={`w-4 h-4 rounded flex items-center justify-center border-2 flex-shrink-0 ${
                    opts[s.key as keyof PrintOptions] ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300'
                  }`}>
                    {opts[s.key as keyof PrintOptions] && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs font-medium text-gray-700">{s.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Options */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Opciones</p>
            <div className="space-y-2">
              {[
                { key: 'includeDates', label: 'Incluir fechas en historial' },
                { key: 'includeSignature', label: 'Incluir firma del profesional' },
              ].map(o => (
                <label key={o.key} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${
                  opts[o.key as keyof PrintOptions] ? 'bg-amber-50 border-[#deb887]/60' : 'border-gray-100'
                }`}>
                  <input type="checkbox" checked={!!opts[o.key as keyof PrintOptions]}
                    onChange={() => toggle(o.key as keyof PrintOptions)} className="sr-only" />
                  <div className={`w-4 h-4 rounded flex items-center justify-center border-2 flex-shrink-0 ${
                    opts[o.key as keyof PrintOptions] ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300'
                  }`}>
                    {opts[o.key as keyof PrintOptions] && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs font-medium text-gray-700">{o.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="px-6 pb-5 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors font-medium">
            Cancelar
          </button>
          <button onClick={handlePrint} className="flex-1 px-4 py-2.5 text-sm font-bold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-xl transition-colors flex items-center justify-center gap-2">
            <Printer className="w-4 h-4" /> Imprimir
          </button>
        </div>
      </motion.div>
    </div>
  );
}
