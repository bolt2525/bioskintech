type ConsentBoolean = boolean | null | undefined;

export interface ConsentDocumentData {
  objectives?: unknown;
  risks?: unknown;
  benefits?: unknown;
  alternatives?: unknown;
  pre_care?: unknown;
  post_care?: unknown;
  contraindications?: unknown;
  critical_antecedents?: {
    allergies?: string;
    medications?: string;
    pregnancy?: ConsentBoolean;
    herpes?: ConsentBoolean;
    others?: unknown;
  } | null;
  declarations?: Partial<Record<'understanding' | 'questions' | 'results' | 'authorization' | 'revocation' | 'alternatives', ConsentBoolean>>;
  authorizations?: Partial<Record<'privacy_policy' | 'image_use' | 'photo_video', ConsentBoolean>>;
}

const sectionDefinitions: [keyof ConsentDocumentData, string][] = [
  ['objectives', 'Objetivos'],
  ['risks', 'Riesgos y complicaciones'],
  ['benefits', 'Beneficios esperados'],
  ['alternatives', 'Alternativas'],
  ['pre_care', 'Cuidados previos'],
  ['post_care', 'Cuidados posteriores'],
  ['contraindications', 'Contraindicaciones'],
];

const consentStatements: [keyof NonNullable<ConsentDocumentData['declarations']>, string][] = [
  ['understanding', 'Recibió información clara y completa del tratamiento'],
  ['questions', 'Tuvo oportunidad de hacer preguntas y resolver sus dudas'],
  ['results', 'Comprende que los resultados pueden variar'],
  ['authorization', 'Autoriza voluntariamente la realización del tratamiento'],
  ['revocation', 'Conoce su derecho a revocar este consentimiento antes del procedimiento'],
  ['alternatives', 'Conoce las alternativas, incluida la opción de no realizar el tratamiento'],
];

const authorizationStatements: [keyof NonNullable<ConsentDocumentData['authorizations']>, string][] = [
  ['privacy_policy', 'Acepta el uso y almacenamiento de sus datos según la Política de Privacidad'],
  ['image_use', 'Autoriza el uso de imágenes con fines educativos o promocionales'],
  ['photo_video', 'Autoriza fotografías o videos para el registro clínico'],
];

function displayChoice(value: ConsentBoolean) {
  if (value === true) return 'Sí';
  if (value === false) return 'No';
  return 'No especificado';
}

function displayLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) =>
      `${key.replace(/_/g, ' ')}: ${typeof item === 'boolean' ? displayChoice(item) : Array.isArray(item) ? item.join(', ') : String(item ?? '')}`
    ).filter(line => !line.endsWith(': '));
  }
  return value == null ? [] : [String(value)];
}

function ChoiceList<Key extends string>({
  title,
  statements,
  values,
}: {
  title: string;
  statements: readonly (readonly [Key, string])[];
  values?: Partial<Record<Key, ConsentBoolean>>;
}) {
  return (
    <section className="mt-5 border-t border-gray-200 pt-4">
      <h2 className="font-bold text-gray-900">{title}</h2>
      <div className="mt-2 space-y-2">
        {statements.map(([key, label]) => (
          <p key={key} className="flex items-start justify-between gap-4 text-sm text-gray-700">
            <span>{label}</span>
            <strong className="shrink-0">{displayChoice(values?.[key])}</strong>
          </p>
        ))}
      </div>
    </section>
  );
}

export default function ConsentDocumentSections({
  consent,
  showAcceptanceState = true,
}: {
  consent: ConsentDocumentData;
  showAcceptanceState?: boolean;
}) {
  const antecedentes = consent.critical_antecedents;
  const otrosAntecedentes = displayLines(antecedentes?.others);

  return (
    <div className="text-sm text-gray-800 space-y-4">
      {sectionDefinitions.map(([key, title]) => {
        const lines = displayLines(consent[key]);
        if (!lines.length) return null;
        return (
          <section key={key} className="border-b border-gray-100 pb-3">
            <h2 className="font-bold text-gray-900">{title}</h2>
            {lines.length === 1 ? <p className="mt-1 whitespace-pre-wrap">{lines[0]}</p> : (
              <ul className="mt-1 list-disc pl-5 space-y-1">
                {lines.map((line, index) => <li key={`${key}-${index}`}>{line}</li>)}
              </ul>
            )}
          </section>
        );
      })}

      {antecedentes && (
        <section className="border-b border-gray-100 pb-3">
          <h2 className="font-bold text-gray-900">Antecedentes críticos</h2>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
            <p><strong>Alergias:</strong> {antecedentes.allergies?.trim() || 'Niega'}</p>
            <p><strong>Medicación:</strong> {antecedentes.medications?.trim() || 'Niega'}</p>
            <p><strong>Embarazo/lactancia:</strong> {displayChoice(antecedentes.pregnancy)}</p>
            <p><strong>Herpes recurrente:</strong> {displayChoice(antecedentes.herpes)}</p>
            {otrosAntecedentes.length > 0 && <p className="sm:col-span-2"><strong>Otros:</strong> {otrosAntecedentes.join(', ')}</p>}
          </div>
        </section>
      )}

      {showAcceptanceState && consent.declarations && (
        <ChoiceList title="Declaraciones del paciente" statements={consentStatements} values={consent.declarations} />
      )}
      {showAcceptanceState && consent.authorizations && (
        <ChoiceList title="Autorizaciones" statements={authorizationStatements} values={consent.authorizations} />
      )}
    </div>
  );
}