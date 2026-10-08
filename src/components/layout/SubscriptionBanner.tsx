import { useAuth } from '../../hooks/useAuth';
import { subscriptionMessage } from '../../utils/subscriptionAccess';

export default function SubscriptionBanner() {
  const { user } = useAuth();
  if (!user || user.role === 'master_admin' || user.is_demo) return null;
  const lifecycle = user.subscription_lifecycle;
  if (lifecycle) {
    const warning = lifecycle.state !== 'ACTIVE' ||
      (lifecycle.remainingdays !== null && lifecycle.remainingdays <= 21);
    if (!warning) return null;
    return <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      {subscriptionMessage(lifecycle)}
      {user.delivery_only && <strong className="block">Sesión exclusiva de entrega anual: estado y descarga, sin exportación general.</strong>}
    </div>;
  }
  const days = user.subscriptionWarningDays;
  if (typeof days !== 'number' || days > 21) return null;
  return <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
    {days < 0 ? 'Suscripción vencida. Contacta al proveedor para revisar las condiciones anteriores de tu contrato.'
      : `Tu suscripción vence en ${days} días. Contacta al administrador para renovar.`}
  </div>;
}
