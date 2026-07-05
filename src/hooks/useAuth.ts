/**
 * @file src/hooks/useAuth.ts
 * @description Re-exporta el hook useAuth desde AuthContext para compatibilidad
 * con imports que usen esta ruta en vez de importar directamente del contexto.
 *
 * Uso recomendado:
 *   import { useAuth } from '../context/AuthContext';
 * o:
 *   import { useAuth } from '../hooks/useAuth';
 */
export { useAuth } from '../context/AuthContext';
