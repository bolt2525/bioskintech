export default function AppFooter({ theme = 'light' }: { theme?: 'dark' | 'light' }) {
  const isDark = theme === 'dark';
  return (
    <footer className={`border-t ${isDark ? 'border-gray-700/60' : 'border-[#deb887]/25'} py-5`}>
      <p className={`text-center text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
        BioSkinTech © {new Date().getFullYear()} · Panel Administrativo ·{' '}
        <a
          href="/politica-de-privacidad"
          target="_blank"
          rel="noopener noreferrer"
          className={isDark ? 'text-amber-200 hover:text-amber-100 hover:underline transition-colors' : 'text-[#76512f] hover:text-[#5f4025] hover:underline transition-colors'}
        >
          Política de Privacidad
        </a>
        {' '}·{' '}
        <a
          href="/condiciones-de-servicio"
          target="_blank"
          rel="noopener noreferrer"
          className={isDark ? 'text-amber-200 hover:text-amber-100 hover:underline transition-colors' : 'text-[#76512f] hover:text-[#5f4025] hover:underline transition-colors'}
        >
          Condiciones de Servicio
        </a>
      </p>
    </footer>
  );
}
