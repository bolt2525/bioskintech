
import React, { useState, useRef, useMemo } from 'react';
import { Tooltip } from '../../../ui/Tooltip';
import { X } from 'lucide-react';
import faceZonesData from '../../../../data/face-zones.json';

export interface Mark {
  id: string;
  x: number; // percentage 0-100 (legacy 2D) — 0 for 3D marks
  y: number; // percentage 0-100 (legacy 2D) — 0 for 3D marks
  z?: number; // Not used in 2D
  category: string;
  notes?: string; // Used for Zone Label
  view?: 'front' | 'back'; // For Body Map
  distribution?: 'puntual' | 'zonal';
  severity?: 'leve' | 'moderado' | 'severo' | 'profundo';
  // 3D fields (used when is3D === true)
  is3D?: boolean;
  position3D?: { x: number; y: number; z: number };
  normal3D?: { x: number; y: number; z: number };
  rotation3D?: number[];
  tercio?: string;
}

interface FaceMapCanvasProps {
  marks: Mark[];
  onAddMark: (mark: Omit<Mark, 'id'>) => void;
  onRemoveMark: (id: string) => void;
  readOnly?: boolean;
  selectedCategory?: string;
}

export default function FaceMapCanvas({ 
  marks, 
  onAddMark, 
  onRemoveMark, 
  readOnly = false,
  selectedCategory 
}: FaceMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverZone, setHoverZone] = useState<string | null>(null);

  // Process zones for rendering
  const zones = useMemo(() => {
    // @ts-ignore
    return Object.entries(faceZonesData.zones).flatMap(([key, shapes]) => 
      // @ts-ignore
      shapes.map((shape: any, index) => ({
        id: `${key}-${index}`,
        label: shape.label,
        ...shape
      }))
    );
  }, []);

  const handleZoneClick = (e: React.MouseEvent, zoneLabel: string) => {
    if (readOnly) return;
    e.stopPropagation(); // Prevent container click

    if (!selectedCategory) {
      alert("Por favor seleccione una categoría primero (tipo de lesión)");
      return;
    }

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    onAddMark({
      x,
      y,
      category: selectedCategory,
      notes: zoneLabel
    });
  };

  const handleContainerClick = (e: React.MouseEvent) => {
    if (readOnly || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (!selectedCategory) {
      alert("Por favor seleccione una categoría primero");
      return;
    }

    onAddMark({
      x,
      y,
      category: selectedCategory,
      notes: 'Zona general'
    });
  };

  return (
    <div className="relative w-full max-w-[450px] h-[500px] bg-white border border-gray-200 rounded-lg overflow-y-auto select-none shadow-sm">
      {/* Map Container */}
      <div 
        ref={containerRef}
        className={`relative w-full ${!readOnly ? 'cursor-crosshair' : ''}`}
        onClick={handleContainerClick}
      >
        {/* Background Image */}
        <img 
          src="/images/clinical/face_map.png" 
          alt="Mapa Facial" 
          className="w-full h-auto block pointer-events-none"
          draggable={false}
          onError={(e) => {
            // Fallback if image not found
            e.currentTarget.style.display = 'none';
          }}
        />

        {/* SVG Layer for Zones */}
        <svg 
          viewBox="0 0 1 1" 
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }} // Let clicks pass through to elements
        >
          {/* Draw Zones */}
          {zones.map((zone) => {
            const isHovered = hoverZone === zone.id;
            const commonProps = {
              key: zone.id,
              className: `transition-all duration-200 ${!readOnly ? 'cursor-pointer pointer-events-auto' : ''}`,
              // Make fill transparent normally, slightly visible on hover
              fill: isHovered ? 'rgba(222, 184, 135, 0.4)' : 'rgba(255, 255, 255, 0.01)', 
              stroke: isHovered ? '#deb887' : 'rgba(255, 255, 255, 0.0)', // Hide stroke normally to see image
              strokeWidth: 0.003,
              onMouseEnter: () => !readOnly && setHoverZone(zone.id),
              onMouseLeave: () => !readOnly && setHoverZone(null),
              onClick: (e: React.MouseEvent) => handleZoneClick(e, zone.label)
            };

            if (zone.kind === 'rect') {
              const [x1, y1, x2, y2] = zone.bbox;
              return (
                <rect
                  x={x1}
                  y={y1}
                  width={x2 - x1}
                  height={y2 - y1}
                  {...commonProps}
                />
              );
            } else if (zone.kind === 'ellipse') {
              const [x1, y1, x2, y2] = zone.bbox;
              const cx = (x1 + x2) / 2;
              const cy = (y1 + y2) / 2;
              const rx = (x2 - x1) / 2;
              const ry = (y2 - y1) / 2;
              return (
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={rx}
                  ry={ry}
                  {...commonProps}
                />
              );
            } else if (zone.kind === 'poly') {
              const pointsStr = zone.points.map((p: number[]) => p.join(',')).join(' ');
              return (
                <polygon
                  points={pointsStr}
                  {...commonProps}
                />
              );
            }
            return null;
          })}
        </svg>

        {/* Hover Label */}
        {hoverZone && !readOnly && (
          <div className="absolute top-2 left-1/2 transform -translate-x-1/2 bg-black/75 text-white text-xs px-2 py-1 rounded pointer-events-none z-20">
            {zones.find(z => z.id === hoverZone)?.label}
          </div>
        )}

        {/* Marks */}
        {marks.map((mark) => (
          <div
            key={mark.id}
            className="absolute transform -translate-x-1/2 -translate-y-1/2 group z-10"
            style={{ left: `${mark.x}%`, top: `${mark.y}%` }}
          >
            <Tooltip
              interactive={!readOnly}
              content={
                <div 
                  className={`flex flex-col items-center ${!readOnly ? 'cursor-pointer' : ''}`}
                  onClick={(e) => {
                    if (!readOnly) {
                      e.stopPropagation();
                      onRemoveMark(mark.id);
                    }
                  }}
                >
                  <span className="font-bold">{mark.category}</span>
                  <span className="text-[10px] opacity-80">{mark.notes}</span>
                  {mark.severity && <span className="text-[10px] text-yellow-200 font-semibold uppercase">{mark.severity}</span>}
                  {!readOnly && (
                    <div className="flex items-center gap-1 mt-1 text-red-300">
                      <X size={10} /> Eliminar
                    </div>
                  )}
                </div>
              }
            >
              <div className="w-4 h-4 bg-red-500 rounded-full border-2 border-white shadow-sm hover:scale-125 transition-transform cursor-pointer flex items-center justify-center">
              </div>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}
