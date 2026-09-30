import React from 'react';

interface Props {
  children?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Un deploy renombra los chunks: una pestaña abierta con el HTML anterior falla al cargar un tab lazy. */
const isStaleChunkError = (error: Error) =>
  /dynamically imported module|Importing a module script failed|Failed to fetch.*\.js/i.test(error?.message || '');

const RELOAD_GUARD = 'bioskin:chunkReloadAt';

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('ErrorBoundary caught an error:', error, info);
    if (!isStaleChunkError(error)) return;
    // Recargar solo una vez por minuto: si el chunk falta de verdad, evita un bucle de recargas.
    const last = Number(sessionStorage.getItem(RELOAD_GUARD) || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOAD_GUARD, String(Date.now()));
    window.location.reload();
  }

  render() {
    if (this.state.hasError) {
      const stale = isStaleChunkError(this.state.error as Error);
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2 style={{ color: stale ? '#92400e' : 'red' }}>
            {stale ? 'Se publicó una actualización de la aplicación.' : 'Ha ocurrido un error en esta sección.'}
          </h2>
          <p style={{ color: stale ? '#6b7280' : 'red' }}>
            {stale ? 'Recarga la página para continuar. No se perdió ninguna información.' : this.state.error?.message}
          </p>
          {stale && (
            <button
              onClick={() => window.location.reload()}
              style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: 'none', background: '#deb887', color: '#fff', cursor: 'pointer' }}
            >
              Recargar
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
