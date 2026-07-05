import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Brain } from 'lucide-react';
import { AIDiagnosis } from '../components/AIDiagnosis';

export default function AdminDiagnosis() {
  const navigate = useNavigate();
  const { isAuthenticated, checkAuth } = useAuth();

  useEffect(() => {
    const verifyAuth = async () => {
      const authenticated = await checkAuth();
      if (!authenticated) {
        navigate('/admin/login');
      }
    };
    verifyAuth();
  }, [checkAuth, navigate]);

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow-sm">
        <div className="container-custom py-4">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => navigate('/admin')}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            >
              <ArrowLeft className="w-6 h-6 text-gray-600" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                <Brain className="w-8 h-8 text-[#deb887]" />
                Diagnóstico IA
              </h1>
              <p className="text-gray-600">Herramienta de análisis dermatológico asistido por IA</p>
            </div>
          </div>
        </div>
      </div>

      <div className="container-custom py-8">
        <div className="bg-white rounded-2xl shadow-xl p-6 md:p-8">
          <AIDiagnosis />
        </div>
      </div>
    </div>
  );
}
