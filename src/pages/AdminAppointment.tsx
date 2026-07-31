import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAdminNav } from '../hooks/useAdminNav';
import AdminAppointmentComponent from '../components/AdminAppointment';

export default function AdminAppointment() {
  const navigate = useNavigate();
  const { isAuthenticated, checkAuth } = useAuth();
  const { nav } = useAdminNav();

  useEffect(() => {
    const verifyAuth = async () => {
      const authenticated = await checkAuth();
      if (!authenticated) {
        navigate('/admin/login');
      }
    };
    verifyAuth();
  }, [checkAuth, navigate]);

  const handleBack = () => nav('');

  if (!isAuthenticated) {
    return null;
  }

  return <AdminAppointmentComponent onBack={handleBack} />;
}
