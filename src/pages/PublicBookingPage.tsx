import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, Clock3, X } from 'lucide-react';

type TurnstileApi = {
  render: (selector: string, options: { sitekey: string; theme: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }) => void;
  reset: () => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi; }
}

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
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
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

    if (window.turnstile) {
      setTurnstileReady(true);
    }
  }, [turnstileSiteKey]);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileReady || !document.getElementById('turnstile-widget')) return;
    if (!window.turnstile) return;

    const existing = document.getElementById('turnstile-widget');
    if (existing && existing.childElementCount === 0) {
      window.turnstile.render('#turnstile-widget', {
        sitekey: turnstileSiteKey,
        theme: 'light',
        callback: (token: string) => setForm((prev) => ({ ...prev, turnstileToken: token })),
        'expired-callback': () => setForm((prev) => ({ ...prev, turnstileToken: '' })),
        'error-callback': () => setForm((prev) => ({ ...prev, turnstileToken: '' })),
      });
    }
  }, [showBookingModal, turnstileReady, turnstileSiteKey]);

  useEffect(() => {
    if (!showBookingModal || !clinicSlug || !username || !form.date || !form.service) {
      setAvailableSlots([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      clinicSlug,
      username,
      date: form.date,
      service: form.service,
      resource_id: form.resourceId,
    });
    setLoadingSlots(true);
    setAvailableSlots([]);
    setError('');
    setForm((prev) => ({ ...prev, time: '' }));
    fetch(`/api/public-booking?${params.toString()}`, { signal: controller.signal })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data?.success) throw new Error(data?.error || 'No se pudieron cargar los horarios.');
        if (!controller.signal.aborted) {
          setAvailableSlots(Array.isArray(data.slots) ? data.slots : []);
          setForm((prev) => ({ ...prev, durationMinutes: data.durationMinutes || prev.durationMinutes }));
        }
      })
      .catch((availabilityError) => {
        if (availabilityError.name !== 'AbortError') setError(availabilityError.message || 'No se pudieron cargar los horarios.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingSlots(false); });
    return () => controller.abort();
  }, [clinicSlug, form.date, form.resourceId, form.service, showBookingModal, username]);

  const selectedProfessionalName = useMemo(() => {
    if (form.resourceId === 'owner') return profile?.professional?.full_name || '';
    return profile?.resources?.find((resource) => `staff:${resource.id}` === form.resourceId)?.name || profile?.professional?.full_name || '';
  }, [form.resourceId, profile]);

  const submitBooking = async () => {
    if (!clinicSlug || !username || !profile?.professional) return;
    if (!form.name.trim() || !form.email.trim() || !form.phone.trim() || !form.service.trim() || !form.date || !form.time) {
      setError('Completa nombre, correo, teléfono, tratamiento, fecha y selecciona un horario.');
      return;
    }
    if (!availableSlots.includes(form.time)) {
      setError('Ese horario ya no está disponible. Selecciona uno de los horarios mostrados.');
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
      const appointmentDate = new Date(`${form.date}T${form.time}:00-05:00`);
      const appointmentDay = appointmentDate.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Guayaquil' });
      const appointmentTime = appointmentDate.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' });
      setSuccess(`¡Cita confirmada! Te esperamos el ${appointmentDay} a las ${appointmentTime}.`);
      setShowBookingModal(false);
      setAvailableSlots([]);
      setForm((prev) => ({ ...prev, name: '', email: '', phone: '', service: profile.treatments?.[0]?.name || '', date: '', time: '', durationMinutes: profile.treatments?.[0]?.durationMinutes || 60, turnstileToken: '', website: '' }));
      if (window.turnstile && document.getElementById('turnstile-widget')) {
        window.turnstile.reset();
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

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const dateLabel = form.date ? new Date(`${form.date}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Elige una fecha';

  return (
    <div className="min-h-screen bg-[#faf7f2] px-4 py-12">
      <main className="max-w-3xl mx-auto">
        <section className="overflow-hidden rounded-[2rem] border border-[#eadcc9] bg-white shadow-xl shadow-[#8b6b45]/10">
          <div className="bg-[#3e3026] px-6 py-10 text-white md:px-10">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#e8c995]">Agenda pública</p>
            <h1 className="mt-3 text-3xl font-semibold md:text-4xl">Reserva con {selectedProfessionalName}</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#e8ddd0]">Selecciona un horario real de la agenda. La disponibilidad se actualiza antes de confirmar tu cita.</p>
          </div>
          <div className="p-6 md:p-10">
            {error && !showBookingModal && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            {success && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"><Check className="mr-2 inline h-4 w-4" />{success}</div>}
            <div className="flex flex-col items-start justify-between gap-5 rounded-2xl border border-[#eadcc9] bg-[#fffaf4] p-5 md:flex-row md:items-center">
              <div>
                <p className="text-sm font-semibold text-gray-900">¿Listo para elegir tu cita?</p>
                <p className="mt-1 text-sm text-gray-600">Tratamientos, fecha y horas disponibles en un solo paso.</p>
              </div>
              <button type="button" onClick={() => { setError(''); setShowBookingModal(true); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#deb887] px-5 py-3 font-semibold text-white transition-colors hover:bg-[#c79f6f] md:w-auto">
                <CalendarDays className="h-5 w-5" /> Agendar cita
              </button>
            </div>
            <p className="mt-5 text-center text-xs text-gray-500">{profile.professional.clinic_name || clinicSlug}</p>
          </div>
        </section>
      </main>

      {showBookingModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#241b15]/60 p-0 backdrop-blur-sm md:items-center md:p-4" role="dialog" aria-modal="true" aria-labelledby="public-booking-title">
          <div className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl md:rounded-3xl md:p-8">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#a57b4a]">Nueva cita</p><h2 id="public-booking-title" className="mt-2 text-2xl font-bold text-gray-900">Elige tu horario</h2></div>
              <button type="button" onClick={() => setShowBookingModal(false)} aria-label="Cerrar agendamiento" className="rounded-full p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button>
            </div>
            {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="mt-6 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block text-sm font-medium text-gray-700">Tratamiento publicado
                  <select value={form.service} onChange={(e) => { const treatment = profile.treatments?.find((item) => item.name === e.target.value); setForm((prev) => ({ ...prev, service: e.target.value, durationMinutes: treatment?.durationMinutes || 60, time: '' })); }} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20">
                    {profile.treatments?.map((treatment) => <option key={treatment.name} value={treatment.name}>{treatment.name} · {treatment.durationMinutes} min</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium text-gray-700">Fecha
                  <input type="date" min={today} value={form.date} onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value, time: '' }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" />
                </label>
              </div>
              {profile.resources && profile.resources.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700">Profesional o recurso</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setForm((prev) => ({ ...prev, resourceId: 'owner', time: '' }))} className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${form.resourceId === 'owner' ? 'border-[#a57b4a] bg-[#a57b4a] text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-[#deb887]'}`}>
                      {profile.professional.full_name}
                    </button>
                    {profile.resources.map((resource) => (
                      <button key={resource.id} type="button" onClick={() => setForm((prev) => ({ ...prev, resourceId: `staff:${resource.id}`, time: '' }))} className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${form.resourceId === `staff:${resource.id}` ? 'border-[#a57b4a] bg-[#a57b4a] text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-[#deb887]'}`}>
                        {resource.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-2xl border border-[#eadcc9] bg-[#fffaf4] p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-gray-900"><Clock3 className="mr-2 inline h-4 w-4 text-[#a57b4a]" />Horarios disponibles</p><span className="text-xs text-gray-500">{dateLabel}</span></div>
                {loadingSlots && <p className="mt-4 text-sm text-gray-500">Consultando disponibilidad...</p>}
                {!loadingSlots && form.date && !availableSlots.length && <p className="mt-4 text-sm text-gray-600">No hay horarios disponibles para este día. Prueba con otra fecha.</p>}
                {!loadingSlots && !form.date && <p className="mt-4 text-sm text-gray-600">Selecciona una fecha para ver las horas libres.</p>}
                {!!availableSlots.length && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{availableSlots.map((slot) => <button key={slot} type="button" onClick={() => setForm((prev) => ({ ...prev, time: slot }))} className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${form.time === slot ? 'border-[#a57b4a] bg-[#a57b4a] text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-[#deb887] hover:bg-[#fffaf2]'}`}>{slot}</button>)}</div>}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block text-sm font-medium text-gray-700">Nombre completo<input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="Tu nombre" /></label>
                <label className="block text-sm font-medium text-gray-700">Correo<input required type="email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="nombre@correo.com" /></label>
                <label className="block text-sm font-medium text-gray-700">Teléfono<input required type="tel" value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" placeholder="0999999999" /></label>
                <div className="text-sm font-medium text-gray-700">Tiempo configurado por la clínica<div className="mt-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-gray-600">{form.durationMinutes} minutos</div></div>
              </div>
              {turnstileSiteKey && <div><div id="turnstile-widget" className="flex justify-start" /></div>}
              {!turnstileSiteKey && <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">La verificación anti-bot no está configurada. La reserva pública requiere Turnstile en producción.</div>}
              <input type="text" value={form.website} onChange={(e) => setForm((prev) => ({ ...prev, website: e.target.value }))} className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <button type="button" onClick={submitBooking} disabled={submitting || loadingSlots || !form.time || (turnstileSiteKey && !form.turnstileToken)} className="w-full rounded-xl bg-[#deb887] px-4 py-3 font-semibold text-white transition-colors hover:bg-[#c79f6f] disabled:opacity-60">{submitting ? 'Agendando...' : 'Confirmar cita'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

