import { useEffect, useRef, useState } from 'react';

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    theme: 'light' | 'dark' | 'auto';
    action: string;
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
  }) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

type Props = {
  siteKey: string;
  action: string;
  theme?: 'light' | 'dark' | 'auto';
  resetKey: number;
  onToken: (token: string) => void;
  onError?: () => void;
};

const getTurnstile = () => (window as Window & { turnstile?: TurnstileApi }).turnstile;

export default function TurnstileWidget({
  siteKey,
  action,
  theme = 'auto',
  resetKey,
  onToken,
  onError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string>();
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  const [scriptReady, setScriptReady] = useState(Boolean(getTurnstile()));
  const [scriptError, setScriptError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!siteKey || getTurnstile()) {
      setScriptReady(Boolean(getTurnstile()));
      return;
    }

    const id = 'cf-turnstile-script';
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    const handleLoad = () => {
      setScriptError(false);
      setScriptReady(true);
    };
    const handleError = () => {
      setScriptError(true);
      onErrorRef.current?.();
    };
    if (existing) {
      existing.addEventListener('load', handleLoad);
      existing.addEventListener('error', handleError);
      return () => {
        existing.removeEventListener('load', handleLoad);
        existing.removeEventListener('error', handleError);
      };
    }

    const script = document.createElement('script');
    script.id = id;
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
    document.head.appendChild(script);
    return () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
  }, [loadAttempt, siteKey]);

  useEffect(() => {
    const turnstile = getTurnstile();
    if (!siteKey || !scriptReady || !turnstile || !containerRef.current || widgetIdRef.current) return;

    widgetIdRef.current = turnstile.render(containerRef.current, {
      sitekey: siteKey,
      theme,
      action,
      callback: token => onTokenRef.current(token),
      'expired-callback': () => onTokenRef.current(''),
      'error-callback': () => {
        onTokenRef.current('');
        onErrorRef.current?.();
        window.setTimeout(() => {
          if (widgetIdRef.current) getTurnstile()?.reset(widgetIdRef.current);
        }, 1000);
      },
    });

    return () => {
      if (widgetIdRef.current && getTurnstile()) getTurnstile()?.remove(widgetIdRef.current);
      widgetIdRef.current = undefined;
    };
  }, [action, scriptReady, siteKey, theme]);

  useEffect(() => {
    if (widgetIdRef.current) getTurnstile()?.reset(widgetIdRef.current);
  }, [resetKey]);

  if (!siteKey) return null;
  if (scriptError) {
    return (
      <div className="flex min-h-[65px] items-center justify-center">
        <button
          type="button"
          className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
          onClick={() => {
            document.getElementById('cf-turnstile-script')?.remove();
            setScriptError(false);
            setScriptReady(false);
            setLoadAttempt(attempt => attempt + 1);
          }}
        >
          Reintentar verificación
        </button>
      </div>
    );
  }
  return <div ref={containerRef} className="flex min-h-[65px] justify-center" aria-label="Verificación anti-bot" />;
}
