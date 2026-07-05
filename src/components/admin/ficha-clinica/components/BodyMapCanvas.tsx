import React, { useState, useRef } from 'react';
import { Tooltip } from '../../../ui/Tooltip';
import { X } from 'lucide-react';
import { Mark } from './FaceMapCanvas';

interface BodyMapCanvasProps {
  marks: Mark[];
  onAddMark: (mark: Omit<Mark, 'id'>) => void;
  onRemoveMark: (id: string) => void;
  readOnly?: boolean;
  selectedCategory?: string;
}

const BodyMapCanvas: React.FC<BodyMapCanvasProps> = ({ 
  marks, 
  onAddMark, 
  onRemoveMark, 
  readOnly = false,
  selectedCategory 
}) => {
  const [view, setView] = useState<'front' | 'back'>('front');
  const imageRef = useRef<HTMLImageElement>(null);

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || !imageRef.current || !selectedCategory) return;

    const rect = imageRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    // Ensure coordinates are within bounds (0-100)
    const boundedX = Math.max(0, Math.min(100, x));
    const boundedY = Math.max(0, Math.min(100, y));

    onAddMark({
      x: boundedX,
      y: boundedY,
      category: selectedCategory,
      view: view,
      notes: view === 'front' ? 'Anterior' : 'Posterior'
    });
  };

  return (
    <div className="flex flex-col items-center space-y-4 w-full relative">
      {/* View Switcher - Sticky Header */}
      <div className="sticky top-0 z-50 flex items-center gap-3 bg-white/95 backdrop-blur-sm p-3 rounded-xl border border-gray-200 shadow-md mb-4 transition-all hover:shadow-lg">
        <span className="text-sm font-bold text-gray-700 px-2 uppercase tracking-wide">Vista del Cuerpo:</span>
        <div className="flex bg-gray-100 p-1.5 rounded-lg">
          <button
            type="button"
            onClick={() => setView('front')}
            className={`px-6 py-2.5 rounded-md text-sm font-black tracking-wider transition-all duration-200 ${
              view === 'front'
                ? 'bg-[#deb887] text-white shadow-md transform scale-105'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
            }`}
          >
            FRONTAL
          </button>
          <button
            type="button"
            onClick={() => setView('back')}
            className={`px-6 py-2.5 rounded-md text-sm font-black tracking-wider transition-all duration-200 ${
              view === 'back'
                ? 'bg-[#deb887] text-white shadow-md transform scale-105'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
            }`}
          >
            POSTERIOR
          </button>
        </div>
      </div>

      {/* Image Container */}
      <div className="relative inline-block border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm">
        <div 
          className={`relative ${readOnly ? 'cursor-default' : selectedCategory ? 'cursor-crosshair' : 'cursor-not-allowed'}`}
          onClick={handleImageClick}
        >
          <img
            ref={imageRef}
            src={view === 'front' ? '/images/clinical/body_front.png' : '/images/clinical/body_back.png'}
            alt={`Mapa Corporal ${view === 'front' ? 'Frontal' : 'Posterior'}`}
            className="max-h-[500px] w-full object-contain block"
            draggable={false}
          />

          {/* Marks Overlay */}
          {marks
            .filter(m => m.view === view)
            .map((mark) => (
              <div
                key={mark.id}
                className="absolute -ml-2 -mt-2 z-10 group"
                style={{ left: `${mark.x}%`, top: `${mark.y}%` }}
              >
                <Tooltip
                  content={
                    <div className="flex flex-col items-center">
                      <span className="font-bold">{mark.category}</span>
                      {mark.severity && <span className="text-[10px] text-yellow-200 font-semibold uppercase">{mark.severity}</span>}
                    </div>
                  }
                  className="w-4 h-4 bg-red-500 rounded-full border-2 border-white shadow-sm transform transition-transform hover:scale-125 block"
                >
                  {/* Delete Button (only if not readOnly) */}
                  {!readOnly && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveMark(mark.id);
                      }}
                      className="absolute -top-4 -right-4 bg-white rounded-full p-0.5 shadow-md hover:bg-red-50 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={12} />
                    </button>
                  )}
                </Tooltip>
              </div>
            ))}
        </div>
      </div>
      
      <p className="text-sm text-gray-500 italic">
        {readOnly 
          ? 'Vista de solo lectura' 
          : selectedCategory 
            ? 'Haga clic en la imagen para agregar un marcador' 
            : 'Seleccione una lesión arriba para marcar'}
      </p>
    </div>
  );
};

export default BodyMapCanvas;