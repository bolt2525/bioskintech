import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Printer, ArrowLeft, Mail, Download } from 'lucide-react';

export default function TechnicalDocumentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [emptyMode, setEmptyMode] = useState(false);

  useEffect(() => {
    fetch(`/api/technical-service?id=${id}`)
      .then(res => res.json())
      .then(setData)
      .catch(console.error);
  }, [id]);

  if (!data) return <div className="p-10 text-center">Cargando documento...</div>;

  const handlePrint = () => {
    window.print();
  };

  const handlePrintEmpty = () => {
    setEmptyMode(true);
    setTimeout(() => {
      window.print();
      setTimeout(() => setEmptyMode(false), 500);
    }, 100);
  };

  const renderAccessories = (accessories: any) => {
    if (!accessories) return null;
    if (Array.isArray(accessories) && accessories.length > 0) {
      return (
        <div className="space-y-1">
          {accessories.map((acc: any, i: number) => (
            <div key={i} className="flex justify-between items-center text-xs">
              <span className="text-gray-700">{acc.name}</span>
              <span className={`font-semibold px-2 py-0.5 rounded-full text-[10px] ${
                acc.condition === 'bueno' ? 'bg-green-100 text-green-700' :
                acc.condition === 'regular' ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {acc.condition === 'bueno' ? 'Bueno' : acc.condition === 'regular' ? 'Regular' : 'Malo'}
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (typeof accessories === 'string' && accessories.trim()) {
      return <p className="text-gray-600 text-xs">{accessories}</p>;
    }
    return <p className="text-gray-400 text-xs italic">Ninguno declarado.</p>;
  };

  const getDocTitle = () => {
    switch(data.document_type) {
      case 'reception': return 'ACTA DE RECEPCIÓN TÉCNICA';
      case 'delivery_receipt': return 'ACTA DE ENTREGA Y RECEPCIÓN';
      case 'technical_report': return 'INFORME TÉCNICO';
      case 'proforma': return 'PROFORMA DE SERVICIO';
      default: return 'DOCUMENTO TÉCNICO';
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 print:fixed print:inset-0 print:bg-white print:p-0 print:z-[9999] print:overflow-visible">
      <style>{`
        @media print {
          @page { margin: 0.5cm; size: A4; }
          body * { visibility: hidden; }
          #technical-document, #technical-document * { visibility: visible; }
          #technical-document { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0.5cm; }
        }
      `}</style>

      {/* Action Bar - Hidden on Print */}
      <div className="max-w-4xl mx-auto mb-8 flex justify-between print:hidden">
        <button onClick={() => navigate('/admin/technical')} className="flex items-center gap-2 text-gray-600 hover:text-gray-900">
          <ArrowLeft size={20} /> Volver
        </button>
        <div className="flex gap-4">
          <button onClick={handlePrintEmpty} className="bg-white text-gray-700 px-4 py-2 rounded-lg shadow-sm hover:shadow flex items-center gap-2 border border-gray-200">
            <Download size={18} /> Formato Vacío
          </button>
          <button onClick={() => window.alert('Función de envío por email pendiente')} className="bg-white text-gray-700 px-4 py-2 rounded-lg shadow-sm hover:shadow flex items-center gap-2">
            <Mail size={18} /> Enviar por Email
          </button>
          <button onClick={handlePrint} className="bg-[#b8860b] text-white px-4 py-2 rounded-lg shadow-sm hover:bg-[#a0750a] flex items-center gap-2">
            <Printer size={18} /> Imprimir PDF
          </button>
        </div>
      </div>

      {/* A4 Format Document */}
      <div id="technical-document" className={`max-w-[21cm] mx-auto bg-white shadow-lg print:shadow-none min-h-[29.7cm] relative overflow-hidden ${emptyMode ? 'p-[1.2cm]' : 'p-[2cm]'}`}>
        
        {/* Background Watermark */}
        <div className="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none">
          <img src="/images/logo/bioskin-tech-icon.png" alt="Watermark" className="w-[80%]" />
        </div>

        {/* Header with Logo */}
        <div className={`flex justify-between items-start border-b-2 border-[#b8860b] relative z-10 ${emptyMode ? 'pb-3 mb-4' : 'pb-6 mb-8'}`}>
          <div className="flex items-center gap-4">
            <img src="/images/logo/bioskin-tech-full.png" alt="Bioskin Tech Logo" className={`object-contain ${emptyMode ? 'h-14' : 'h-20'}`} />
          </div>
          <div className="text-right">
             <h2 className="text-xl font-bold text-gray-800 uppercase split-words">{getDocTitle()}</h2>
             <div className="bg-gray-100 px-3 py-1 rounded mt-2 inline-block">
               <p className="text-sm font-mono font-bold text-gray-600">{emptyMode ? '#_______________' : `#${data.ticket_number}`}</p>
             </div>
             <p className="text-xs text-gray-400 mt-1">{emptyMode ? 'Fecha: ___/___/______' : new Date(data.created_at).toLocaleDateString()}</p>
          </div>
        </div>

        {/* Common Info Grid */}
        <div className={`grid grid-cols-2 gap-6 text-sm ${emptyMode ? 'mb-4' : 'mb-8'}`}>
          <div className={`${emptyMode ? 'space-y-1' : 'space-y-2'}`}>
             <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1 border-b pb-1">Cliente</h3>
             {emptyMode ? (
               <>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Nombre:</span> ___________________________________</p>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Cédula/RUC:</span> ___________________________________</p>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Contacto:</span> ___________________________________</p>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Centro:</span> ___________________________________</p>
               </>
             ) : (
               <>
                 <p><span className="font-semibold text-gray-700">Nombre:</span> {data.client_name}</p>
                 {data.client_cedula && <p><span className="font-semibold text-gray-700">Cédula/RUC:</span> {data.client_cedula}</p>}
                 <p><span className="font-semibold text-gray-700">Contacto:</span> {data.client_contact}</p>
                 {data.client_center && <p><span className="font-semibold text-gray-700">Centro:</span> {data.client_center}</p>}
               </>
             )}
          </div>
           <div className={`${emptyMode ? 'space-y-1' : 'space-y-2'}`}>
             <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1 border-b pb-1">Equipo</h3>
             {emptyMode ? (
               <>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Marca/Modelo:</span> ___________________________________</p>
                 <p className="text-xs"><span className="font-semibold text-gray-700">Serie/SN:</span> ___________________________________</p>
                 <p className="text-xs mt-2"><span className="font-semibold text-gray-700">Problema / Motivo:</span></p>
                 <div className="border-b border-dashed border-gray-300 h-4"></div>
                 <div className="border-b border-dashed border-gray-300 h-4"></div>
               </>
             ) : (
               <>
                 <p><span className="font-semibold text-gray-700">Marca/Modelo:</span> {data.equipment_data?.brand} {data.equipment_data?.model}</p>
                 <p><span className="font-semibold text-gray-700">Serie/SN:</span> {data.equipment_data?.serial || 'N/A'}</p>
               </>
             )}
          </div>
        </div>

        {/* Specific Layouts based on Doc Type */}
        
        {/* RECEPTION LAYOUT */}
        {(data.document_type === 'reception' || data.document_type === 'delivery_receipt') && (
          <>
            <div className={emptyMode ? 'mb-4' : 'mb-8'}>
              <h3 className={`text-sm font-bold text-gray-800 bg-gray-50 p-2 border-l-4 border-[#b8860b] ${emptyMode ? 'mb-2 text-xs' : 'mb-3'}`}>
                {data.document_type === 'delivery_receipt' ? 'Checklist de Entrega' : 'Estado de Recepción (Checklist)'}
              </h3>
              <table className="w-full text-sm border-collapse">
                 <thead>
                   <tr className="bg-gray-50 text-left text-xs font-bold text-gray-500 uppercase">
                     <th className={`px-2 border border-gray-200 ${emptyMode ? 'py-1' : 'py-2'}`}>Componente</th>
                     <th className={`px-2 border border-gray-200 text-center ${emptyMode ? 'py-1 w-32' : 'py-2 w-24'}`}>Estado</th>
                     <th className={`px-2 border border-gray-200 ${emptyMode ? 'py-1' : 'py-2'}`}>Observación</th>
                   </tr>
                 </thead>
                 <tbody>
                   {emptyMode ? (
                     <>  
                       {['Enciende', 'Pantalla', 'Botones / Perillas', 'Cables / Conectores', 'Carcasa / Estructura', 'Funcionalidad Básica', '', ''].map((label, i) => (
                         <tr key={i}>
                           <td className="py-1 px-2 border border-gray-200 text-xs text-gray-500">{label || ' '}</td>
                           <td className="py-1 px-2 border border-gray-200 text-center">
                             <span className="text-gray-400 text-[10px]">{'☐'} OK {'☐'} MALO {'☐'} N/A</span>
                           </td>
                           <td className="py-1 px-2 border border-gray-200">{' '}</td>
                         </tr>
                       ))}
                     </>
                   ) : (
                     data.checklist_data?.checks?.map((item: any, i: number) => (
                       <tr key={i}>
                         <td className="py-2 px-3 border border-gray-200">{item.label}</td>
                         <td className={`py-2 px-3 border border-gray-200 text-center font-bold ${
                           item.status === 'ok' ? 'text-green-600' : item.status === 'fail' ? 'text-red-500' : 'text-gray-400'
                         }`}>
                           {item.status === 'ok' ? 'OK' : item.status === 'fail' ? 'MALO' : 'N/A'}
                         </td>
                         <td className="py-2 px-3 border border-gray-200 text-gray-600 text-xs italic">{item.observation}</td>
                       </tr>
                     ))
                   )}
                 </tbody>
              </table>
            </div>

            {emptyMode ? (
              <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
                <div className="border border-gray-200 p-3 rounded bg-gray-50">
                  <h4 className="font-bold text-gray-700 mb-2 text-xs">Accesorios Recibidos:</h4>
                  <div className="space-y-2">
                    {[1, 2, 3, 4].map((_, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="border-b border-dashed border-gray-300 flex-1">{'\u00A0'}</span>
                        <span className="text-gray-400 text-[9px] whitespace-nowrap">{'☐'}B {'☐'}R {'☐'}M</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border border-gray-200 p-3 rounded bg-gray-50">
                  <h4 className="font-bold text-gray-700 mb-2 text-xs">Condición Visual:</h4>
                  <div className="space-y-2">
                    {['Sin daños', 'Rayones', 'Golpes', 'Desgaste', 'Pantalla dañada', 'Cables deteriorados'].map((opt) => (
                      <span key={opt} className="inline-flex items-center mr-2 text-[9px] text-gray-500">{'☐'} {opt}</span>
                    ))}
                  </div>
                  <div className="mt-2 border-b border-dashed border-gray-300 h-4"></div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-8 mb-8 text-xs">
                <div className="border border-gray-200 p-4 rounded bg-gray-50">
                  <h4 className="font-bold text-gray-700 mb-2">Accesorios Recibidos:</h4>
                  {renderAccessories(data.equipment_data?.accessories)}
                </div>
                <div className="border border-gray-200 p-4 rounded bg-gray-50">
                  <h4 className="font-bold text-gray-700 mb-2">Condición Visual:</h4>
                  <p className="text-gray-600">{data.equipment_data?.visual_condition || 'Normal, sin daños visibles adicionales.'}</p>
                </div>
              </div>
            )}
            
            {data.document_type === 'delivery_receipt' && (
              <div className={`border border-indigo-200 rounded-lg bg-indigo-50/40 ${emptyMode ? 'mb-3 p-2' : 'mb-8 p-4'}`}>
                <h4 className={`font-bold text-indigo-800 ${emptyMode ? 'text-xs mb-1' : 'text-sm mb-2'}`}>Conformidad de Entrega</h4>
                {emptyMode ? (
                  <div className="space-y-2">{[1,2].map(i => <div key={i} className="border-b border-dashed border-gray-300 h-4"></div>)}</div>
                ) : (
                  <p className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
                    {data.recommendations || 'Equipo entregado sin observaciones adicionales.'}
                  </p>
                )}
              </div>
            )}

            <div className={emptyMode ? 'mb-3 border-t pt-2' : 'mb-8 border-t pt-4'}>
              <h4 className="text-[10px] font-bold text-gray-500 uppercase mb-1">Términos y Condiciones de Recepción:</h4>
              <p className="text-[10px] text-gray-500 text-justify leading-tight italic">
                1. El cliente autoriza la revisión técnica y diagnóstico del equipo detallado. 2. La empresa NO asume responsabilidad por: pérdida de información/datos (se recomienda respaldo previo), fallas ocultas preexistentes no detectables en la recepción visual, ni accesorios no declarados explícitamente en este documento. 3. La garantía aplica únicamente sobre los repuestos cambiados y la mano de obra del servicio específico realizado.
              </p>
            </div>
          </>
        )}

        {/* TECHNICAL REPORT LAYOUT */}
        {data.document_type === 'technical_report' && (
          <>
            <div className={emptyMode ? 'space-y-3 mb-4' : 'space-y-6 mb-8'}>
               <div className="border-l-4 border-blue-500 pl-4 py-1">
                 <h3 className={`font-bold text-gray-800 ${emptyMode ? 'text-xs mb-1' : 'text-sm mb-2'}`}>Diagnóstico Técnico</h3>
                 {emptyMode ? (
                   <div className="space-y-2 mt-1">{[1,2,3].map(i => <div key={i} className="border-b border-dashed border-gray-300 h-4"></div>)}</div>
                 ) : (
                   <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-light">{data.diagnosis}</p>
                 )}
               </div>
               
               <div className="border-l-4 border-green-500 pl-4 py-1">
                 <h3 className={`font-bold text-gray-800 ${emptyMode ? 'text-xs mb-1' : 'text-sm mb-2'}`}>Trabajos Realizados / Recomendaciones</h3>
                 {emptyMode ? (
                   <div className="space-y-2 mt-1">{[1,2,3].map(i => <div key={i} className="border-b border-dashed border-gray-300 h-4"></div>)}</div>
                 ) : (
                   <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-light">{data.recommendations}</p>
                 )}
               </div>
            </div>

            {emptyMode ? (
              <div className="mb-4 opacity-75">
                <h3 className="text-xs font-bold text-gray-500 mb-1 uppercase">Pruebas de Funcionamiento Final</h3>
                <div className="grid grid-cols-2 gap-1">
                  {['Voltaje Entrada', 'Fuente Poder', 'Sistema Refrigeración', 'Emisión de Energía', '', ''].map((label, i) => (
                    <div key={i} className="flex justify-between items-center text-xs border-b border-gray-100 py-1">
                      <span className="text-gray-500">{label || ' '}</span>
                      <span className="text-gray-400 text-[10px]">{'☐'} PASS {'  ☐'} FAIL</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              data.checklist_data?.checks?.length > 0 && (
                <div className="mb-8 opacity-75">
                  <h3 className="text-xs font-bold text-gray-500 mb-2 uppercase">Pruebas de Funcionamiento Final</h3>
                  <div className="grid grid-cols-2 gap-2">
                     {data.checklist_data.checks.map((item: any, i: number) => (
                       <div key={i} className="flex justify-between items-center text-xs border-b border-gray-100 py-1">
                          <span>{item.label}</span>
                          <span className={item.status === 'ok' ? 'text-green-600 font-bold' : 'text-red-500'}>
                            {item.status === 'ok' ? 'PASS' : 'FAIL'}
                          </span>
                       </div>
                     ))}
                  </div>
                </div>
              )
            )}
          </>
        )}

         {/* PROFORMA LAYOUT */}
        {data.document_type === 'proforma' && (
          <>
            <div className="mb-8">
               <h3 className="text-sm font-bold text-gray-800 mb-3 bg-gray-50 p-2">Detalle de Costos</h3>
               <table className="w-full text-sm border-collapse">
                 <thead>
                   <tr className="bg-gray-800 text-white text-left text-xs uppercase">
                     <th className="py-3 px-4 w-2/3">Descripción del Servicio / Repuesto</th>
                     <th className="py-3 px-4 text-right">Valor</th>
                   </tr>
                 </thead>
                 <tbody>
                    {emptyMode ? (
                      <>
                        {[1,2,3,4].map(i => (
                          <tr key={i}>
                            <td className="py-4 px-4 border-b border-gray-100">&nbsp;</td>
                            <td className="py-4 px-4 border-b border-gray-100 text-right">$________</td>
                          </tr>
                        ))}
                      </>
                    ) : (
                      <tr>
                        <td className="py-4 px-4 border-b border-gray-100 align-top">
                          <p className="font-bold text-gray-800 mb-1">Servicio Técnico Especializado</p>
                          <p className="text-gray-600 text-xs whitespace-pre-wrap">{data.recommendations}</p>
                          {data.diagnosis && <p className="text-gray-500 text-[10px] mt-2 italic">Ref. Diagnóstico: {data.diagnosis.substring(0, 100)}...</p>}
                        </td>
                        <td className="py-4 px-4 border-b border-gray-100 text-right font-mono">
                          ${Number(data.total_cost).toFixed(2)}
                        </td>
                      </tr>
                    )}
                    <tr className="bg-gray-50 font-bold text-gray-900">
                      <td className="py-3 px-4 text-right text-xs uppercase">Total a Pagar</td>
                      <td className="py-3 px-4 text-right font-mono text-lg border-t-2 border-gray-800">
                         {emptyMode ? '$________' : `$${Number(data.total_cost).toFixed(2)}`}
                      </td>
                    </tr>
                 </tbody>
               </table>
            </div>

            <div className="bg-[#fcfbf7] border border-[#deb887]/30 p-4 rounded text-xs text-gray-600 mb-8">
               <h4 className="font-bold text-[#b8860b] mb-2">Condiciones Comerciales:</h4>
               <ul className="list-disc list-inside space-y-1">
                 <li>Validez de la oferta: 15 días calendario.</li>
                 <li>Tiempo de entrega: Sujeto a disponibilidad de repuestos (aprox. 3-5 días hábiles).</li>
                 <li>Forma de pago: 50% anticipo, 50% contra entrega.</li>
                 <li>Garantía: 3 meses sobre el trabajo realizado (no cubre partes eléctricas por mala manipulación).</li>
               </ul>
            </div>
          </>
        )}

        {/* Footer / Signatures - Conditional per type */}
        <div className={`absolute bottom-14 left-0 right-0 ${emptyMode ? 'px-[1.2cm]' : 'px-[2cm]'}`}>
            <div className={`flex justify-between items-end ${emptyMode ? 'pt-4' : 'pt-12'}`}>
                <div className="text-center w-48">
                    <div className={`border-b border-gray-800 mb-1 ${emptyMode ? 'h-10' : 'h-16'}`}></div>
                    <p className="text-xs font-bold">Ing. Rafael Larrea</p>
                    <p className="text-[10px] font-bold uppercase">BIOSKINTECH</p>
                </div>
                
                {(data.document_type === 'reception' || data.document_type === 'delivery_receipt') && (
                  <div className="text-center w-48">
                      <div className={`border-b border-gray-800 mb-1 ${emptyMode ? 'h-10' : 'h-16'}`}></div>
                      {emptyMode ? (
                        <div className="text-left space-y-1 mt-1">
                          <p className="text-[10px] text-gray-500">Firma: ________________________</p>
                          <p className="text-[10px] text-gray-500">Nombre: ______________________</p>
                          <p className="text-[10px] text-gray-500">Cédula: _______________________</p>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs font-bold uppercase">{data.client_name}</p>
                          {data.client_cedula && <p className="text-[10px] text-gray-500">C.I.: {data.client_cedula}</p>}
                          {data.client_center && <p className="text-[10px] text-gray-500">{data.client_center}</p>}
                          <p className="text-[10px] text-gray-400 mt-1">
                            {data.document_type === 'delivery_receipt' ? 'Recibí Conforme' : 'Entregué Conforme'}
                          </p>
                        </>
                      )}
                  </div>
                )}

                {data.document_type === 'proforma' && (
                  <div className="text-center w-48">
                      <div className={`border-b border-gray-800 mb-1 ${emptyMode ? 'h-10' : 'h-16'}`}></div>
                      <p className="text-xs font-bold uppercase">Aprobación</p>
                      <p className="text-[10px] text-gray-400">Firma y Sello Cliente</p>
                  </div>
                )}
            </div>
        </div>

      </div>
    </div>
  );
}
