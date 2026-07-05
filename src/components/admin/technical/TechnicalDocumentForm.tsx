import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2, Box, FileText, CheckSquare, DollarSign, Copy, ClipboardCheck, Search, UserCheck, X } from 'lucide-react';

interface CheckItem {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'na';
  observation: string;
}

interface AccessoryItem {
  name: string;
  condition: 'bueno' | 'regular' | 'malo';
}

interface ExistingClient {
  client_name: string;
  client_contact: string | null;
  client_cedula?: string | null;
  client_center?: string | null;
  documents_count: number;
  last_activity: string;
}

type DocumentType = 'reception' | 'technical_report' | 'proforma' | 'delivery_receipt';

type FormState = {
  ticket_number: string;
  document_type: DocumentType;
  client_name: string;
  client_contact: string;
  client_cedula: string;
  client_center: string;
  equipment_data: {
    brand: string;
    model: string;
    serial: string;
    accessories: AccessoryItem[];
    visual_condition: string;
    reported_issue: string;
  };
  checklist_data: {
    checks: CheckItem[];
  };
  diagnosis: string;
  recommendations: string;
  total_cost: number;
  status: string;
};

const DOC_PREFIX: Record<DocumentType, string> = {
  reception: 'REC',
  technical_report: 'INF',
  proforma: 'PRO',
  delivery_receipt: 'ENT'
};

function generateTicket(type: DocumentType): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return `${DOC_PREFIX[type]}-${y}${m}${d}-${rnd}`;
}

function defaultState(type: DocumentType = 'reception'): FormState {
  return {
    ticket_number: generateTicket(type),
    document_type: type,
    client_name: '',
    client_contact: '',
    client_cedula: '',
    client_center: '',
    equipment_data: {
      brand: '',
      model: '',
      serial: '',
      accessories: [],
      visual_condition: '',
      reported_issue: ''
    },
    checklist_data: {
      checks: []
    },
    diagnosis: '',
    recommendations: '',
    total_cost: 0,
    status: 'pending'
  };
}

function normalizeAccessories(raw: any): AccessoryItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Retrocompatibilidad: si era string, convertir a items
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s: string) => ({ name: s.trim(), condition: 'bueno' as const })).filter((a: AccessoryItem) => a.name);
  }
  return [];
}

function normalizeDocument(raw: any): FormState {
  const type = (raw?.document_type || 'reception') as DocumentType;
  return {
    ...defaultState(type),
    ...raw,
    document_type: type,
    client_cedula: raw?.client_cedula || '',
    client_center: raw?.client_center || '',
    equipment_data: {
      ...defaultState(type).equipment_data,
      ...(raw?.equipment_data || {}),
      accessories: normalizeAccessories(raw?.equipment_data?.accessories)
    },
    checklist_data: {
      checks: raw?.checklist_data?.checks || []
    },
    total_cost: Number(raw?.total_cost || 0)
  };
}

export default function TechnicalDocumentForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const copyFrom = searchParams.get('copyFrom');
  const presetClient = searchParams.get('client');
  const presetContact = searchParams.get('contact');
  const [loading, setLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  
  const [formData, setFormData] = useState<FormState>(defaultState());

  const [checkItems, setCheckItems] = useState<CheckItem[]>([]);
  const [clientLookup, setClientLookup] = useState('');
  const [clientSuggestions, setClientSuggestions] = useState<ExistingClient[]>([]);
  const [clientLookupLoading, setClientLookupLoading] = useState(false);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [selectedExistingClient, setSelectedExistingClient] = useState<ExistingClient | null>(null);

  useEffect(() => {
    if (!id && copyFrom) {
      copyFromDocument(copyFrom);
      return;
    }

    if (id) {
      fetchDocument(id);
      return;
    }

    const initial = defaultState('reception');
    setFormData({
      ...initial,
      client_name: presetClient?.trim() || '',
      client_contact: presetContact?.trim() || ''
    });
    setClientLookup(presetClient?.trim() || '');
    setSelectedExistingClient(null);
    setClientSuggestions([]);
    setCheckItems([]);
  }, [id, copyFrom, presetClient, presetContact]);

  // Adjust checklist/defaults based on type ONLY when creating new
  useEffect(() => {
    if (!id && !copyFrom) {
        if (formData.document_type === 'reception') {
          setCheckItems([
            { id: '1', label: 'Enciende', status: 'na', observation: '' },
            { id: '2', label: 'Pantalla', status: 'na', observation: '' },
            { id: '3', label: 'Botones / Perillas', status: 'na', observation: '' },
            { id: '4', label: 'Cables / Conectores', status: 'na', observation: '' },
            { id: '5', label: 'Carcasa / Estructura', status: 'na', observation: '' },
            { id: '6', label: 'Funcionalidad Básica', status: 'na', observation: '' },
          ]);
        } else if (formData.document_type === 'technical_report') {
          // Reports can start empty or with technical checks
           if(checkItems.length === 0) {
               setCheckItems([
                { id: '1', label: 'Voltaje Entrada', status: 'na', observation: '' },
                { id: '2', label: 'Fuente Poder', status: 'na', observation: '' },
                { id: '3', label: 'Sistema Refrigeración', status: 'na', observation: '' },
                { id: '4', label: 'Emisión de Energía', status: 'na', observation: '' },
               ]);
           }
        } else if (formData.document_type === 'proforma') {
            setCheckItems([]); // Proformas usually don't need a checklist
        } else if (formData.document_type === 'delivery_receipt') {
            setCheckItems([]);
        }
    }
  }, [formData.document_type, id, copyFrom]);

  useEffect(() => {
    if (id) return;

    const term = clientLookup.trim();
    const timeoutId = setTimeout(() => {
      void fetchClientSuggestions(term);
    }, 250);

    return () => clearTimeout(timeoutId);
  }, [clientLookup, id]);

  const fetchDocument = async (docId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/technical-service?id=${docId}`);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDocument(data);
        setFormData(normalized);
        setCheckItems(normalized.checklist_data.checks || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const copyFromDocument = async (sourceId: string) => {
    setCopyLoading(true);
    try {
      const res = await fetch(`/api/technical-service?id=${sourceId}`);
      if (!res.ok) return;

      const data = await res.json();
      const normalized = normalizeDocument(data);
      const nextTicket = generateTicket(normalized.document_type);

      setFormData({
        ...normalized,
        ticket_number: nextTicket,
        status: 'draft'
      });
      setCheckItems(normalized.checklist_data.checks || []);
    } catch (error) {
      console.error('Error copying document:', error);
    } finally {
      setCopyLoading(false);
    }
  };

  const ensureFinalDefaults = (payload: FormState): FormState => {
    return {
      ...payload,
      client_name: payload.client_name.trim(),
      client_contact: payload.client_contact.trim(),
      client_cedula: payload.client_cedula.trim(),
      client_center: payload.client_center.trim(),
      diagnosis: payload.diagnosis.trim(),
      recommendations: payload.recommendations.trim(),
      total_cost: Number.isFinite(payload.total_cost) ? payload.total_cost : 0
    };
  };

  const fetchClientSuggestions = async (term: string) => {
    setClientLookupLoading(true);

    try {
      const params = new URLSearchParams();
      params.append('mode', 'clients');
      params.append('limit', '8');
      if (term) params.append('search', term);

      const res = await fetch(`/api/technical-service?${params.toString()}`);
      if (!res.ok) {
        setClientSuggestions([]);
        return;
      }

      const data = await res.json();
      setClientSuggestions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching clients:', error);
      setClientSuggestions([]);
    } finally {
      setClientLookupLoading(false);
    }
  };

  const applyExistingClient = (client: ExistingClient) => {
    setFormData((prev) => ({
      ...prev,
      client_name: client.client_name,
      client_contact: client.client_contact || prev.client_contact,
      client_cedula: client.client_cedula || prev.client_cedula,
      client_center: client.client_center || prev.client_center
    }));
    setClientLookup(client.client_name);
    setSelectedExistingClient(client);
    setShowClientSuggestions(false);
  };

  const markAsNewClient = () => {
    setSelectedExistingClient(null);
    setShowClientSuggestions(false);
    setFormData((prev) => ({ ...prev, client_name: clientLookup.trim() || prev.client_name }));
  };

  const handleSubmit = async (e?: React.FormEvent, forcedStatus?: string) => {
    e?.preventDefault();
    setLoading(true);
    
    // Merge checklist into form data
    const payload = ensureFinalDefaults({
      ...formData,
      status: forcedStatus || formData.status,
      checklist_data: { checks: checkItems }
    });

    if (payload.status !== 'draft' && !payload.client_name) {
      window.alert('Debes ingresar el nombre del cliente para guardar el documento final.');
      setLoading(false);
      return;
    }

    try {
      const method = id ? 'PUT' : 'POST';
      const res = await fetch('/api/technical-service', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id, ...payload } : payload)
      });

      if (res.ok) {
        navigate('/admin/technical');
      } else {
        alert('Error al guardar el documento');
      }
    } catch (e) {
      console.error(e);
      alert('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  const applyTemplate = (template: 'report' | 'proforma' | 'delivery') => {
    if (template === 'report') {
      setFormData((prev) => ({
        ...prev,
        diagnosis: prev.diagnosis || '1) Pruebas iniciales de encendido y verificación de voltajes.\n2) Inspección de módulo principal y conexiones internas.\n3) Detección de componente con comportamiento irregular.',
        recommendations: prev.recommendations || '1) Reemplazo de componente defectuoso.\n2) Limpieza técnica preventiva y recalibración.\n3) Prueba funcional completa y validación final con el cliente.'
      }));
      return;
    }

    if (template === 'proforma') {
      setFormData((prev) => ({
        ...prev,
        recommendations: prev.recommendations || '1. Diagnóstico técnico especializado\n2. Repuesto principal\n3. Mano de obra técnica\n4. Pruebas de funcionamiento y cierre',
        total_cost: prev.total_cost || 0
      }));
      return;
    }

    setFormData((prev) => ({
      ...prev,
      recommendations: prev.recommendations || 'Equipo entregado en funcionamiento y con recomendaciones de uso preventivo.\nCliente recibe accesorios y equipo en conformidad.',
      status: prev.status === 'draft' ? 'delivered' : prev.status
    }));
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <button onClick={() => navigate('/admin/technical')} className="text-gray-500 hover:text-gray-700 flex items-center gap-2">
          <ArrowLeft size={20} /> Volver
        </button>
        <h1 className="text-2xl font-serif text-[#b8860b]">
            {id ? 'Editar Documento' : 'Nuevo Documento Técnico'}
        </h1>
      </div>

      <form onSubmit={(e) => handleSubmit(e)} className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 space-y-8">
        
        {/* Header Section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-gray-50 p-6 rounded-lg border border-gray-200">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1 uppercase tracking-wide">Tipo de Documento</label>
            <select
              value={formData.document_type}
              onChange={(e) => {
                const nextType = e.target.value as DocumentType;
                setFormData({
                  ...formData,
                  document_type: nextType,
                  ticket_number: id ? formData.ticket_number : generateTicket(nextType)
                });
              }}
              className="w-full rounded-lg border-gray-300 focus:ring-[#b8860b] focus:border-[#b8860b] font-medium"
            >
              <option value="reception">Recepción de Equipo</option>
              <option value="technical_report">Informe Técnico</option>
              <option value="proforma">Proforma</option>
              <option value="delivery_receipt">Acta Entrega/Recepción</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket #</label>
            <input
              type="text"
              value={formData.ticket_number}
              readOnly
              className="w-full bg-white rounded-lg border-gray-300 font-mono text-gray-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
            <select
              value={formData.status}
              onChange={(e) => setFormData({...formData, status: e.target.value})}
              className="w-full rounded-lg border-gray-300 focus:ring-[#b8860b] focus:border-[#b8860b]"
            >
              <option value="draft">Borrador</option>
              <option value="pending">Pendiente</option>
              <option value="in_progress">En Revisión</option>
              <option value="completed">Finalizado</option>
              <option value="delivered">Entregado</option>
            </select>
          </div>
        </div>

        {/* Client Info - Shared by All */}
        <div className="border-b pb-6">
          <h3 className="text-lg font-medium text-gray-800 mb-4 flex items-center gap-2">
            <span className="p-1 bg-[#b8860b]/10 rounded text-[#b8860b]"><Box size={18}/></span>
            Información del Cliente
          </h3>

          {!id && (
            <div className="mb-5 relative">
              <label className="block text-sm text-gray-600 mb-1">Buscar cliente existente (nombre, cédula o teléfono)</label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  value={clientLookup}
                  onFocus={() => {
                    setShowClientSuggestions(true);
                    if (clientSuggestions.length === 0) {
                      void fetchClientSuggestions(clientLookup.trim());
                    }
                  }}
                  onBlur={() => setTimeout(() => setShowClientSuggestions(false), 150)}
                  onChange={(e) => {
                    setClientLookup(e.target.value);
                    setShowClientSuggestions(true);
                    setSelectedExistingClient(null);
                  }}
                  className="w-full rounded-lg border-gray-200 pl-9"
                  placeholder="Ej. Clínica Bella, 0991234567 o 1712345678"
                />
              </div>

              {showClientSuggestions && (
                <div className="absolute z-20 mt-2 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                  {clientLookupLoading ? (
                    <p className="px-4 py-3 text-sm text-gray-500">Buscando clientes...</p>
                  ) : clientSuggestions.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-500">
                      <p>No hay coincidencias.</p>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          markAsNewClient();
                        }}
                        className="mt-2 text-[#b8860b] font-medium hover:text-[#a0750a]"
                      >
                        Usar como cliente nuevo
                      </button>
                    </div>
                  ) : (
                    <>
                      {clientSuggestions.map((client) => (
                        <button
                          key={`${client.client_name}-${client.client_contact || 'no-contact'}`}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyExistingClient(client);
                          }}
                          className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                        >
                          <p className="font-medium text-gray-800">{client.client_name}</p>
                          <p className="text-xs text-gray-500">
                            {client.client_contact || 'Sin contacto'} · {client.documents_count} documento(s)
                          </p>
                        </button>
                      ))}
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          markAsNewClient();
                        }}
                        className="w-full text-left px-4 py-3 text-sm text-[#b8860b] hover:bg-yellow-50"
                      >
                        Crear nuevo cliente con este nombre
                      </button>
                    </>
                  )}
                </div>
              )}

              <p className="text-xs text-gray-500 mt-2">
                Flujo recomendado: primero busca y selecciona cliente existente; si no aparece, créalo como nuevo.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Nombre Responsable / Persona Encargada</label>
              <input
                type="text"
                value={formData.client_name}
                onChange={(e) => {
                  setFormData({ ...formData, client_name: e.target.value });
                  setClientLookup(e.target.value);
                  if (selectedExistingClient && e.target.value !== selectedExistingClient.client_name) {
                    setSelectedExistingClient(null);
                  }
                }}
                className="w-full rounded-lg border-gray-200"
                placeholder="Ej. Dr. Juan Pérez..."
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Cédula / RUC</label>
              <input
                type="text"
                value={formData.client_cedula}
                onChange={(e) => setFormData({...formData, client_cedula: e.target.value})}
                className="w-full rounded-lg border-gray-200"
                placeholder="Ej. 1712345678"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Contacto / Teléfono</label>
              <input
                type="text"
                value={formData.client_contact}
                onChange={(e) => setFormData({...formData, client_contact: e.target.value})}
                className="w-full rounded-lg border-gray-200"
                placeholder="Ej. 099..."
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Centro / Consultorio</label>
              <input
                type="text"
                value={formData.client_center}
                onChange={(e) => setFormData({...formData, client_center: e.target.value})}
                className="w-full rounded-lg border-gray-200"
                placeholder="Ej. Clínica Estética XYZ..."
              />
            </div>
          </div>

          {selectedExistingClient && (
            <div className="mt-4 inline-flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 text-green-800 rounded-lg text-xs font-medium">
              <UserCheck size={14} />
              Cliente existente seleccionado: {selectedExistingClient.client_name}
            </div>
          )}
        </div>

        {/* --- SECTION: EQUIPMENT DATA (RECEPTION & REPORT) --- */}
        {(formData.document_type === 'reception' || formData.document_type === 'technical_report' || formData.document_type === 'delivery_receipt') && (
        <div className="border-b pb-6">
           <h3 className="text-lg font-medium text-gray-800 mb-4 flex items-center gap-2">
            <span className="p-1 bg-[#b8860b]/10 rounded text-[#b8860b]"><Box size={18}/></span>
            Datos del Equipo
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
             <div>
              <label className="block text-sm text-gray-600 mb-1">Marca</label>
              <input
                type="text"
                value={formData.equipment_data.brand}
                onChange={(e) => setFormData({...formData, equipment_data: {...formData.equipment_data, brand: e.target.value}})}
                className="w-full rounded-lg border-gray-200"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Modelo</label>
              <input
                type="text"
                value={formData.equipment_data.model}
                onChange={(e) => setFormData({...formData, equipment_data: {...formData.equipment_data, model: e.target.value}})}
                className="w-full rounded-lg border-gray-200"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Serie</label>
              <input
                type="text"
                value={formData.equipment_data.serial}
                onChange={(e) => setFormData({...formData, equipment_data: {...formData.equipment_data, serial: e.target.value}})}
                className="w-full rounded-lg border-gray-200"
              />
            </div>
             
             {/* Only Reception needs specific reception details prominent */}
             {(formData.document_type === 'reception' || formData.document_type === 'delivery_receipt') && (
                <>
                <div className="col-span-3">
                <label className="block text-sm font-bold text-gray-700 mb-1">
                  {formData.document_type === 'delivery_receipt' ? 'Observaciones de Entrega' : 'Problema Reportado / Motivo de Ingreso'}
                </label>
                    <textarea
                        rows={2}
                        value={formData.equipment_data.reported_issue || ''}
                        onChange={(e) => setFormData({...formData, equipment_data: {...formData.equipment_data, reported_issue: e.target.value}})}
                        className="w-full rounded-lg border-gray-200 bg-red-50"
                  placeholder={formData.document_type === 'delivery_receipt' ? 'Notas de condición al entregar...' : 'Descripción falla indicada por el cliente...'}
                    />
                </div>
                <div className="col-span-3">
                    <label className="block text-sm text-gray-600 mb-2">Accesorios Recibidos</label>
                    
                    {/* Quick-add chips */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      {['Pedal', 'Cable de poder', 'Punta / Handpiece', 'Manual / Documentación', 'Adaptador / Conector', 'Control remoto', 'Funda / Estuche', 'Cartuchos'].map((opt) => {
                        const alreadyAdded = formData.equipment_data.accessories.some((a) => a.name === opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={alreadyAdded}
                            onClick={() => {
                              if (!alreadyAdded) {
                                setFormData({...formData, equipment_data: {...formData.equipment_data, accessories: [...formData.equipment_data.accessories, { name: opt, condition: 'bueno' }]}});
                              }
                            }}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              alreadyAdded 
                                ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' 
                                : 'bg-[#b8860b]/10 text-[#b8860b] border-[#b8860b]/30 hover:bg-[#b8860b]/20 cursor-pointer'
                            }`}
                          >
                            + {opt}
                          </button>
                        );
                      })}
                    </div>

                    {/* Manual add */}
                    <div className="flex gap-2 mb-3">
                      <input
                        type="text"
                        id="accessory-manual-input"
                        placeholder="Escribir accesorio personalizado..."
                        className="flex-1 rounded-lg border-gray-200 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const input = e.currentTarget;
                            const val = input.value.trim();
                            if (val && !formData.equipment_data.accessories.some((a) => a.name.toLowerCase() === val.toLowerCase())) {
                              setFormData({...formData, equipment_data: {...formData.equipment_data, accessories: [...formData.equipment_data.accessories, { name: val, condition: 'bueno' }]}});
                              input.value = '';
                            }
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const input = document.getElementById('accessory-manual-input') as HTMLInputElement;
                          const val = input?.value.trim();
                          if (val && !formData.equipment_data.accessories.some((a) => a.name.toLowerCase() === val.toLowerCase())) {
                            setFormData({...formData, equipment_data: {...formData.equipment_data, accessories: [...formData.equipment_data.accessories, { name: val, condition: 'bueno' }]}});
                            input.value = '';
                          }
                        }}
                        className="px-4 py-2 bg-[#b8860b] text-white rounded-lg text-sm hover:bg-[#a0750a] flex items-center gap-1"
                      >
                        <Plus size={16} /> Añadir
                      </button>
                    </div>

                    {/* Accessories list */}
                    {formData.equipment_data.accessories.length > 0 && (
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        {formData.equipment_data.accessories.map((acc, idx) => (
                          <div key={idx} className="flex items-center justify-between px-4 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                            <span className="text-sm text-gray-800 font-medium">{acc.name}</span>
                            <div className="flex items-center gap-3">
                              <select
                                value={acc.condition}
                                onChange={(e) => {
                                  const updated = [...formData.equipment_data.accessories];
                                  updated[idx] = { ...updated[idx], condition: e.target.value as 'bueno' | 'regular' | 'malo' };
                                  setFormData({...formData, equipment_data: {...formData.equipment_data, accessories: updated}});
                                }}
                                className={`rounded-full text-xs font-semibold px-2 py-1 border-none focus:ring-0 cursor-pointer ${
                                  acc.condition === 'bueno' ? 'bg-green-100 text-green-800' :
                                  acc.condition === 'regular' ? 'bg-yellow-100 text-yellow-800' :
                                  'bg-red-100 text-red-800'
                                }`}
                              >
                                <option value="bueno">Bueno</option>
                                <option value="regular">Regular</option>
                                <option value="malo">Malo</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = formData.equipment_data.accessories.filter((_, i) => i !== idx);
                                  setFormData({...formData, equipment_data: {...formData.equipment_data, accessories: updated}});
                                }}
                                className="text-gray-400 hover:text-red-500"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {formData.equipment_data.accessories.length === 0 && (
                      <p className="text-xs text-gray-400 italic">No se han agregado accesorios. Usa los botones de arriba o escribe uno manualmente.</p>
                    )}
                </div>
                <div className="col-span-3">
                    <label className="block text-sm text-gray-600 mb-2">Condición Visual</label>
                    
                    {/* Quick-add visual condition chips */}
                    <div className="flex flex-wrap gap-2 mb-2">
                      {['Sin daños visibles', 'Rayones leves', 'Rayones profundos', 'Golpes / Abolladuras', 'Manchas / Decoloración', 'Desgaste por uso', 'Partes faltantes', 'Pantalla rota / dañada', 'Cables deteriorados', 'Óxido / Corrosión'].map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => {
                            const current = formData.equipment_data.visual_condition.trim();
                            const items = current ? current.split(', ').map(s => s.trim()).filter(Boolean) : [];
                            if (!items.includes(opt)) {
                              const updated = [...items, opt].join(', ');
                              setFormData({...formData, equipment_data: {...formData.equipment_data, visual_condition: updated}});
                            }
                          }}
                          className={`px-2 py-1 rounded-full text-xs font-medium border transition-colors ${
                            formData.equipment_data.visual_condition.includes(opt)
                              ? 'bg-gray-100 text-gray-400 border-gray-200'
                              : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer'
                          }`}
                        >
                          + {opt}
                        </button>
                      ))}
                    </div>
                    
                    <div className="flex gap-2">
                      <input
                        type="text"
                        id="visual-condition-input"
                        placeholder="Escribir condición personalizada..."
                        className="flex-1 rounded-lg border-gray-200 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const input = e.currentTarget;
                            const val = input.value.trim();
                            if (val) {
                              const current = formData.equipment_data.visual_condition.trim();
                              const items = current ? current.split(', ').map(s => s.trim()).filter(Boolean) : [];
                              if (!items.includes(val)) {
                                const updated = [...items, val].join(', ');
                                setFormData({...formData, equipment_data: {...formData.equipment_data, visual_condition: updated}});
                              }
                              input.value = '';
                            }
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const input = document.getElementById('visual-condition-input') as HTMLInputElement;
                          const val = input?.value.trim();
                          if (val) {
                            const current = formData.equipment_data.visual_condition.trim();
                            const items = current ? current.split(', ').map(s => s.trim()).filter(Boolean) : [];
                            if (!items.includes(val)) {
                              const updated = [...items, val].join(', ');
                              setFormData({...formData, equipment_data: {...formData.equipment_data, visual_condition: updated}});
                            }
                            input.value = '';
                          }
                        }}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 flex items-center gap-1"
                      >
                        <Plus size={16} /> Añadir
                      </button>
                    </div>

                    {formData.equipment_data.visual_condition.trim() && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {formData.equipment_data.visual_condition.split(', ').map((item, idx) => (
                          item.trim() && (
                            <span key={idx} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                              {item.trim()}
                              <button
                                type="button"
                                onClick={() => {
                                  const items = formData.equipment_data.visual_condition.split(', ').map(s => s.trim()).filter(Boolean);
                                  const updated = items.filter((_, i) => i !== idx).join(', ');
                                  setFormData({...formData, equipment_data: {...formData.equipment_data, visual_condition: updated}});
                                }}
                                className="text-gray-400 hover:text-red-500"
                              >
                                <X size={12} />
                              </button>
                            </span>
                          )
                        ))}
                      </div>
                    )}
                </div>
                </>
             )}
          </div>
        </div>
        )}

        {/* --- SECTION: CHECKLIST (RECEPTION ONLY or OPTIONAL in OTHERS) --- */}
        {(formData.document_type === 'reception' || formData.document_type === 'delivery_receipt') && (
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-6">
                <div className="bg-gray-50 px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                    <h3 className="font-medium text-gray-700 flex items-center gap-2">
                <CheckSquare size={18} className="text-[#b8860b]"/> {formData.document_type === 'delivery_receipt' ? 'Checklist de Entrega' : 'Checklist de Ingreso'}
                    </h3>
                    <button 
                        type="button" 
                        onClick={() => setCheckItems([...checkItems, { id: Date.now().toString(), label: '', status: 'na', observation: '' }])}
                        className="text-sm text-[#b8860b] hover:text-[#a0750a] flex items-center gap-1"
                    >
                        <Plus size={16} /> Agregar Item
                    </button>
                </div>
                <div className="p-0">
                    <table className="w-full">
                        <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                            <tr>
                                <th className="px-6 py-3 text-left">Punto de Control</th>
                                <th className="px-6 py-3 text-center">Estado</th>
                                <th className="px-6 py-3 text-left">Observación</th>
                                <th className="px-6 py-3 w-10"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {checkItems.map((item, idx) => (
                                <tr key={item.id}>
                                    <td className="px-6 py-2">
                                        <input 
                                            type="text" 
                                            value={item.label}
                                            onChange={(e) => {
                                                const newItems = [...checkItems];
                                                newItems[idx].label = e.target.value;
                                                setCheckItems(newItems);
                                            }}
                                            placeholder="Componente..."
                                            className="w-full border-none focus:ring-0 bg-transparent"
                                        />
                                    </td>
                                    <td className="px-6 py-2 text-center">
                                         <select
                                            value={item.status}
                                            onChange={(e) => {
                                                const newItems = [...checkItems];
                                                newItems[idx].status = e.target.value as any;
                                                setCheckItems(newItems);
                                            }}
                                            className={`rounded-full text-xs font-semibold px-2 py-1 border-none focus:ring-0 cursor-pointer
                                                ${item.status === 'ok' ? 'bg-green-100 text-green-800' : 
                                                  item.status === 'fail' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'}`}
                                        >
                                            <option value="ok">OK</option>
                                            <option value="fail">MALO</option>
                                            <option value="na">N/A</option>
                                        </select>
                                    </td>
                                    <td className="px-6 py-2">
                                         <input 
                                            type="text" 
                                            value={item.observation}
                                            onChange={(e) => {
                                                const newItems = [...checkItems];
                                                newItems[idx].observation = e.target.value;
                                                setCheckItems(newItems);
                                            }}
                                            placeholder="..."
                                            className="w-full border-none focus:ring-0 bg-transparent text-sm text-gray-500"
                                        />
                                    </td>
                                    <td className="px-6 py-2 text-center">
                                        <button type="button" onClick={() => setCheckItems(checkItems.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-red-500">
                                            <Trash2 size={16} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        )}

        {/* --- SECTION: TECHNICAL DIAGNOSIS (REPORT & PROFORMA) --- */}
        {(formData.document_type === 'technical_report' || formData.document_type === 'proforma' || formData.document_type === 'delivery_receipt') && (
         <div className="bg-gray-50 p-6 rounded-lg border border-gray-100">
          <h3 className="text-lg font-medium text-gray-800 mb-4 flex items-center gap-2">
            <span className="p-1 bg-[#b8860b]/10 rounded text-[#b8860b]"><FileText size={18}/></span>
            {formData.document_type === 'proforma' ? 'Detalle de la Oferta' : formData.document_type === 'delivery_receipt' ? 'Detalle de Entrega y Cierre' : 'Análisis Técnico'}
          </h3>
          <div className="mb-4 flex flex-wrap gap-2">
            {formData.document_type === 'technical_report' && (
              <button
                type="button"
                onClick={() => applyTemplate('report')}
                className="px-3 py-1.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 text-xs font-medium"
              >
                Plantilla Informe
              </button>
            )}
            {formData.document_type === 'proforma' && (
              <button
                type="button"
                onClick={() => applyTemplate('proforma')}
                className="px-3 py-1.5 rounded-full border border-green-200 bg-green-50 text-green-700 text-xs font-medium"
              >
                Plantilla Proforma
              </button>
            )}
            {formData.document_type === 'delivery_receipt' && (
              <button
                type="button"
                onClick={() => applyTemplate('delivery')}
                className="px-3 py-1.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-medium"
              >
                Plantilla Acta
              </button>
            )}
          </div>
          <div className="space-y-4">
            
            {formData.document_type === 'technical_report' && (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Diagnóstico / Hallazgos</label>
              <textarea
                rows={4}
                value={formData.diagnosis}
                onChange={(e) => setFormData({...formData, diagnosis: e.target.value})}
                className="w-full rounded-lg border-gray-200 mb-4"
                placeholder="Describa el problema encontrado y pruebas realizadas..."
              />
            </div>
            )}

            <div>
              <label className="block text-sm text-gray-600 mb-1">
                    {formData.document_type === 'proforma' ? 'Servicios y Repuestos a COTIZAR' : formData.document_type === 'delivery_receipt' ? 'Detalle de Entrega / Recomendaciones' : 'Trabajos Realizados / Recomendaciones'}
              </label>
              <textarea
                rows={6}
                value={formData.recommendations}
                onChange={(e) => setFormData({...formData, recommendations: e.target.value})}
                className="w-full rounded-lg border-gray-200 font-mono text-sm"
                placeholder={formData.document_type === 'proforma' 
                    ? "1. Repuesto X - $100\n2. Mano de Obra - $50" 
                    : formData.document_type === 'delivery_receipt' ? 'Checklist final, conformidad, observaciones...' : "Describa la solución aplicada..."}
              />
            </div>
             
             <div>
              <label className="block text-sm font-bold text-gray-700 mb-1 flex items-center gap-1">
                  <DollarSign size={16}/> Total ({formData.document_type === 'proforma' ? 'A Pagar' : formData.document_type === 'delivery_receipt' ? 'Costo Final' : 'Costo Reparación'})
              </label>
              <input
                type="number"
                value={formData.total_cost}
                onChange={(e) => setFormData({...formData, total_cost: Number(e.target.value) || 0})}
                className="w-48 rounded-lg border-gray-300 text-lg font-bold text-gray-800"
              />
            </div>
          </div>
        </div>
        )}

        <div className="flex justify-end gap-4 pt-4 border-t border-gray-100">
            {!id && (
              <button
                type="button"
                onClick={() => handleSubmit(undefined, 'draft')}
                className="px-6 py-2 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-2"
                disabled={loading || copyLoading}
              >
                <Copy size={18} />
                Guardar Borrador
              </button>
            )}
            <button
                type="button"
                onClick={() => navigate('/admin/technical')}
                className="px-6 py-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
                disabled={loading || copyLoading}
            >
                Cancelar
            </button>
            <button
                type="submit"
                disabled={loading || copyLoading}
                className="bg-[#b8860b] text-white px-8 py-2 rounded-lg hover:bg-[#a0750a] transition-colors flex items-center gap-2 disabled:opacity-50"
            >
                {copyLoading ? <ClipboardCheck size={20} /> : <Save size={20} />}
                {loading ? 'Guardando...' : 'Guardar Documento'}
            </button>
        </div>

      </form>
    </div>
  );
}