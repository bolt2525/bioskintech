import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import CalendarManager from '../components/CalendarManager';

export default function AdminCalendarManager() {
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

  const handleBack = () => {
    navigate('/admin');
  };

  if (!isAuthenticated) {
    return null;
  }

  return <CalendarManager onBack={handleBack} />;
}
