import React, { useState, useEffect, useRef } from 'react';
import recordsFetch from "../utils/recordsFetch";
import { useParams } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import { normalizeSignature, SIGNATURE_PEN } from '../utils/signatureImage';
import { CheckCircle, PenTool, Eraser, Save, X, Printer } from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';
import ConsentDocumentSections from '../components/admin/ficha-clinica/components/ConsentDocumentSections';

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
  signing_snapshot_hash?: string;
  signing_hash?: string;
  signing_signed_at?: string;
  professional?: {
    name?: string | null;
    signature_data?: string | null;
  };
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
    privacy_policy?: boolean;
  };
  patient?: {
    first_name: string;
    last_name: string;
    identification_type: 'cedula' | 'ruc' | null;
    identification_number: string;
    birth_date: string;
  };
}

export default function ConsentSigning() {
  const { token } = useParams();
  const [session, setSession] = useState<ConsentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [emailHint, setEmailHint] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [copyEmailed, setCopyEmailed] = useState(false);
  const [copySenderEmail, setCopySenderEmail] = useState('');
  const [signedAt, setSignedAt] = useState('');
  const [signingHash, setSigningHash] = useState('');
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
      const res = await recordsFetch(`/api/records?action=getSigningSession&token=${token}`);
      if (!res.ok) throw new Error('Sesión no encontrada o expirada');
      const data = await res.json();
      if (data.requiresVerification) {
        setSession(null);
        setEmailHint(data.emailHint || '');
        setVerificationRequired(true);
        return;
      }
      setVerificationRequired(false);
      setSession(data);
      const isPending = data.signing_status !== 'signed';
      setDeclarations({
        understanding: isPending ? false : (data.declarations?.understanding || false),
        questions: isPending ? false : (data.declarations?.questions || false),
        results: isPending ? false : (data.declarations?.results || false),
        authorization: isPending ? false : (data.declarations?.authorization || false),
        revocation: isPending ? false : (data.declarations?.revocation || false),
        alternatives: isPending ? false : (data.declarations?.alternatives || false),
        image_use: isPending ? false : (data.authorizations?.image_use || false),
        photo_video: isPending ? false : (data.authorizations?.photo_video || false),
        privacy_policy: isPending ? false : (data.authorizations?.privacy_policy || false),
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

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verifySigningCode', token, code: verificationCode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudo verificar el código.');
      }
      setVerificationCode('');
      await fetchSession();
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
    const dataUrl = sigCanvas.current ? normalizeSignature(sigCanvas.current.getCanvas()) : null;
    setSignatureData(dataUrl || null);
    setIsSigning(false);
  };

  const handleSubmit = async () => {
    if (!signatureData) {
      alert('La firma es obligatoria');
      return;
    }

    // Validate required declarations
    const required = ['understanding', 'authorization', 'privacy_policy'];
    const missing = required.filter(k => !declarations[k]);
    if (missing.length > 0) {
      const msgs: Record<string, string> = {
        understanding: 'haber recibido información sobre el tratamiento',
        authorization: 'autorizar el tratamiento',
        privacy_policy: 'aceptar la Política de Privacidad',
      };
      alert(`Por favor acepte: ${missing.map(k => msgs[k] || k).join(', ')}`);
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
      photo_video: declarations.photo_video,
      privacy_policy: declarations.privacy_policy,
    };

    try {
      setLoading(true);
      const res = await recordsFetch('/api/records', {
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
        const result = await res.json();
        setCopyEmailed(result.copyEmailed === true);
        setCopySenderEmail(result.copySenderEmail || '');
        setSignedAt(result.signedAt || new Date().toISOString());
        setSigningHash(result.signingHash || '');
        setSession(prev => prev ? {
          ...prev,
          signing_status: 'signed',
          declarations: finalDeclarations,
          authorizations: finalAuthorizations,
          signing_signed_at: result.signedAt || new Date().toISOString(),
          signing_hash: result.signingHash || '',
          signatures: { ...prev.signatures, patient_sig_data: signatureData, patient_signed_at: result.signedAt || new Date().toISOString() },
        } : null);
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
  if (error && !verificationRequired) return <div className="flex items-center justify-center min-h-screen text-red-500">{error}</div>;
  if (verificationRequired) return (
    <div className="min-h-screen bg-gray-50 p-4 flex items-center justify-center">
      <form onSubmit={verifyCode} className="w-full max-w-md bg-white p-6 rounded-lg shadow-sm space-y-4">
        <h1 className="text-xl font-bold text-gray-900">Verifica tu correo</h1>
        <p className="text-sm text-gray-600">Enviamos un código a {emailHint}. Ingresa el código para consultar y firmar el consentimiento.</p>
        <label className="block text-sm font-medium text-gray-700" htmlFor="verification-code">Código de 6 dígitos</label>
        <input id="verification-code" name="verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={verificationCode} onChange={event => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="w-full p-3 border border-gray-300 rounded-md text-center text-2xl tracking-[0.25em]" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={verificationCode.length !== 6} className="w-full py-3 bg-[#deb887] text-white rounded-md font-semibold disabled:opacity-50">Verificar y continuar</button>
        <p className="text-xs text-gray-500">El código vence junto con el enlace. Si no lo solicitaste o venció, contacta a la clínica para generar otro enlace.</p>
      </form>
    </div>
  );
  if (!session) return null;

  if (session.signing_status === 'signed') {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="print:hidden flex min-h-[60vh] flex-col items-center justify-center">
          <CheckCircle className="w-16 h-16 text-green-500 mb-4" />
          <h1 className="text-2xl font-bold text-gray-800">Documento Firmado</h1>
          <p className="text-gray-600 mt-2">{copyEmailed ? `Enviamos una copia a ${emailHint}${copySenderEmail ? ` desde ${copySenderEmail}` : ''}.` : 'No pudimos enviar el correo. Puedes imprimir o guardar una copia desde aquí.'}</p>
          <button type="button" onClick={() => window.print()} className="mt-5 px-4 py-2 bg-[#deb887] text-white rounded-md font-semibold inline-flex items-center gap-2">
            <Printer className="w-4 h-4" /> Imprimir o guardar copia
          </button>
        </div>
        <article className="hidden print:block max-w-3xl mx-auto bg-white p-8 text-gray-900">
          <h1 className="text-2xl font-bold">Consentimiento informado firmado</h1>
          <p className="mt-4"><strong>Paciente:</strong> {session.patient?.first_name} {session.patient?.last_name}</p>
          <p><strong>{session.patient?.identification_type === 'ruc' ? 'RUC' : session.patient?.identification_type === 'cedula' ? 'Cédula' : 'Identificación'}:</strong> {session.patient?.identification_number || 'N/A'}</p>
          <p><strong>Procedimiento:</strong> {session.procedure_type}</p>
          <p className="mt-4"><strong>Descripción:</strong><br />{session.description}</p>
          <ConsentDocumentSections consent={session} />
          {session.professional?.name && (
            <section className="mt-5">
              <strong>Profesional responsable:</strong> {session.professional.name}
              {session.professional.signature_data && <div><img src={session.professional.signature_data} alt="Firma del profesional" className="max-h-24 mt-2" /></div>}
            </section>
          )}
          {signatureData && <section className="mt-5"><strong>Firma del paciente</strong><br /><img src={signatureData} alt="Firma del paciente" className="max-h-32 mt-2" /></section>}
          <p className="mt-5 text-sm">Firmado: {signedAt || session.signing_signed_at || new Date().toISOString()}</p>
          {(signingHash || session.signing_hash) && <p className="mt-2 text-xs break-all">Huella SHA-256: {signingHash || session.signing_hash}</p>}
        </article>
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
          <BrandLogo className="h-12 w-auto object-contain" compact />
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
            <p><strong className="text-gray-600">{session.patient?.identification_type === 'ruc' ? 'RUC' : session.patient?.identification_type === 'cedula' ? 'Cédula' : 'Identificación'}:</strong> {session.patient?.identification_number || 'N/A'}</p>
            <p><strong className="text-gray-600">Edad:</strong> {session.patient?.birth_date ? calculateAge(session.patient.birth_date) : 'N/A'} años</p>
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

        {session.professional?.name && (
          <section className="bg-white p-4 rounded-lg shadow-sm space-y-2">
            <h2 className="font-semibold text-gray-700 border-b pb-2">Profesional responsable</h2>
            <p className="text-sm text-gray-700">{session.professional.name}</p>
            {session.professional.signature_data && <img src={session.professional.signature_data} alt="Firma del profesional" className="max-h-24" />}
          </section>
        )}

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

            {/* Aceptación obligatoria de Política de Privacidad */}
            <label className="flex items-start gap-3 p-2 rounded hover:bg-gray-50 border border-[#deb887]/20 bg-[#fdf8f0]">
              <input
                type="checkbox"
                checked={declarations.privacy_policy}
                onChange={() => handleDeclarationChange('privacy_policy')}
                className="mt-1 w-5 h-5 text-[#deb887] rounded focus:ring-[#deb887]"
              />
              <span className="text-sm text-gray-700">
                Autorizo el uso y almacenamiento de mis datos personales, historial clínico y fotografías en la plataforma bajo los términos descritos en la{' '}
                <a
                  href="/politica-de-privacidad"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#deb887] hover:text-[#c9a96e] font-medium hover:underline"
                >
                  Política de Privacidad
                </a>
                . <span className="text-red-500 font-medium">(Obligatorio)</span>
              </span>
            </label>

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
              {...SIGNATURE_PEN}
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
