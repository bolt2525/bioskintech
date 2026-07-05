import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Zap } from 'lucide-react';
import { MedicalProtocols } from '../components/MedicalProtocols';

export default function AdminProtocols() {
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
    <div className='min-h-screen bg-gray-50'>
      <div className='bg-white shadow-sm'>
        <div className='container-custom py-4'>
          <div className='flex items-center gap-4'>
            <button 
              onClick={() => navigate('/admin')}
              className='p-2 hover:bg-gray-100 rounded-full transition-colors'
            >
              <ArrowLeft className='w-6 h-6 text-gray-600' />
            </button>
            <div>
              <h1 className='text-2xl font-bold text-gray-900 flex items-center gap-2'>
                <Zap className='w-8 h-8 text-[#deb887]' />
                Protocolos Clínicos IA
              </h1>
              <p className='text-gray-600'>Asistente inteligente especializado en aparatología médica estética</p>
            </div>
          </div>
        </div>
      </div>

      <div className='container-custom py-8'>
        <MedicalProtocols />
      </div>
    </div>
  );
}
