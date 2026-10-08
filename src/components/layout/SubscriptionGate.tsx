import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { subscriptionRoute } from '../../utils/subscriptionAccess';
import AnnualPhotoBackupPanel from '../admin/AnnualPhotoBackupPanel';
import AdminLayout from './AdminLayout';
import SubscriptionBanner from './SubscriptionBanner';
import LegalAcceptanceGate from './LegalAcceptanceGate';

const PUBLIC_ACCESS = new Set(['/admin/login', '/admin/sys', '/admin/register', '/admin/invite',
  '/admin/setup-password', '/admin/recover', '/skin-explorer', '/']);

export default function SubscriptionGate({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isAuthVerified } = useAuth();
  const { pathname } = useLocation();
  if (PUBLIC_ACCESS.has(pathname)) return children;
  if (!isAuthVerified) return <div role="status" className="flex min-h-screen items-center justify-center p-6 text-slate-700">Verificando acceso a la clínica…</div>;
  if (!isAuthenticated || !user) return <Navigate to="/admin/login" replace />;
  const route = subscriptionRoute(user, pathname);
  const backupPath = user.clinic_slug ? `/admin/${user.clinic_slug}/${user.username}/backup` : '/admin/backup';
  if (route === 'normal' || route === 'backup') return <>
    <SubscriptionBanner />
    {route === 'normal' && <LegalAcceptanceGate />}
    {children}
  </>;
  if (route === 'redirect') return <Navigate to={backupPath} replace />;
  return <><SubscriptionBanner /><AdminLayout title={route === 'delivery' ? 'Entrega anual pendiente' : 'Acceso a respaldos'} showBack={false}>
    <main className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      {route === 'delivery' ? <AnnualPhotoBackupPanel deliveryOnly /> : route === 'dashboard' ? <>
        <h1 className="text-xl font-semibold text-slate-900">Recuperación de datos</h1>
        <p className="text-sm text-slate-700">Solo está disponible Base de Datos para descargar y exportar respaldos existentes. Los módulos contratados se conservan para una renovación antes de la purga.</p>
        <Link to={backupPath} className="inline-flex rounded-xl bg-blue-700 px-5 py-3 font-medium text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">Base de Datos</Link>
      </> : <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">El acceso operativo está bloqueado. Solo el administrador de la clínica puede recuperar respaldos durante el plazo habilitado. Contacta al proveedor.</p>}
    </main>
  </AdminLayout></>;
}
