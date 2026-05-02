/**
 * MpeghDecoderDialog.tsx
 * ----------------------
 * Modal dialog shown when the user uploads a Sony 360 Reality Audio /
 * MPEG-H 3D Audio file (mha1, mhm1, mhas).  Lets them choose between:
 *
 *   • Ittiam libmpegh WASM  — fast, already bundled, great for all-channel PCM
 *   • Fraunhofer FDK WASM   — reference quality, full DRC control, 24ch support
 *
 * Props:
 *   open         — controls visibility
 *   fileName     — filename shown in the dialog
 *   channels     — native channel count from tag parser (e.g. 24)
 *   onSelect     — callback with 'ittiam' | 'fraunhofer'
 *   onCancel     — close without decoding
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export type MpeghDecoderChoice = 'ittiam' | 'fraunhofer';

interface MpeghDecoderDialogProps {
  open: boolean;
  fileName: string;
  channels: number;
  sampleRate: number;
  onSelect: (choice: MpeghDecoderChoice) => void;
  onCancel: () => void;
}

const decoders = [
  {
    id: 'ittiam' as MpeghDecoderChoice,
    name: 'Ittiam libmpegh',
    badge: 'Built-in',
    badgeVariant: 'secondary' as const,
    description:
      'Open-source MPEG-H decoder by Ittiam Systems / Dolby. Pre-loaded — no extra download. Decodes all channels at full sample rate.',
    pros: ['✓ Instant — no extra load', '✓ All channels preserved', '✓ .mhas + .m4a support'],
    cons: ['• No DRC / loudness control', '• No interactive scene metadata'],
    logo: '⚡',
  },
  {
    id: 'fraunhofer' as MpeghDecoderChoice,
    name: 'Fraunhofer FDK',
    badge: 'Reference',
    badgeVariant: 'default' as const,
    description:
      'The official ISO/IEC 23008-3 reference implementation by Fraunhofer IIS — the inventors of MPEG-H. Full DRC, loudness normalization, and scene control.',
    pros: [
      '✓ Reference-quality decoding',
      '✓ Full DRC / loudness normalization',
      '✓ All channels (1–24+)',
      '✓ Object metadata (azimuth/elevation)',
    ],
    cons: ['• Requires additional ~3 MB WASM load'],
    logo: '🏆',
  },
];

export default function MpeghDecoderDialog({
  open,
  fileName,
  channels,
  sampleRate,
  onSelect,
  onCancel,
}: MpeghDecoderDialogProps) {
  const [selected, setSelected] = React.useState<MpeghDecoderChoice>('ittiam');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            Sony 360 Reality Audio / MPEG-H 3D Audio
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{fileName}</span>
            {' '}—{' '}
            {channels > 0
              ? `${channels}ch · ${(sampleRate / 1000).toFixed(1)} kHz · MPEG-H 3D Audio`
              : `Object-based · ${(sampleRate / 1000).toFixed(1)} kHz · MPEG-H 3D Audio (channel count determined at decode)`
            }
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm font-medium text-muted-foreground mb-2">
          Select which WASM decoder to use:
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {decoders.map((dec) => (
            <button
              key={dec.id}
              onClick={() => setSelected(dec.id)}
              className={`text-left rounded-lg border-2 p-4 transition-all cursor-pointer
                ${selected === dec.id
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-primary/50 hover:bg-muted/40'
                }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-sm">{dec.name}</span>
                <Badge variant={dec.badgeVariant} className="ml-auto text-xs">
                  {dec.badge}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{dec.description}</p>
              <ul className="space-y-0.5">
                {dec.pros.map((p, i) => (
                  <li key={i} className="text-xs text-green-600 dark:text-green-400">{p}</li>
                ))}
                {dec.cons.map((c, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{c}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>

        {channels > 8 && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mt-1">
            ⚠️ This file has <strong>{channels} channels</strong> — both decoders will preserve all channels without downsampling or mixing.
          </div>
        )}
        {channels === 0 && (
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-800 dark:text-blue-300 mt-1">
            ℹ️ This is an <strong>object-based</strong> 360 Reality Audio file. The exact channel count (e.g. 12, 22, or 24 objects) will be shown after decoding — both decoders preserve every object at full quality.
          </div>
        )}

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} className="cursor-pointer">
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSelect(selected)} className="cursor-pointer">
            Decode with {selected === 'ittiam' ? 'Ittiam libmpegh' : 'Fraunhofer FDK'} →
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
