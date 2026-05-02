import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, Music2 } from "lucide-react";
import type { MediaInfo } from "@/lib/audioAnalysis";

// ─── Inline Lyrics Panel ──────────────────────────────────────────────────────
function LyricsPanel({ raw, preview }: { raw: string; preview: string }) {
  const [expanded, setExpanded] = useState(false);

  // Clean lyrics for display: strip LRC [mm:ss.xx] and word <mm:ss.xx> timestamps
  const cleanLine = (line: string) =>
    line
      .replace(/^\[(\d{1,2}):(\d{2}\.\d{2})\]/g, "")
      .replace(/<(\d{1,2}):(\d{2}\.\d{2})>/g, "")
      .trim();

  // Parse lines — split on " / " separator used in embedded lyrics
  const allLines = raw
    .split(/\s*\/\s*|\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Get timestamp from LRC line
  const getTimestamp = (line: string): string | null => {
    const m = line.match(/^\[(\d{1,2}):(\d{2}\.\d{2})\]/);
    return m ? `[${m[1]}:${m[2]}]` : null;
  };

  // Group lines by timestamp to show translations together
  const groupedLines: { ts: string | null; lines: string[] }[] = [];
  for (const line of allLines) {
    const ts = getTimestamp(line);
    const clean = cleanLine(line);
    if (!clean) continue;
    const last = groupedLines[groupedLines.length - 1];
    if (last && last.ts === ts) {
      last.lines.push(clean);
    } else {
      groupedLines.push({ ts, lines: [clean] });
    }
  }

  const displayLines = expanded ? groupedLines : groupedLines.slice(0, 6);

  return (
    <div className="w-full">
      {/* Preview when collapsed */}
      {!expanded && preview && (
        <p className="mb-1.5 text-[11px] font-mono text-muted-foreground/60 italic line-clamp-2">
          "{preview}..."
        </p>
      )}

      {/* Expanded lyrics */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="max-h-64 overflow-y-auto rounded border border-border/20 bg-black/30 p-3 mb-2">
              {displayLines.map((group, i) => (
                <div key={i} className="mb-1.5">
                  {group.ts && (
                    <span className="mr-2 text-[9px] font-mono text-muted-foreground/40">{group.ts}</span>
                  )}
                  {group.lines.map((line, j) => (
                    <span
                      key={j}
                      className={`block text-[11px] font-mono leading-relaxed ${
                        j === 0 ? "text-foreground/85" :
                        j === 1 ? "text-muted-foreground/65 italic" : // romanization
                        "text-muted-foreground/45 text-[10px]"         // translation
                      }`}
                    >
                      {line}
                    </span>
                  ))}
                </div>
              ))}
              {!expanded && groupedLines.length > 6 && (
                <p className="text-[10px] font-mono text-muted-foreground/40">
                  +{groupedLines.length - 6} more lines...
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 rounded border border-border/30 px-2 py-1 text-[10px] font-mono text-muted-foreground/70 hover:text-foreground/90 hover:border-border/50 transition-colors"
      >
        <Music2 className="h-3 w-3" />
        {expanded ? (
          <><ChevronUp className="h-3 w-3" /> Hide lyrics</>
        ) : (
          <><ChevronDown className="h-3 w-3" /> Show lyrics ({groupedLines.length} lines)</>
        )}
      </button>
    </div>
  );
}

interface MediaInfoPanelProps {
  info: MediaInfo;
}

function InfoRow({ label, value, highlight }: { label: string; value?: string; highlight?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 border-b border-border/25 py-1.5 last:border-0">
      <span className="mono-text shrink-0 text-xs text-muted-foreground/75">{label}</span>
      <span className={`mono-text text-right text-xs break-all ${highlight ? "text-[#2FE0DA]" : "text-foreground/90"}`}>
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  rows,
  defaultOpen = false,
  accent = false,
}: {
  title: string;
  rows: { label: string; value?: string; highlight?: boolean }[];
  defaultOpen?: boolean;
  accent?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const valid = rows.filter(r => r.value);
  if (valid.length === 0) return null;

  return (
    <div className="border-b border-border/20 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded px-1 py-3 text-left transition-colors hover:bg-accent/20"
      >
        <span className={`mono-text text-xs font-semibold uppercase tracking-wider ${accent ? "text-[#2FE0DA]" : "text-peach"}`}>
          {title} <span className="ml-1 opacity-50">({valid.length})</span>
        </span>
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.25 }}>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="px-1 pb-3">
              {valid.map(r => <InfoRow key={r.label} label={r.label} value={r.value} highlight={r.highlight} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MediaInfoPanel({ info }: MediaInfoPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="liquid-card p-5"
    >
      <h3 className="mono-text mb-3 text-sm font-semibold uppercase tracking-wider text-peach">
        Media Info
      </h3>

      {/* General */}
      <Section title="General" defaultOpen rows={[
        { label: "Format",          value: info.format },
        { label: "Format Profile",  value: info.formatProfile },
        { label: "Codec / ID",      value: info.codec },
        { label: "Tag Format",      value: info.tagFormat },
        { label: "File Size",       value: info.fileSize },
        { label: "Duration",        value: info.duration },
        { label: "Overall Bitrate", value: info.overallBitrate },
        { label: "Bitrate Mode",    value: info.overallBitrateMode },
        { label: "Encoding",        value: info.encoding },
      ]} />

      {/* Audio Stream */}
      <Section title="Audio Stream" defaultOpen rows={[
        { label: "Sample Rate",       value: info.sampleRate },
        { label: "Sampling Count",    value: info.samplingCount },
        { label: "Bit Depth",         value: info.bitDepth },
        { label: "Channels",          value: info.channels },
        { label: "Channel Layout",    value: info.channelLayout },
        { label: "Channel Positions", value: info.channelPositions },
        { label: "Audio Bitrate",     value: info.audioBitrate },
        { label: "Bitrate Mode",      value: info.bitrateMode },
        { label: "Compression Mode",  value: info.compressionMode },
        { label: "Stream Size",       value: info.streamSize },
      ]} />

      {/* Encoding / Application */}
      <Section title="Encoding / Application" rows={[
        { label: "Writing Library",     value: info.writingLibrary },
        { label: "Writing Application", value: info.writingApp },
        { label: "Encoded By",          value: info.encoder },
      ]} />

      {/* Tags — Identity */}
      <Section title="Tags — Identity" rows={[
        { label: "Title",               value: info.title },
        { label: "Title Sort",          value: info.sortTitle },
        { label: "Subtitle",            value: info.subtitle },
        { label: "Artist / Performer",  value: info.artist },
        { label: "Artist Sort",         value: info.sortArtist },
        { label: "Album Artist",        value: info.albumArtist },
        { label: "Album Artist Sort",   value: info.sortAlbumArtist },
        { label: "Album",               value: info.album },
        { label: "Album Sort",          value: info.sortAlbum },
      ]} />

      {/* Tags — Credits */}
      <Section title="Tags — Credits" rows={[
        { label: "Composer",    value: info.composer },
        { label: "Composer Sort", value: info.sortComposer },
        { label: "Lyricist",    value: info.lyricist },
        { label: "Conductor",   value: info.conductor },
        { label: "Remixer",     value: info.remixer },
        { label: "Producer",    value: info.producer },
        { label: "Engineer",    value: info.engineer },
      ]} />

      {/* Tags — Release */}
      <Section title="Tags — Release" rows={[
        { label: "Genre",           value: info.genre },
        { label: "Date / Year",     value: info.date },
        { label: "Recorded Date",   value: info.recordedDate },
        { label: "Encoded Date",    value: info.encodedDate },
        { label: "Tagged Date",     value: info.taggedDate },
        { label: "Label",           value: info.label },
        { label: "Publisher",       value: info.publisher },
        { label: "Copyright",       value: info.copyright },
        { label: "ISRC",            value: info.isrc },
        { label: "Rating",          value: info.rating },
        { label: "iTunes Advisory", value: info.iTunesAdvisory === "1" ? "Explicit" : info.iTunesAdvisory === "0" ? "Clean" : info.iTunesAdvisory },
      ]} />

      {/* Tags — Track Info */}
      <Section title="Tags — Track Info" rows={[
        { label: "Track",       value: info.trackNumber && info.trackTotal ? `${info.trackNumber} / ${info.trackTotal}` : info.trackNumber },
        { label: "Disc",        value: info.discNumber && info.discTotal ? `${info.discNumber} / ${info.discTotal}` : info.discNumber },
        { label: "Part",        value: info.part && info.partTotal ? `${info.part} / ${info.partTotal}` : info.part },
        { label: "Grouping",    value: info.grouping },
        { label: "Mood",        value: info.mood },
        { label: "BPM",         value: info.bpm },
        { label: "Key",         value: info.key },
        { label: "Language",    value: info.language },
        { label: "Comment",     value: info.comment },
      ]} />

      {/* Tags — Original */}
      <Section title="Tags — Original Work" rows={[
        { label: "Original Artist", value: info.originalArtist },
        { label: "Original Album",  value: info.originalAlbum },
        { label: "Original Year",   value: info.originalYear },
      ]} />

      {/* Tags — Artwork & Misc */}
      <Section title="Tags — Artwork & Misc" rows={[
        { label: "Cover Art",         value: info.cover },
        { label: "Cover MIME",        value: info.coverMime },
        { label: "ReplayGain Track",  value: info.replayGainTrack },
        { label: "ReplayGain Album",  value: info.replayGainAlbum },
        ...(info.extraTags ? Object.entries(info.extraTags).map(([k, v]) => ({ label: k, value: v })) : []),
      ]} />

      {/* Lyrics */}
      {info.lyricsType && (
        <div className="border-b border-border/20 pb-4 last:border-0">
          {/* Header row */}
          <div className="flex flex-wrap items-center gap-2 px-1 py-3">
            <span className="mono-text text-xs font-semibold uppercase tracking-wider text-peach">
              Lyrics
            </span>
            {/* Type badge */}
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider font-semibold ${
              info.lyricsType?.includes("TTML") ? "bg-[#2FE0DA]/15 text-[#2FE0DA]" :
              info.lyricsType?.includes("LRC")  ? "bg-[#F97316]/15 text-[#F97316]" :
              "bg-muted/30 text-muted-foreground"
            }`}>
              {info.lyricsType}
            </span>
            {info.lyricsHasWordTimestamps && (
              <span className="rounded bg-[#2FE0DA]/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-[#2FE0DA]">
                Word-level
              </span>
            )}
            {info.lyricsHasTranslation && (
              <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-purple-400">
                Multi-lang / Romanization
              </span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground/60">
              {info.lyricsLines} lines
            </span>
          </div>
          {/* Expandable lyrics viewer */}
          <div className="px-1">
            <LyricsPanel raw={info.lyricsRaw || ""} preview={info.lyricsPreview || ""} />
          </div>
        </div>
      )}

      {/* Encoding Details / Analysis */}
      <Section title="Encoding Details" accent rows={[
        { label: "Lossy Transcoded",    value: info.lossyTranscoded, highlight: info.lossyTranscoded === "No" },
        { label: "Spectral Bandwidth",  value: info.spectralBandwidth },
        { label: "Effective Bit Depth", value: info.effectiveBitDepth },
        { label: "Phase Status",        value: info.phaseStatus },
        { label: "M/S Encoded",         value: info.msEncoded },
        { label: "MQA Detected",        value: info.mqaDetected },
        { label: "MQA Original Rate",   value: info.mqaOriginalRate },
        { label: "MD5 (Unencoded)",     value: info.md5 },
      ]} />
    </motion.div>
  );
}
