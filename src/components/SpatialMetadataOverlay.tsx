/**
 * SpatialMetadataOverlay.tsx
 * --------------------------
 * Renders a top-down 360° object-audio polar diagram showing per-object
 * azimuth, elevation (encoded as dot size), and gain (encoded as opacity).
 *
 * Also shows a compact table of object positions below the polar plot.
 *
 * Props:
 *   spatialMeta   SpatialMetadata from useSpatialMetadata()
 *   className     optional extra class
 */

import React from 'react';
import type { SpatialMetadata, ObjectAudioPosition } from '../lib/useSpatialMetadata';

interface Props {
  spatialMeta: SpatialMetadata;
  className?: string;
}

// Colours for up to 28 objects
const OBJ_COLORS = [
  '#f43f5e','#f97316','#eab308','#22c55e','#06b6d4','#6366f1',
  '#a855f7','#ec4899','#14b8a6','#84cc16','#f59e0b','#3b82f6',
  '#10b981','#8b5cf6','#ef4444','#0ea5e9','#d946ef','#64748b',
  '#fb923c','#4ade80','#facc15','#38bdf8','#c084fc','#fb7185',
  '#a3e635','#34d399','#67e8f9','#818cf8',
];

function polarToXY(azDeg: number, r: number, cx: number, cy: number) {
  // azimuth: 0=front(top), +90=right, -90=left, ±180=back
  const rad = ((azDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

export default function SpatialMetadataOverlay({ spatialMeta, className = '' }: Props) {
  const { objects } = spatialMeta;
  if (!objects || objects.length === 0) return null;

  const SIZE = 220;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R  = SIZE / 2 - 16;

  return (
    <div className={`rounded-xl border bg-card p-4 space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <span>🎯</span> Spatial Object Positions
          <span className="text-xs font-normal text-muted-foreground ml-1">
            (MPEG-H OAM)
          </span>
        </h3>
        <span className="text-xs text-muted-foreground">
          {objects.length} object{objects.length !== 1 ? 's' : ''}
          {spatialMeta.hasHOA ? ' · HOA' : ''}
          {spatialMeta.hasBinaural ? ' · Binaural' : ''}
        </span>
      </div>

      {/* Polar diagram */}
      <div className="flex justify-center">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}
             className="overflow-visible">
          {/* Rings */}
          {[1, 0.67, 0.33].map((f, i) => (
            <circle key={i} cx={CX} cy={CY} r={R * f}
              fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
          ))}
          {/* Axes */}
          <line x1={CX} y1={CY - R - 4} x2={CX} y2={CY + R + 4}
                stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
          <line x1={CX - R - 4} y1={CY} x2={CX + R + 4} y2={CY}
                stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
          {/* Cardinal labels */}
          <text x={CX} y={CY - R - 6} textAnchor="middle" fontSize={9}
                fill="currentColor" opacity={0.5}>FRONT</text>
          <text x={CX} y={CY + R + 14} textAnchor="middle" fontSize={9}
                fill="currentColor" opacity={0.5}>BACK</text>
          <text x={CX + R + 5} y={CY + 4} textAnchor="start" fontSize={9}
                fill="currentColor" opacity={0.5}>R</text>
          <text x={CX - R - 5} y={CY + 4} textAnchor="end" fontSize={9}
                fill="currentColor" opacity={0.5}>L</text>

          {/* Object dots */}
          {objects.map((obj) => {
            const { x, y } = polarToXY(obj.azimuth, R * Math.max(0.05, 1 - Math.abs(obj.elevation) / 90), CX, CY);
            const color   = OBJ_COLORS[obj.objectIdx % OBJ_COLORS.length];
            // Dot size encodes elevation: larger = higher up
            const dotR    = 5 + (obj.elevation / 90) * 4;
            const opacity = 0.4 + obj.gain * 0.6;

            return (
              <g key={obj.objectIdx}>
                <circle cx={x} cy={y} r={Math.max(3, dotR)}
                  fill={color} opacity={opacity} />
                <text x={x} y={y - Math.max(3, dotR) - 2}
                  textAnchor="middle" fontSize={8} fill={color} opacity={0.85}>
                  {obj.objectIdx + 1}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend hint */}
      <p className="text-center text-xs text-muted-foreground -mt-1">
        Dot size = elevation · Opacity = gain · Number = object index
      </p>

      {/* Compact table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="text-left pb-1 pr-2">#</th>
              <th className="text-right pb-1 pr-2">Azimuth</th>
              <th className="text-right pb-1 pr-2">Elevation</th>
              <th className="text-right pb-1">Gain</th>
            </tr>
          </thead>
          <tbody>
            {objects.map((obj) => (
              <tr key={obj.objectIdx} className="border-b border-border/40">
                <td className="py-0.5 pr-2">
                  <span className="inline-block w-2 h-2 rounded-full mr-1"
                        style={{ backgroundColor: OBJ_COLORS[obj.objectIdx % OBJ_COLORS.length] }} />
                  {obj.objectIdx + 1}
                </td>
                <td className="text-right pr-2 font-mono">{obj.azimuth}°</td>
                <td className="text-right pr-2 font-mono">{obj.elevation}°</td>
                <td className="text-right font-mono">{(obj.gain * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
