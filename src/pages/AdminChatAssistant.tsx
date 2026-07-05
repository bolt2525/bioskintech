import React, { useState, useEffect, useRef } from 'react';
import { Send, Copy, RefreshCw, MessageSquare, UserPlus, Trash2, Sparkles, Bot, History, X, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface Conversation {
  session_id: string;
  last_message_at: string;
  total_messages: number;
  user_info: { isNewPatient: boolean };
}

export default function AdminChatAssistant() {
  const { isAuthenticated, checkAuth } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [isNewPatient, setIsNewPatient] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const verifyAuth = async () => {
      const authenticated = await checkAuth();
      if (!authenticated) {
        navigate('/admin/login');
      }
    };
    verifyAuth();
    startNewSession();
    fetchConversations();
  }, [checkAuth, navigate]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchConversations = async () => {
    try {
      const res = await fetch('/api/internal-bot-api?type=internal-chat&action=list');
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch (error) {
      console.error('Error fetching conversations:', error);
    }
  };

  const loadConversation = async (sid: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/internal-bot-api?type=internal-chat&action=get&sessionId=${sid}`);
      if (res.ok) {
        const data = await res.json();
        const loadedMessages = data.messages.map((m: any, idx: number) => ({
          id: `hist_${idx}`,
          role: m.role === 'model' ? 'assistant' : m.role, // Map model to assistant
          content: m.content,
          timestamp: new Date(m.timestamp)
        }));
        setSessionId(sid);
        setMessages(loadedMessages);
        setShowHistory(false);
      }
    } catch (error) {
      console.error('Error loading conversation:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteConversation = async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation();
    if (!confirm('¿Estás seguro de eliminar este chat?')) return;
    
    try {
      const res = await fetch(`/api/internal-bot-api?type=internal-chat&sessionId=${sid}`, { method: 'DELETE' });
      if (res.ok) {
        setConversations(prev => prev.filter(c => c.session_id !== sid));
        if (sessionId === sid) startNewSession();
      }
    } catch (error) {
      console.error('Error deleting conversation:', error);
    }
  };

  const startNewSession = () => {
    const newSessionId = `internal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    setSessionId(newSessionId);
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: 'Hola Dra. Daniela. Soy Gema, tu asistente virtual. Pega aquí la consulta del paciente y te ayudaré a redactar la respuesta ideal. ✨',
      timestamp: new Date()
    }]);
    setIsNewPatient(false);
    setShowHistory(false);
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/internal-bot-api?type=internal-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg.content,
          sessionId: sessionId,
          isNewSession: messages.length === 1, // Only welcome message exists
          isNewPatient: isNewPatient
        })
      });

      let errorMessage = 'Error en la respuesta';
      if (!response.ok) {
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (e) {
          // Could not parse JSON error, stick with default
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response,
        timestamp: new Date()
      };

      setMessages(prev => [...prev, aiMsg]);
      fetchConversations(); // Refresh list
    } catch (error: any) {
      console.error('Error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Lo siento, hubo un error al procesar tu mensaje: ${error.message || 'Error desconocido'}. Por favor intenta de nuevo.`,
        timestamp: new Date()
      }]);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add a toast notification here
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col relative">
      {/* Sidebar Overlay */}
      {showHistory && (
        <div className="absolute inset-0 bg-black/20 z-20" onClick={() => setShowHistory(false)} />
      )}
      
      {/* History Sidebar */}
      <div className={`absolute top-0 left-0 h-full w-80 bg-white shadow-2xl z-30 transform transition-transform duration-300 ${showHistory ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-[#deb887]/10">
          <h2 className="font-bold text-gray-800 flex items-center gap-2">
            <History className="w-5 h-5 text-[#deb887]" />
            Historial de Chats
          </h2>
          <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-gray-200 rounded-full">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="overflow-y-auto h-[calc(100%-60px)] p-2 space-y-2">
          {conversations.length === 0 ? (
            <div className="text-center text-gray-400 py-8 text-sm">No hay chats recientes</div>
          ) : (
            conversations.map(chat => (
              <div 
                key={chat.session_id}
                onClick={() => loadConversation(chat.session_id)}
                className={`p-3 rounded-lg cursor-pointer border transition-all group relative ${
                  sessionId === chat.session_id 
                    ? 'bg-[#deb887]/10 border-[#deb887] shadow-sm' 
                    : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-gray-200'
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-bold text-gray-500">
                    {new Date(chat.last_message_at).toLocaleDateString()}
                  </span>
                  <button 
                    onClick={(e) => deleteConversation(e, chat.session_id)}
                    className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-sm text-gray-700 font-medium truncate">
                  Chat {chat.session_id.split('_')[2]}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    chat.user_info?.isNewPatient 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-blue-100 text-blue-700'
                  }`}>
                    {chat.user_info?.isNewPatient ? 'Nuevo' : 'Recurrente'}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {chat.total_messages} msgs
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200 p-4 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => navigate('/admin')}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors mr-2"
              title="Volver al Panel"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <button 
              onClick={() => setShowHistory(true)}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="Ver historial"
            >
              <History className="w-6 h-6" />
            </button>
            <div className="bg-gradient-to-br from-[#deb887] to-[#d4a574] p-2 rounded-lg text-white">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">Gema - Asistente Virtual</h1>
              <p className="text-xs text-gray-500">Redacción de respuestas para pacientes</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsNewPatient(!isNewPatient)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                isNewPatient 
                  ? 'bg-green-100 text-green-700 border border-green-200' 
                  : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
              }`}
            >
              <UserPlus className="w-4 h-4" />
              {isNewPatient ? 'Nuevo Paciente' : 'Paciente Recurrente'}
            </button>

            <button
              onClick={startNewSession}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium shadow-sm"
            >
              <RefreshCw className="w-4 h-4" />
              Nuevo Chat
            </button>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#deb887] to-[#d4a574] flex items-center justify-center text-white shrink-0 mt-1">
                  <Sparkles className="w-4 h-4" />
                </div>
              )}
              
              <div className={`max-w-[80%] group relative ${
                msg.role === 'user' 
                  ? 'bg-gray-800 text-white rounded-2xl rounded-tr-sm' 
                  : 'bg-white border border-gray-200 text-gray-800 rounded-2xl rounded-tl-sm shadow-sm'
              } p-4`}>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {msg.content}
                </div>
                
                {msg.role === 'assistant' && (
                  <button
                    onClick={() => copyToClipboard(msg.content)}
                    className="absolute -bottom-6 right-0 text-gray-400 hover:text-[#deb887] text-xs flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                  >
                    <Copy className="w-3 h-3" />
                    Copiar respuesta
                  </button>
                )}
              </div>

              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 shrink-0 mt-1">
                  <MessageSquare className="w-4 h-4" />
                </div>
              )}
            </div>
          ))}
          
          {loading && (
            <div className="flex gap-4 justify-start">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#deb887] to-[#d4a574] flex items-center justify-center text-white shrink-0">
                <Sparkles className="w-4 h-4 animate-pulse" />
              </div>
              <div className="bg-white border border-gray-200 p-4 rounded-2xl rounded-tl-sm shadow-sm flex items-center gap-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 p-4">
        <div className="max-w-4xl mx-auto">
          <form onSubmit={handleSend} className="relative flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Pega aquí el mensaje del paciente..."
              className="w-full p-4 pr-12 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent resize-none max-h-32 min-h-[60px] custom-scrollbar"
              rows={1}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="absolute right-2 bottom-2 p-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
          <p className="text-center text-xs text-gray-400 mt-2">
            Gema puede cometer errores. Revisa la respuesta antes de enviarla.
          </p>
        </div>
      </div>
    </div>
  );
}
