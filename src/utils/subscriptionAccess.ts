import type { AuthUser, Clinic, SubscriptionLifecycle } from '../types';

/** No muta las features contratadas: una renovación recupera la configuración original. */
export function subscriptionAccess(user: AuthUser | null) {
  const master = user?.role === 'master_admin';
  const admin = master || user?.role === 'clinic_admin';
  const lifecycle = user?.subscription_lifecycle;
  const deliveryOnly = !master && user?.delivery_only === true;
  const canOperate = !!user && (master || (!deliveryOnly && (!lifecycle ||
    (['ACTIVE', 'GRACE'].includes(lifecycle.state) && lifecycle.canoperate === true))));
  const recovery = !deliveryOnly && lifecycle?.state === 'RECOVERY';
  const canExport = !!admin && !deliveryOnly && (master ||
    (canOperate && lifecycle?.canexport !== false) || (recovery && lifecycle?.canexport === true));
  return {
    canOperate, deliveryOnly,
    canAccessBackup: !!admin && (canOperate || canExport || deliveryOnly),
    canExport,
    canAnnualDelivery: !!admin && (canOperate || recovery || deliveryOnly),
    canRequestAnnual: !!admin && !deliveryOnly && (canOperate || recovery),
    canImport: !!admin && canOperate && (master || lifecycle?.canimport !== false),
    canRestore: !!admin && canOperate && (master || lifecycle?.canrestore !== false),
    canManualSnapshot: !!admin && canOperate && (master || lifecycle?.can_manual_snapshot !== false),
    canAutoBackup: canOperate && (master || lifecycle?.can_auto_backup !== false),
  };
}

/** Top-level auth envelope takes precedence; old servers remain compatible. */
export function sessionUser(data: {
  user: AuthUser;
  subscription_lifecycle?: SubscriptionLifecycle | null;
  delivery_only?: boolean;
  subscriptionWarningDays?: number | null;
}): AuthUser {
  return {
    ...data.user,
    subscription_lifecycle: data.subscription_lifecycle !== undefined ? data.subscription_lifecycle : data.user.subscription_lifecycle,
    delivery_only: data.delivery_only ?? data.user.delivery_only ?? false,
    subscriptionWarningDays: data.subscriptionWarningDays ?? data.user.subscriptionWarningDays,
  };
}

export function subscriptionDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin fecha confirmada';
  return new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

export function subscriptionMessage(lifecycle: SubscriptionLifecycle): string {
  const days = lifecycle.remainingdays == null ? 'Sin plazo confirmado' : `${Math.max(0, lifecycle.remainingdays)} días restantes`;
  if (lifecycle.state === 'GRACE')
    return `Período de gracia: ${days}, hasta ${subscriptionDate(lifecycle.grace_ends_at)} (Ecuador). Acceso normal durante 15 días de gracia; al finalizar, solo el administrador podrá recuperar respaldos durante 30 días.`;
  if (lifecycle.state === 'RECOVERY')
    return `Solo recuperación de respaldos: ${days}, hasta ${subscriptionDate(lifecycle.recovery_ends_at)} (Ecuador), 45 días después del vencimiento. No se permite importar, restaurar ni crear copias manuales. Renueva antes de la purga para recuperar tus módulos configurados.`;
  if (lifecycle.state === 'CLOSED')
    return 'Acceso cerrado. Contacta al proveedor para revisar la suscripción. Una entrega anual pendiente solo permite consultar su estado y descargarla.';
  return `Suscripción activa: ${days}. Vencimiento: ${subscriptionDate(lifecycle.expires_at)} (Ecuador).`;
}

/** Gate único para rutas anidadas y URLs legacy; no se monta el módulo denegado. */
export function subscriptionRoute(user: AuthUser | null, pathname: string) {
  const access = subscriptionAccess(user);
  if (access.canOperate) return 'normal';
  if (!access.canAccessBackup) return 'blocked';
  if (access.deliveryOnly) return 'delivery';
  const base = user?.clinic_slug ? `/admin/${user.clinic_slug}/${user.username}` : '/admin';
  if (pathname === `${base}/backup` || pathname === '/admin/backup') return 'backup';
  if (pathname === base || pathname === '/admin' || pathname === '/admin/dashboard') return 'dashboard';
  return 'redirect';
}

export function clinicSubscriptionStatus(clinic: Pick<Clinic, 'subscription_lifecycle' | 'subscription_expires_at'>, now = Date.now()) {
  const lifecycle = clinic.subscription_lifecycle;
  if (lifecycle) return {
    state: lifecycle.state, remainingdays: lifecycle.remainingdays,
    message: subscriptionMessage(lifecycle),
    baseline: lifecycle.enrollment_status === 'ENROLLED' ? 'Política aceptada 15 + 30 días'
      : lifecycle.enrollment_status === 'SCHEDULED' ? `Política programada desde ${subscriptionDate(lifecycle.effective_at)}`
        : 'Condiciones anteriores / revisión contractual; sin inscripción automática',
  };
  // Compatibilidad con respuestas anteriores: no atribuirles la nueva política.
  const end = clinic.subscription_expires_at ? Date.parse(clinic.subscription_expires_at) : NaN;
  const days = Number.isFinite(end) ? Math.ceil((end - now) / 86400000) : null;
  const grace = days !== null && days <= 0 && now < end + 21 * 86400000;
  return {
    state: days === null || days > 0 ? 'ACTIVE' : grace ? 'GRACE' : 'CLOSED',
    remainingdays: grace ? Math.max(0, Math.ceil((end + 21 * 86400000 - now) / 86400000)) : days === null ? null : Math.max(0, days),
    baseline: 'Referencia legacy sin ciclo confirmado: condiciones anteriores de 21 días, no política 15 + 30',
    message: days === null ? 'Sin vencimiento confirmado'
      : days > 0 ? `Vence ${subscriptionDate(clinic.subscription_expires_at)} · ${days} días restantes`
        : grace ? 'Gracia bajo condiciones anteriores; confirmar con el servidor'
          : 'Plazo anterior agotado; requiere revisión',
  };
}
