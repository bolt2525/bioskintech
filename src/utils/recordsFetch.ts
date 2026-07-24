/**
 * Wrapper de fetch que incluye el token de sesión automáticamente.
 * Usa sessionStorage (tab-aislado) para evitar colisión entre pestañas.
 */

/** ID de clínica objetivo cuando master_admin está viendo una clínica. */
let _masterTargetClinicId: number | null = null;

export function setMasterTargetClinicId(id: number | null) {
  _masterTargetClinicId = id;
}

const recordsFetch = (url: string, opts?: RequestInit): Promise<Response> => {
  const extraHeaders: Record<string, string> = {};
  if (_masterTargetClinicId !== null) {
    extraHeaders['X-Target-Clinic-Id'] = String(_masterTargetClinicId);
  }
  return fetch(url, {
    ...opts,
    headers: {
      ...opts?.headers,
      Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}`,
      ...extraHeaders,
    },
  });
};

export default recordsFetch;
