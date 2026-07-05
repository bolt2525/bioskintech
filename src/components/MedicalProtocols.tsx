import React, { useState, useRef, useEffect } from 'react';
import { geminiClient } from '../lib/gemini-client';
import { Send, Bot, User, Loader2, Zap } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export const MedicalProtocols = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'Hola. Soy tu asistente clínico especializado en aparatología estética. Puedo brindarte protocolos detallados para Nd:YAG, CO2, IPL, HIFU, Radiofrecuencia y más. ¿Qué tratamiento deseas consultar hoy?',
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await geminiClient.askProtocol(userMessage.content);
      
      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: new Date()
      };
      
      setMessages(prev => [...prev, botMessage]);
    } catch (error: any) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error.message || "No se pudo conectar con el servidor."}.`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl overflow-hidden border border-[#deb887]/20 max-w-4xl mx-auto my-12 flex flex-col h-[600px]">
      {/* Header */}
      <div className="bg-[#deb887] p-4 text-white flex justify-between items-center shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-white/20 p-2 rounded-lg">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-serif font-bold">Protocolos Clínicos IA</h2>
            <p className="text-xs text-white/80">Especialista en Aparatología (Nd:YAG, CO2, IPL...)</p>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50 custom-scrollbar">
        {messages.map((msg) => (
          <div 
            key={msg.id} 
            className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              msg.role === 'user' ? 'bg-gray-800 text-white' : 'bg-[#deb887] text-white'
            }`}>
              {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </div>
            
            <div className={`max-w-[80%] rounded-2xl p-4 shadow-sm ${
              msg.role === 'user' 
                ? 'bg-white text-gray-800 rounded-tr-none border border-gray-100' 
                : 'bg-white text-gray-800 rounded-tl-none border border-[#deb887]/20'
            }`}>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              <span className="text-[10px] text-gray-400 mt-2 block">
                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-[#deb887] text-white flex items-center justify-center shrink-0">
              <Bot size={16} />
            </div>
            <div className="bg-white rounded-2xl rounded-tl-none p-4 shadow-sm border border-[#deb887]/20 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-[#deb887]" />
              <span className="text-xs text-gray-500">Generando protocolo...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 bg-white border-t border-gray-100">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Pregunta sobre un protocolo (ej: Parámetros para depilación láser en fototipo IV)..."
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#deb887] focus:ring-1 focus:ring-[#deb887] transition-all"
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-[#deb887] text-white p-3 rounded-xl hover:bg-[#c5a075] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg"
          >
            <Send size={20} />
          </button>
        </div>
        <p className="text-[10px] text-center text-gray-400 mt-2">
          * La IA puede cometer errores. Verifica siempre los parámetros con las guías oficiales del fabricante.
        </p>
      </div>
    </div>
  );
};
