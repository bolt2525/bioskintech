/**
 * @file src/pages/BlogAdminPage.tsx
 * @description Página de administración del Blog con IA.
 * Usa el AuthContext del sistema multi-tenant (no el hook legacy).
 * Si el usuario no está autenticado, redirige a /admin/login.
 */

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BlogAdmin from '../components/BlogAdmin';
import BlogManagement from '../components/BlogManagement';

const BlogAdminPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();

  // Redirigir a login si no hay sesión activa
  useEffect(() => {
    if (!isAuthenticated) navigate('/admin/login');
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="container mx-auto px-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/admin')}
              className="p-2 hover:bg-gray-200 rounded-full transition-colors"
              aria-label="Volver al panel"
            >
              <ArrowLeft className="w-5 h-5 text-gray-600" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-gray-800">Blog Admin</h1>
              <p className="text-gray-500 text-sm">Gestión y generación de artículos con IA</p>
            </div>
          </div>
          <button
            onClick={() => { logout(); navigate('/admin/login'); }}
            className="flex items-center gap-2 px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Cerrar Sesión
          </button>
        </div>

        {/* Generador de blogs con IA */}
        <BlogAdmin />

        {/* Gestión de blogs existentes */}
        <div className="mt-8">
          <BlogManagement />
        </div>
      </div>
    </div>
  );
};

export default BlogAdminPage;