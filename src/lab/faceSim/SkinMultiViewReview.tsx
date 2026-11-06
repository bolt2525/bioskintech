import { lazy, Suspense, useState, type ComponentProps } from 'react';
import SkinLearnedReview from './SkinLearnedReview';
const SkinVisualSignalReview = lazy(() => import('./SkinVisualSignalReview'));

export default function SkinMultiViewReview(props: ComponentProps<typeof SkinVisualSignalReview>) {
  const [technical, setTechnical] = useState(false);
  return <div className="min-w-0 space-y-3">
    <SkinLearnedReview sources={props.sources} />
    <details className="rounded-xl border border-white/15 bg-stone-950 p-3 text-stone-200"
      onToggle={event => { if (event.currentTarget.open) setTechnical(true); }}>
      <summary className="admin-focus-ring cursor-pointer text-sm">Explorador técnico RGB · no clasifica lesiones</summary>
      {technical && <Suspense fallback={<p role="status">Preparando explorador técnico…</p>}>
        <SkinVisualSignalReview {...props} />
      </Suspense>}
    </details>
  </div>;
}
