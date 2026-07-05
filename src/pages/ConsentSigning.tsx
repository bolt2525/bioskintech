import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import { CheckCircle, AlertTriangle, PenTool, Eraser, Save, X } from 'lucide-react';

interface ConsentSession {
  id: number;
  patient_id: number;
  procedure_type: string;
  description: string;
  declarations: {
    understanding: boolean;
    questions: boolean;
    results: boolean;
    authorization: boolean;
    revocation: boolean;
    alternatives: boolean;
  };
  signatures: {
    patient_name: string;
    professional_name: string;
    patient_sig_data?: string;
  };
  status: string;
  signing_status: string;
  // Added fields for full document view
  objectives?: string[];
  risks?: any;
  benefits?: any;
  alternatives?: any;
  pre_care?: any;
  post_care?: any;
  contraindications?: any;
  critical_antecedents?: {
    allergies: string;
    medications: string;
    pregnancy: boolean;
    herpes: boolean;
  };
  authorizations?: {
    image_use: boolean;
    photo_video: boolean;
  };
  patient?: {
    first_name: string;
    last_name: string;
    rut: string;
    phone: string;
    birth_date: string;
  };
}

export default function ConsentSigning() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<ConsentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [declarations, setDeclarations] = useState<any>({});
  const [isSigning, setIsSigning] = useState(false);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const sigCanvas = useRef<SignatureCanvas>(null);

  useEffect(() => {
    if (token) {
      fetchSession();
    }
  }, [token]);

  const calculateAge = (birthDate: string) => {
    if (!birthDate) return 0;
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  const fetchSession = async () => {
    try {
      const res = await fetch(`/api/records?action=getSigningSession&token=${token}`);
      if (!res.ok) throw new Error('Sesión no encontrada o expirada');
      const data = await res.json();
      setSession(data);
      setDeclarations({
        ...data.declarations,
        // Ensure all keys exist
        understanding: data.declarations?.understanding || false,
        questions: data.declarations?.questions || false,
        results: data.declarations?.results || false,
        authorization: data.declarations?.authorization || false,
        revocation: data.declarations?.revocation || false,
        alternatives: data.declarations?.alternatives || false,
        // Authorizations
        image_use: data.authorizations?.image_use || false,
        photo_video: data.authorizations?.photo_video || false
      });
      if (data.signing_status === 'signed') {
        setSignatureData(data.signatures?.patient_sig_data || null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeclarationChange = (key: string) => {
    setDeclarations((prev: any) => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const clearSignature = () => {
    sigCanvas.current?.clear();
  };

  const saveSignature = () => {
    if (sigCanvas.current?.isEmpty()) {
      alert('Por favor firme antes de guardar');
      return;
    }
    const dataUrl = sigCanvas.current?.getTrimmedCanvas().toDataURL('image/png');
    setSignatureData(dataUrl || null);
    setIsSigning(false);
  };

  const handleSubmit = async () => {
    if (!signatureData) {
      alert('La firma es obligatoria');
      return;
    }

    // Validate required declarations
    const required = ['understanding', 'authorization'];
    const missing = required.filter(k => !declarations[k]);
    if (missing.length > 0) {
      alert('Por favor acepte todas las declaraciones obligatorias');
      return;
    }

    // Separate declarations and authorizations
    const finalDeclarations = {
      understanding: declarations.understanding,
      questions: declarations.questions,
      results: declarations.results,
      authorization: declarations.authorization,
      revocation: declarations.revocation,
      alternatives: declarations.alternatives
    };

    const finalAuthorizations = {
      image_use: declarations.image_use,
      photo_video: declarations.photo_video
    };

    try {
      setLoading(true);
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submitSignature',
          token,
          signature: signatureData,
          declarations: finalDeclarations,
          authorizations: finalAuthorizations
        })
      });

      if (res.ok) {
        alert('Documento firmado correctamente');
        window.close(); // Try to close, or show success message
        setSession(prev => prev ? { ...prev, signing_status: 'signed' } : null);
      } else {
        throw new Error('Error al guardar la firma');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#deb887]"></div></div>;
  if (error) return <div className="flex items-center justify-center min-h-screen text-red-500">{error}</div>;
  if (!session) return null;

  if (session.signing_status === 'signed') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
        <CheckCircle className="w-16 h-16 text-green-500 mb-4" />
        <h1 className="text-2xl font-bold text-gray-800">Documento Firmado</h1>
        <p className="text-gray-600 mt-2">Gracias, su consentimiento ha sido registrado.</p>
      </div>
    );
  }

  const renderList = (items: any) => {
    if (!items) return null;
    if (Array.isArray(items)) return <ul className="list-disc pl-5 space-y-1">{items.map((i: string, idx: number) => <li key={idx}>{i}</li>)}</ul>;
    return <p>{JSON.stringify(items)}</p>;
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <header className="bg-white shadow-sm p-4 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <img src="/images/logo/logo.png" alt="BioSkin Logo" className="h-12 w-auto object-contain" />
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-gray-800 truncate">Consentimiento Informado</h1>
            <p className="text-sm text-[#deb887] truncate">{session.procedure_type}</p>
          </div>
        </div>
      </header>

      <main className="p-4 max-w-3xl mx-auto space-y-6">
        {/* Patient Info */}
        <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 text-sm">
          <h3 className="font-bold text-gray-900 mb-3 border-b pb-2">INFORMACIÓN DEL PACIENTE</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <p><strong className="text-gray-600">Nombre:</strong> {session.patient?.first_name} {session.patient?.last_name}</p>
            <p><strong className="text-gray-600">Identificación:</strong> {session.patient?.rut || 'N/A'}</p>
            <p><strong className="text-gray-600">Edad:</strong> {session.patient?.birth_date ? calculateAge(session.patient.birth_date) : 'N/A'} años</p>
            <p><strong className="text-gray-600">Teléfono:</strong> {session.patient?.phone || 'N/A'}</p>
          </div>
        </section>

        <section className="bg-white p-4 rounded-lg shadow-sm space-y-4">
          <h2 className="font-semibold text-gray-700 border-b pb-2">Descripción del Procedimiento</h2>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{session.description}</p>
        </section>

        {session.objectives && session.objectives.length > 0 && (
          <section className="bg-white p-4 rounded-lg shadow-sm space-y-4">
            <h2 className="font-semibold text-gray-700 border-b pb-2">Objetivos</h2>
            {renderList(session.objectives)}
          </section>
        )}

        {/* Full Document Content */}
        <section className="bg-white p-4 rounded-lg shadow-sm space-y-6 text-gray-700 text-sm">
          {session.risks && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Riesgos y Complicaciones</h3>
              {renderList(session.risks)}
            </div>
          )}

          {session.benefits && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Beneficios Esperados</h3>
              {renderList(session.benefits)}
            </div>
          )}

          {session.alternatives && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Alternativas</h3>
              {renderList(session.alternatives)}
            </div>
          )}

          {session.pre_care && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Cuidados Previos</h3>
              {renderList(session.pre_care)}
            </div>
          )}

          {session.post_care && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Cuidados Posteriores</h3>
              {renderList(session.post_care)}
            </div>
          )}
          
          {session.contraindications && (
            <div>
              <h3 className="font-bold text-gray-900 mb-2">Contraindicaciones</h3>
              {renderList(session.contraindications)}
            </div>
          )}
        </section>

        <section className="bg-white p-4 rounded-lg shadow-sm space-y-4">
          <h2 className="font-semibold text-gray-700 border-b pb-2">Antecedentes Críticos</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p><strong>Alergias:</strong> {session.critical_antecedents?.allergies || 'Niega'}</p>
              <p><strong>Medicación:</strong> {session.critical_antecedents?.medications || 'Niega'}</p>
            </div>
            <div>
              <p><strong>Embarazo/Lactancia:</strong> {session.critical_antecedents?.pregnancy ? 'Sí' : 'No'}</p>
              <p><strong>Herpes Recurrente:</strong> {session.critical_antecedents?.herpes ? 'Sí' : 'No'}</p>
            </div>
          </div>
        </section>

        <section className="bg-white p-4 rounded-lg shadow-sm space-y-4">
          <h2 className="font-semibold text-gray-700 border-b pb-2">Declaraciones y Autorizaciones</h2>
          <div className="space-y-3">
            {[
              { key: 'understanding', label: 'Declaro haber recibido información clara y completa del tratamiento.' },
              { key: 'questions', label: 'He tenido oportunidad de resolver todas mis dudas.' },
              { key: 'results', label: 'Entiendo que los resultados pueden variar y no se garantizan resultados específicos.' },
              { key: 'authorization', label: 'Autorizo voluntariamente la realización del tratamiento.' },
              { key: 'revocation', label: 'Sé que puedo revocar este consentimiento en cualquier momento antes del procedimiento.' },
              { key: 'alternatives', label: 'Me han explicado las alternativas de tratamiento, incluyendo la opción de no tratarme.' }
            ].map((item) => (
              <label key={item.key} className="flex items-start gap-3 p-2 rounded hover:bg-gray-50">
                <input 
                  type="checkbox" 
                  checked={declarations[item.key]}
                  onChange={() => handleDeclarationChange(item.key)}
                  className="mt-1 w-5 h-5 text-[#deb887] rounded focus:ring-[#deb887]"
                />
                <span className="text-sm text-gray-700">{item.label}</span>
              </label>
            ))}

            <div className="border-t pt-3 mt-3">
              <label className="flex items-start gap-3 p-2 rounded hover:bg-gray-50">
                <input 
                  type="checkbox" 
                  checked={declarations.image_use}
                  onChange={() => handleDeclarationChange('image_use')}
                  className="mt-1 w-5 h-5 text-[#deb887] rounded focus:ring-[#deb887]"
                />
                <span className="text-sm text-gray-700">
                  Autorizo el uso de mis imágenes con fines educativos y/o promocionales.
                </span>
              </label>
              <label className="flex items-start gap-3 p-2 rounded hover:bg-gray-50">
                <input 
                  type="checkbox" 
                  checked={declarations.photo_video}
                  onChange={() => handleDeclarationChange('photo_video')}
                  className="mt-1 w-5 h-5 text-[#deb887] rounded focus:ring-[#deb887]"
                />
                <span className="text-sm text-gray-700">
                  Autorizo la toma de fotografías y/o videos del procedimiento para registro clínico.
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="bg-white p-4 rounded-lg shadow-sm space-y-4">
          <h2 className="font-semibold text-gray-700 border-b pb-2">Firma del Paciente</h2>
          
          {signatureData ? (
            <div className="border rounded p-4 flex flex-col items-center gap-2">
              <img src={signatureData} alt="Firma" className="max-h-32" />
              <button 
                onClick={() => setIsSigning(true)}
                className="text-sm text-[#deb887] underline"
              >
                Volver a firmar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsSigning(true)}
              className="w-full py-4 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-2 text-gray-500 hover:border-[#deb887] hover:text-[#deb887] transition-colors"
            >
              <PenTool className="w-8 h-8" />
              <span>Tocar para firmar</span>
            </button>
          )}
        </section>

        <button
          onClick={handleSubmit}
          disabled={!signatureData}
          className="w-full py-4 bg-[#deb887] text-white rounded-lg font-bold shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          CONFIRMAR Y ENVIAR
        </button>
      </main>

      {/* Signature Modal */}
      {isSigning && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center justify-between p-4 border-b bg-gray-50">
            <h3 className="font-bold text-gray-700">Firme aquí</h3>
            <button onClick={() => setIsSigning(false)} className="p-2">
              <X className="w-6 h-6 text-gray-500" />
            </button>
          </div>
          
          <div className="flex-1 bg-white relative touch-none">
            <SignatureCanvas 
              ref={sigCanvas}
              canvasProps={{
                className: 'absolute inset-0 w-full h-full',
                style: { width: '100%', height: '100%' }
              }}
              backgroundColor="white"
            />
            <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none">
              <p className="text-gray-300 text-sm">Dibuje su firma en la pantalla</p>
            </div>
          </div>

          <div className="p-4 border-t bg-gray-50 flex gap-4">
            <button 
              onClick={clearSignature}
              className="flex-1 py-3 px-4 border border-gray-300 rounded-lg flex items-center justify-center gap-2 text-gray-700 font-medium"
            >
              <Eraser className="w-5 h-5" />
              Borrar
            </button>
            <button 
              onClick={saveSignature}
              className="flex-1 py-3 px-4 bg-[#deb887] text-white rounded-lg flex items-center justify-center gap-2 font-bold shadow-sm"
            >
              <Save className="w-5 h-5" />
              Registrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
