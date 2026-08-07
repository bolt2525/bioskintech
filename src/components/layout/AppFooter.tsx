export default function AppFooter({ theme = 'light' }: { theme?: 'dark' | 'light' }) {
  const isDark = theme === 'dark';
  return (
    <footer className={`border-t ${isDark ? 'border-gray-700/60' : 'border-[#deb887]/25'} py-5`}>
      <p className={`text-center text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
        BioSkinTech © {new Date().getFullYear()} · Panel Administrativo ·{' '}
        <a
          href="/politica-de-privacidad"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#deb887] hover:text-[#c9a96e] hover:underline transition-colors"
        >
          Política de Privacidad
        </a>
        {' '}·{' '}
        <a
          href="/condiciones-de-servicio"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#deb887] hover:text-[#c9a96e] hover:underline transition-colors"
        >
          Condiciones de Servicio
        </a>
      </p>
    </footer>
  );
}
