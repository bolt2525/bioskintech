import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, FileText, Settings, Clipboard, Eye, Edit, Copy, Folder, FolderOpen, ChevronDown, ChevronRight, Handshake } from 'lucide-react';

interface TechnicalDocument {
  id: number;
  ticket_number: string;
  document_type: string;
  client_name: string;
  client_contact?: string;
  status: string;
  created_at: string;
  updated_at?: string;
}

export default function TechnicalDashboard() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<TechnicalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedClients, setExpandedClients] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchDocuments();
  }, [filterType]);

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      let url = '/api/technical-service';
      const params = new URLSearchParams();
      if (filterType !== 'all') params.append('type', filterType);
      if (searchTerm) params.append('search', searchTerm);
      
      if (params.toString()) url += `?${params.toString()}`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setDocuments(data);
        const initialExpanded: Record<string, boolean> = {};
        data.forEach((doc: TechnicalDocument) => {
          const key = doc.client_name || 'Sin cliente';
          if (!(key in initialExpanded)) initialExpanded[key] = true;
        });
        setExpandedClients((prev) => ({ ...initialExpanded, ...prev }));
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchDocuments();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'draft': return 'bg-orange-100 text-orange-800';
      case 'completed': return 'bg-green-100 text-green-800';
      case 'in_progress': return 'bg-yellow-100 text-yellow-800';
      case 'delivered': return 'bg-blue-100 text-blue-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'draft': return 'Borrador';
      case 'completed': return 'Finalizado';
      case 'in_progress': return 'En Revisión';
      case 'delivered': return 'Entregado';
      case 'pending': return 'Pendiente';
      default: return status;
    }
  };

  const getTypeName = (type: string) => {
    switch (type) {
      case 'reception': return 'Recepción';
      case 'delivery_receipt': return 'Acta Entrega/Recepción';
      case 'technical_report': return 'Informe Técnico';
      case 'proforma': return 'Proforma';
      default: return type;
    }
  };

  const groupedDocuments = useMemo(() => {
    return documents.reduce<Record<string, TechnicalDocument[]>>((acc, doc) => {
      const key = doc.client_name?.trim() || 'Sin cliente';
      if (!acc[key]) acc[key] = [];
      acc[key].push(doc);
      return acc;
    }, {});
  }, [documents]);

  const orderedClients = useMemo(() => {
    return Object.keys(groupedDocuments).sort((a, b) => a.localeCompare(b, 'es'));
  }, [groupedDocuments]);

  const toggleClientFolder = (client: string) => {
    setExpandedClients((prev) => ({ ...prev, [client]: !prev[client] }));
  };

  const copyDocumentToClient = async (doc: TechnicalDocument) => {
    const targetClient = window.prompt('¿A qué cliente deseas copiar este documento?', doc.client_name || '');
    if (targetClient === null) return;

    const normalizedClient = targetClient.trim();
    if (!normalizedClient) {
      window.alert('Debes ingresar un cliente destino para copiar.');
      return;
    }

    const targetContact = window.prompt('Contacto del cliente destino (opcional):', doc.client_contact || '');
    if (targetContact === null) return;

    try {
      const res = await fetch('/api/technical-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copy_from_id: doc.id,
          target_client_name: normalizedClient,
          target_client_contact: targetContact.trim(),
          status: 'draft'
        })
      });

      if (!res.ok) {
        window.alert('No se pudo copiar el documento.');
        return;
      }

      await fetchDocuments();
      window.alert('Documento copiado correctamente como borrador.');
    } catch (error) {
      console.error('Error copying technical document:', error);
      window.alert('Error de conexión al copiar documento.');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-serif text-[#b8860b]">Servicio Técnico BioskinTech</h1>
          <p className="text-gray-500 mt-2">Gestión de documentos técnicos y reparaciones</p>
        </div>
        <button
          onClick={() => navigate('/admin/technical/new')}
          className="bg-[#b8860b] text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-[#a0750a] transition-colors"
        >
          <Plus size={20} />
          Nuevo Documento
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
        <div className="flex flex-col md:flex-row gap-4 justify-between">
          <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0">
            {['all', 'reception', 'delivery_receipt', 'technical_report', 'proforma'].map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-4 py-2 rounded-lg capitalize whitespace-nowrap ${
                  filterType === type
                    ? 'bg-[#b8860b] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {type === 'all' ? 'Todos' : getTypeName(type)}
              </button>
            ))}
          </div>
          
          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              placeholder="Buscar por cliente o ticket..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg w-full md:w-64 focus:outline-none focus:ring-2 focus:ring-[#b8860b]/20 focus:border-[#b8860b]"
            />
            <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
          </form>
        </div>
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-500">
            Cargando documentos...
          </div>
        ) : documents.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-500">
            No se encontraron documentos
          </div>
        ) : (
          orderedClients.map((client) => {
            const clientDocs = groupedDocuments[client] || [];
            const isOpen = expandedClients[client] ?? true;
            const drafts = clientDocs.filter((doc) => doc.status === 'draft').length;
            const lastUpdate = clientDocs
              .map((doc) => doc.updated_at || doc.created_at)
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

            return (
              <div key={client} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                <button
                  onClick={() => toggleClientFolder(client)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isOpen ? <FolderOpen size={20} className="text-[#b8860b] shrink-0" /> : <Folder size={20} className="text-gray-500 shrink-0" />}
                    <div className="text-left min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{client}</p>
                      <p className="text-xs text-gray-500">
                        {clientDocs.length} documento(s) · {drafts} borrador(es)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-gray-500 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const first = clientDocs[0];
                        const params = new URLSearchParams({ client });
                        if (first?.client_contact) params.append('contact', first.client_contact);
                        navigate(`/admin/technical/new?${params.toString()}`);
                      }}
                      className="text-[#b8860b] hover:text-[#a0750a] font-medium"
                    >
                      Nuevo para este cliente
                    </button>
                    <span>Últ. actualización: {new Date(lastUpdate).toLocaleDateString()}</span>
                    {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  </div>
                </button>

                {isOpen && (
                  <div className="overflow-x-auto border-t border-gray-100">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="p-4 font-semibold text-gray-600">Ticket</th>
                          <th className="p-4 font-semibold text-gray-600">Tipo</th>
                          <th className="p-4 font-semibold text-gray-600">Creado</th>
                          <th className="p-4 font-semibold text-gray-600">Estado</th>
                          <th className="p-4 font-semibold text-gray-600 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {clientDocs.map((doc) => (
                          <tr key={doc.id} className="hover:bg-gray-50 transition-colors">
                            <td className="p-4 font-medium text-gray-900">#{doc.ticket_number}</td>
                            <td className="p-4">
                              <span className="flex items-center gap-2">
                                {doc.document_type === 'reception' && <Clipboard size={16} className="text-blue-500" />}
                                {doc.document_type === 'delivery_receipt' && <Handshake size={16} className="text-indigo-500" />}
                                {doc.document_type === 'technical_report' && <Settings size={16} className="text-purple-500" />}
                                {doc.document_type === 'proforma' && <FileText size={16} className="text-green-500" />}
                                {getTypeName(doc.document_type)}
                              </span>
                            </td>
                            <td className="p-4 text-gray-500">{new Date(doc.created_at).toLocaleDateString()}</td>
                            <td className="p-4">
                              <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(doc.status)}`}>
                                {getStatusLabel(doc.status)}
                              </span>
                            </td>
                            <td className="p-4 text-right">
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => navigate(`/admin/technical/view/${doc.id}`)}
                                  className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                  title="Ver / Imprimir"
                                >
                                  <Eye size={18} />
                                </button>
                                <button
                                  onClick={() => navigate(`/admin/technical/edit/${doc.id}`)}
                                  className="p-2 text-gray-400 hover:text-[#b8860b] hover:bg-yellow-50 rounded-lg transition-colors"
                                  title="Editar"
                                >
                                  <Edit size={18} />
                                </button>
                                <button
                                  onClick={() => copyDocumentToClient(doc)}
                                  className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                                  title="Copiar a otro cliente"
                                >
                                  <Copy size={18} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
