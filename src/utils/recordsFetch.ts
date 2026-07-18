/**
 * Wrapper de fetch para /api/records que incluye automáticamente el token de sesión.
 * Reemplaza todos los fetch('/api/records') en componentes de fichas clínicas.
 */
const recordsFetch = (url: string, opts?: RequestInit): Promise<Response> =>
  fetch(url, {
    ...opts,
    headers: {
      ...opts?.headers,
      Authorization: `Bearer ${localStorage.getItem('adminSessionToken') || ''}`,
    },
  });

export default recordsFetch;
