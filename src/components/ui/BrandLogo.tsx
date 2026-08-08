import { useState } from 'react';

interface Props {
  className?: string;
  compact?: boolean;
}

export default function BrandLogo({ className = 'h-24 w-auto object-contain mx-auto', compact = false }: Props) {
  const [err, setErr] = useState(false);

  if (!err) {
    return <img src="/images/logo/logo.png" alt="BIOSKINTECH" className={className} onError={() => setErr(true)} />;
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-[#deb887] rounded-lg flex items-center justify-center flex-shrink-0 shadow">
          <span className="text-white font-bold text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>B</span>
        </div>
        <span className="font-bold text-gray-900 text-sm" style={{ fontFamily: 'Playfair Display, serif' }}>BioSkinTech</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1 mx-auto">
      <div className="w-16 h-16 bg-[#deb887] rounded-2xl flex items-center justify-center shadow-lg shadow-[#deb887]/30">
        <span className="text-white font-bold text-3xl" style={{ fontFamily: 'Playfair Display, serif' }}>B</span>
      </div>
      <span className="text-gray-900 font-bold text-2xl mt-1" style={{ fontFamily: 'Playfair Display, serif' }}>BioSkinTech</span>
    </div>
  );
}
