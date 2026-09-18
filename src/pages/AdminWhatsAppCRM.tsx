import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, CheckCheck, Image, Loader2, MessageCircle, Music2, RefreshCw, Search, Users } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../context/AuthContext';

type Contact = {
  id: number;
  phone: string;
  name: string | null;
  last_message_at: string;
  last_message: string | null;
  last_direction: 'entrante' | 'saliente' | null;
  last_media_type: 'texto' | 'imagen' | 'audio' | null;
  last_status: 'leido' | 'enviado' | 'fallido' | null;
  clinic_id: string | null;
  clinic_name: string | null;
  category: 'staff_sistema' | 'usuario_clinico' | 'paciente_clinica' | 'sin_clasificar';
  category_label: string;
};

type Message = {
  id: number;
  contact_id: number;
  direction: 'entrante' | 'saliente';
  content: string;
  media_type: 'texto' | 'imagen' | 'audio';
  occurred_at: string;
  status: 'leido' | 'enviado' | 'fallido';
  error_detail: string | null;
};

const authHeaders = () => ({ Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` });
const formatTime = (value: string) => new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));

function MediaIcon({ type }: { type: Message['media_type'] }) {
  if (type === 'imagen') return <Image className="h-4 w-4" aria-label="Imagen" />;
  if (type === 'audio') return <Music2 className="h-4 w-4" aria-label="Audio" />;
  return null;
}

export default function AdminWhatsAppCRM() {
  const navigate = useNavigate();
  const { checkAuth, user } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<Contact['category'] | 'todos'>('todos');
  const latestRequest = useRef({ contactId: null as number | null, sequence: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadContacts = useCallback(async (query = '') => {
    setLoadingContacts(true);
    try {
      const response = await fetch(`/api/whatsapp-chatbot?action=crmContacts&search=${encodeURIComponent(query)}`, { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudieron cargar los contactos');
      setContacts(result.data || []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los contactos');
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  const loadMessages = useCallback(async (contactId: number) => {
    const sequence = latestRequest.current.sequence + 1;
    latestRequest.current = { contactId, sequence };
    setMessages([]);
    setLoadingMessages(true);
    try {
      const response = await fetch(`/api/whatsapp-chatbot?action=crmMessages&contactId=${contactId}`, { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo cargar la conversación');
      if (latestRequest.current.contactId === contactId && latestRequest.current.sequence === sequence) {
        setMessages(result.data || []);
        setError('');
      }
    } catch (loadError) {
      if (latestRequest.current.contactId === contactId && latestRequest.current.sequence === sequence) {
        setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar la conversación');
      }
    } finally {
      if (latestRequest.current.contactId === contactId && latestRequest.current.sequence === sequence) setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    checkAuth().then(valid => {
      const stored = sessionStorage.getItem('adminUser');
      const role = stored ? JSON.parse(stored).role : user?.role;
      if (!valid || role !== 'master_admin') navigate('/admin/login', { replace: true });
      else loadContacts();
    });
  }, [checkAuth, loadContacts, navigate, user?.role]);

  useEffect(() => {
    if (selected) loadMessages(selected.id);
  }, [loadMessages, selected]);

  useEffect(() => {
    if (!loadingMessages && messages.length) messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [loadingMessages, messages]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSelected(null);
    setMessages([]);
    loadContacts(search);
  };

  const closeConversation = () => {
    latestRequest.current = { contactId: null, sequence: latestRequest.current.sequence + 1 };
    setSelected(null);
    setMessages([]);
  };

  const visibleContacts = category === 'todos' ? contacts : contacts.filter(contact => contact.category === category);
  const categoryCounts = contacts.reduce<Record<string, number>>((counts, contact) => {
    counts[contact.category] = (counts[contact.category] || 0) + 1;
    return counts;
  }, {});

  return (
    <AdminLayout title="Conversaciones de WhatsApp" subtitle="Historial global de mensajes" backPath="/admin/master">
      <div className="mx-auto flex min-h-[calc(100vh-13rem)] max-w-7xl flex-col">
        {error && <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4" />{error}</div>}

        <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl md:grid-cols-[350px_minmax(0,1fr)]">
          <aside className={`${selected ? 'hidden md:flex' : 'flex'} min-h-0 min-w-0 flex-col border-r border-gray-200`}>
            <div className="shrink-0 border-b border-gray-200 bg-white">
              <form onSubmit={submitSearch} className="flex gap-2 p-3">
              <label className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar nombre o teléfono" className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20" />
              </label>
              <button type="button" title="Actualizar" onClick={() => loadContacts(search)} className="grid h-9 w-9 place-items-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"><RefreshCw className="h-4 w-4" /></button>
              </form>
              <div className="flex items-center gap-2 overflow-x-auto px-3 pb-3">
                {([
                  ['todos', 'Todos'],
                  ['staff_sistema', 'Staff'],
                  ['usuario_clinico', 'Usuarios'],
                  ['paciente_clinica', 'Pacientes'],
                  ['sin_clasificar', 'Sin clasificar'],
                ] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setCategory(value)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${category === value ? 'border-[#99652f] bg-[#99652f] text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-[#deb887]'}`}>
                    {label}{value !== 'todos' && <span className="ml-1 opacity-70">{categoryCounts[value] || 0}</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loadingContacts ? <div className="grid h-40 place-items-center text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div> : visibleContacts.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-400">No hay conversaciones registradas.</div>
              ) : visibleContacts.map(contact => (
                <button key={contact.id} onClick={() => setSelected(contact)} className="flex w-full gap-3 border-b border-gray-100 p-4 text-left hover:bg-gray-50">
                  <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full font-semibold ${contact.category === 'staff_sistema' ? 'bg-slate-100 text-slate-700' : contact.category === 'usuario_clinico' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>{(contact.name || contact.phone).charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-gray-900">{contact.name || contact.phone}</span><time className="shrink-0 text-[10px] text-gray-400">{formatTime(contact.last_message_at)}</time></div>
                    <p className="truncate text-xs text-gray-500">{contact.name ? contact.phone : contact.last_message || 'Sin contenido'}</p>
                    <p className="mt-1 flex items-center gap-1 truncate text-[11px] font-medium text-[#99652f]"><Users className="h-3 w-3 shrink-0" />{contact.category_label}</p>
                    {contact.name && <p className="mt-1 truncate text-xs text-gray-400">{contact.last_message || 'Sin contenido'}</p>}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className={`${selected ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col overflow-hidden bg-[#f6f3ee]`}>
            {!selected ? (
              <div className="grid flex-1 place-items-center p-8 text-center text-gray-400"><div><MessageCircle className="mx-auto mb-3 h-10 w-10" /><p className="text-sm">Selecciona una conversación para revisar su historial.</p></div></div>
            ) : (
              <>
                <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
                  <button onClick={closeConversation} className="text-sm font-medium text-[#99652f] md:hidden">Contactos</button>
                  <div className="min-w-0"><h2 className="truncate font-semibold text-gray-900">{selected.name || selected.phone}</h2><p className="text-xs text-gray-500">{selected.phone} · {selected.category_label}</p></div>
                  <button title="Actualizar conversación" onClick={() => loadMessages(selected.id)} className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-gray-500 hover:bg-gray-100"><RefreshCw className="h-4 w-4" /></button>
                </header>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-4 md:p-6 [scrollbar-gutter:stable]">
                  {loadingMessages ? <div className="grid flex-1 place-items-center text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div> : messages.map(message => (
                    <article key={message.id} className={`w-fit min-w-0 max-w-[85%] rounded-lg px-3 py-2 shadow-sm ${message.direction === 'saliente' ? 'ml-auto bg-[#fff1dc]' : 'mr-auto bg-white'}`}>
                      <div className="flex min-w-0 items-start gap-2 text-sm text-gray-800"><MediaIcon type={message.media_type} /><p className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content || `[${message.media_type}]`}</p></div>
                      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-gray-400">
                        <time>{formatTime(message.occurred_at)}</time>
                        {message.status === 'fallido' ? <AlertTriangle className="h-3 w-3 text-red-500" aria-label="Fallido" /> : message.status === 'leido' ? <CheckCheck className="h-3 w-3 text-sky-500" aria-label="Leído" /> : <Check className="h-3 w-3" aria-label="Enviado" />}
                      </div>
                      {message.error_detail && <p className="mt-1 text-xs text-red-600">{message.error_detail}</p>}
                    </article>
                  ))}
                  {!loadingMessages && messages.length === 0 && <div className="grid flex-1 place-items-center text-sm text-gray-400">No hay mensajes en esta conversación.</div>}
                  <div ref={messagesEndRef} aria-hidden="true" />
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </AdminLayout>
  );
}