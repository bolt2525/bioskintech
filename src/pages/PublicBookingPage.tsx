import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

type PublicProfile = {
  success: boolean;
  enabled: boolean;
  publicUrl?: string;
  professional?: {
    username: string;
    full_name: string;
    gentilicio?: string;
    clinic_name?: string;
    clinic_slug?: string;
  };
  resources?: Array<{ id: number; name: string }>;
  treatments?: Array<{ name: string; durationMinutes: number }>;
};

export default function PublicBookingPage() {
  const { clinicSlug, username } = useParams<{ clinicSlug: string; username?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [professionals, setProfessionals] = useState<Array<{ id: string; username: string; full_name: string; clinic_name?: string; resourceId: string; resourceType: 'owner' | 'staff'; ownerName?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    service: '',
    date: '',
    time: '09:00',
    durationMinutes: 60,
    resourceId: '',
    turnstileToken: '',
    website: '',
  });

  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      setSuccess(null);
      try {
        if (!clinicSlug) {
          setLoading(false);
          return;
        }

        if (username) {
          const res = await fetch(`/api/admin-auth?action=getPublicBookingProfile&clinicSlug=${encodeURIComponent(clinicSlug)}&username=${encodeURIComponent(username)}`);
          const data = await res.json();
          if (!data?.success) {
            setError(data?.error || 'Este enlace no está disponible en este momento.');
            setProfile(null);
          } else {
            setProfile(data);
            const defaultTreatment = data.treatments?.[0];
            const requestedResource = searchParams.get('resource') || 'owner';
            const validResource = requestedResource === 'owner' || data.resources?.some((resource: { id: number }) => `staff:${resource.id}` === requestedResource);
            setForm((prev) => ({
              ...prev,
              resourceId: validResource ? requestedResource : 'owner',
              service: defaultTreatment?.name || '',
              durationMinutes: defaultTreatment?.durationMinutes || 60,
            }));
          }
        } else {
          const res = await fetch(`/api/admin-auth?action=getPublicBookingProfiles&clinicSlug=${encodeURIComponent(clinicSlug)}`);
          const data = await res.json();
          setProfessionals(data?.professionals || []);
          if (!data?.success || !data.professionals?.length) {
            setError('Esta clínica aún no tiene enlaces públicos activados.');
          }
        }
      } catch {
        setError('No se pudo cargar la información de agendamiento.');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [clinicSlug, username, searchParams]);

  useEffect(() => {
    if (!turnstileSiteKey || !document.getElementById('cf-turnstile-script')) {
      if (turnstileSiteKey) {
        const script = document.createElement('script');
        script.id = 'cf-turnstile-script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => setTurnstileReady(true);
        document.body.appendChild(script);
      }
      return;
    }

    if ((window as any).turnstile) {
      setTurnstileReady(true);
    }
  }, [turnstileSiteKey]);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileReady || !document.getElementById('turnstile-widget')) return;
    if (!(window as any).turnstile) return;

    const existing = document.getElementById('turnstile-widget');
    if (existing && existing.childElementCount === 0) {
      (window as any).turnstile.render('#turnstile-widget', {
        sitekey: turnstileSiteKey,
        theme: 'light',
        callback: (token: string) => setForm((prev) => ({ ...prev, turnstileToken: token })),
        'expired-callback': () => setForm((prev) => ({ ...prev, turnstileToken: '' })),
        'error-callback': () => setForm((prev) => ({ ...prev, turnstileToken: '' })),
      });
    }
  }, [turnstileReady, turnstileSiteKey]);

  const selectedProfessionalName = useMemo(() => {
    if (form.resourceId === 'owner') return profile?.professional?.full_name || '';
    return profile?.resources?.find((resource) => `staff:${resource.id}` === form.resourceId)?.name || profile?.professional?.full_name || '';
  }, [form.resourceId, profile]);

  const submitBooking = async () => {
    if (!clinicSlug || !username || !profile?.professional) return;
    if (!form.name.trim() || !form.email.trim() || !form.service.trim() || !form.date || !form.time) {
      setError('Completa nombre, correo, servicio, fecha y hora.');
      return;
    }
    if (turnstileSiteKey && !form.turnstileToken) {
      setError('Confirma que no eres un robot antes de continuar.');
      return;
    }
    if (form.website) {
      setError('Solicitud rechazada.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/public-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinicSlug,
          username,
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          service: form.service.trim(),
          date: form.date,
          time: form.time,
          durationMinutes: Number(form.durationMinutes || 60),
          resource_id: form.resourceId === 'owner' ? undefined : form.resourceId,
          turnstileToken: form.turnstileToken,
          website: form.website,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || 'No se pudo crear la cita.');
        return;
      }
      setSuccess(`Tu cita quedó agendada correctamente para ${new Date(form.date + 'T' + form.time + ':00-05:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'long' })}.`);
      setForm((prev) => ({ ...prev, name: '', email: '', phone: '', service: '', date: '', time: '09:00', turnstileToken: '', website: '' }));
      if ((window as any).turnstile && document.getElementById('turnstile-widget')) {
        (window as any).turnstile.reset();
      }
    } catch {
      setError('Hubo un problema al agendar. Inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#faf7f2] text-gray-600">Cargando agendamiento…</div>;
  }

  if (!clinicSlug) {
    return <div className="min-h-screen flex items-center justify-center bg-[#faf7f2] text-gray-600">Enlace no válido.</div>;
  }

  if (!username && professionals.length) {
    return (
      <div className="min-h-screen bg-[#faf7f2] px-4 py-12">
        <div className="max-w-3xl mx-auto bg-white rounded-3xl shadow-lg border border-[#f0e2d1] p-8">
          <p className="text-xs uppercase tracking-[0.2em] text-[#a57b4a] font-semibold">Reservas públicas</p>
          <h1 className="mt-2 text-3xl font-bold text-gray-900">Selecciona al profesional</h1>
          <p className="mt-2 text-sm text-gray-600">Elige quién atenderá tu cita dentro de la clínica.</p>
          <div className="mt-6 grid gap-3">
            {professionals.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(`/reservar/${clinicSlug}/${p.username}?resource=${encodeURIComponent(p.resourceId)}`)}
                className="flex items-center justify-between rounded-2xl border border-gray-200 p-4 text-left hover:border-[#deb887] hover:bg-[#fffaf2] transition-colors"
              >
                <div>
                  <p className="font-semibold text-gray-900">{p.full_name}</p>
                  <p className="text-xs text-gray-500">{p.resourceType === 'staff' ? `Equipo de ${p.ownerName}` : p.clinic_name || clinicSlug}</p>
                </div>
                <span className="text-sm font-medium text-[#a57b4a]">Agendar →</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!profile?.professional) {
    return (
      <div className="min-h-screen bg-[#faf7f2] px-4 py-12">
        <div className="max-w-xl mx-auto bg-white rounded-3xl shadow-lg border border-[#f0e2d1] p-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Agendamiento no disponible</h1>
          <p className="mt-3 text-gray-600">{error || 'El enlace público no está activo para este profesional.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7f2] px-4 py-12">
      <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-lg border border-[#f0e2d1] p-6 md:p-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[#a57b4a] font-semibold">Reservar cita</p>
            <h1 className="mt-2 text-3xl font-bold text-gray-900">{selectedProfessionalName}</h1>
          </div>
          <div className="rounded-full bg-[#fff4e4] px-3 py-1 text-xs font-semibold text-[#a57b4a]">{profile.professional.clinic_name || clinicSlug}</div>
        </div>

        {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {success && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</div>}

        <div className="mt-6 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <label className="block text-sm font-medium text-gray-700">
              Nombre completo
              <input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="Tu nombre" />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Correo
              <input type="email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="nombre@correo.com" />
            </label>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <label className="block text-sm font-medium text-gray-700">
              Teléfono (opcional)
              <input value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="0999999999" />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Servicio
              <select value={form.service} onChange={(e) => {
                const treatment = profile.treatments?.find((item) => item.name === e.target.value);
                setForm((prev) => ({ ...prev, service: e.target.value, durationMinutes: treatment?.durationMinutes || 60 }));
              }} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20">
                {profile.treatments?.map((treatment) => <option key={treatment.name} value={treatment.name}>{treatment.name} · {treatment.durationMinutes} min</option>)}
              </select>
            </label>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <label className="block text-sm font-medium text-gray-700">
              Fecha
              <input type="date" min={new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })} value={form.date} onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Hora
              <input type="time" value={form.time} onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" />
            </label>
            <div className="block text-sm font-medium text-gray-700">
              Duración estimada
              <div className="mt-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-gray-600">{form.durationMinutes} minutos</div>
            </div>
          </div>

          {turnstileSiteKey && (
            <div className="mt-2">
              <div id="turnstile-widget" className="flex justify-start" />
            </div>
          )}

          {!turnstileSiteKey && (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              La verificación anti-bot no está configurada. Añade VITE_TURNSTILE_SITE_KEY y TURNSTILE_SECRET para habilitar la reserva pública.
            </div>
          )}

          <input type="text" value={form.website} onChange={(e) => setForm((prev) => ({ ...prev, website: e.target.value }))} className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />

          <button
            type="button"
            onClick={submitBooking}
            disabled={submitting || (turnstileSiteKey && !form.turnstileToken)}
            className="mt-4 w-full rounded-xl bg-[#deb887] px-4 py-3 font-semibold text-white disabled:opacity-60 hover:bg-[#c79f6f] transition-colors"
          >
            {submitting ? 'Agendando…' : 'Confirmar cita'}
          </button>
        </div>
      </div>
    </div>
  );
}

