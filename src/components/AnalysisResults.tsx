import { motion } from "framer-motion";
import type { AnalysisResult } from "@/lib/audioAnalysis";
import { formatDuration, formatFileSize, formatFrequency } from "@/lib/audioAnalysis";
import { MetricCard } from "./MetricCard";
import { SpectrogramCanvas } from "./SpectrogramCanvas";
import { WaveformCanvas } from "./WaveformCanvas";
import { MediaInfoPanel } from "./MediaInfoPanel";
import { VerdictCard } from "./VerdictCard";
import SpatialMetadataOverlay from "./SpatialMetadataOverlay";
import type { SpatialMetadata } from "@/lib/useSpatialMetadata";

interface AnalysisResultsProps {
  result: AnalysisResult;
  spatialMeta?: SpatialMetadata | null;
}

export function AnalysisResults({ result, spatialMeta }: AnalysisResultsProps) {
  const nativeSR = result.nativeSampleRate;
  const nativeCh = result.nativeChannels;
  const nativeBD = result.nativeBitDepth > 0 ? result.nativeBitDepth : result.bitDepth;
  const is360RA = result.nativeInfo?.is360RA;

  // For 360RA: use the DECODED channel count (from Worker result) when available,
  // since the MP4 header reports 0 or 2 for object-based files until decode.
  const decodedCh = is360RA ? (result.channels || nativeCh) : nativeCh;

  // Build channel label from actual channel count — never hardcode "7.1" for Atmos
  const chCount = decodedCh || nativeCh;
  const baseChLabel =
    chCount === 1 ? "Mono" :
    chCount === 2 ? "Stereo" :
    chCount === 6 ? "5.1" :
    chCount === 8 ? "7.1" :
    chCount > 0   ? `${chCount}ch` : "";

  const channelLabel =
    is360RA && chCount > 0 ? `360RA · ${chCount}ch` :
    is360RA ? "360RA · Object-based" :
    result.nativeInfo?.isAtmos && chCount > 0 ? `${baseChLabel} + Atmos` :
    result.nativeInfo?.isAtmos ? "Atmos" :
    chCount === 1 ? "1 ch (Mono)" :
    chCount === 2 ? "2 ch (Stereo)" :
    chCount === 6 ? "6 ch (5.1)" :
    chCount === 8 ? "8 ch (7.1)" :
    `${chCount} ch`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
      className="space-y-6"
    >
      {/* File Info Header — always shows REAL values from header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="liquid-card liquid-card-active flex flex-wrap items-center justify-between gap-4 p-5"
      >
        <div>
          <h2 className="text-lg font-semibold text-foreground">{result.fileName}</h2>
          <p className="mono-text mt-1 text-sm text-muted-foreground">
            {result.format} · {(nativeSR / 1000).toFixed(nativeSR % 1000 === 0 ? 0 : 1)} kHz · {nativeBD}-bit · {channelLabel} · {formatDuration(result.duration)} · {formatFileSize(result.fileSize)}
          </p>
        </div>
      </motion.div>

      {/* VERDICT */}
      <VerdictCard detection={result.fakeDetection} format={result.format} />

      {/* 360 Reality Audio / MPEG-H 3D Audio badge + spatial object overlay */}
      {is360RA && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-4"
        >
          {/* 360RA identity banner */}
          <div className="rounded-xl border border-orange-500/30 bg-gradient-to-r from-orange-500/10 via-amber-400/10 to-yellow-300/10 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl">🎵</span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-sm">Sony 360 Reality Audio / MPEG-H 3D Audio</h3>
                  <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-xs font-medium text-orange-400 border border-orange-500/30">
                    {nativeCh}ch · Immersive
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Object-based 3D audio · All {decodedCh > 0 ? decodedCh : '?'} channels decoded at full quality · No downmixing
                </p>
              </div>
            </div>
          </div>

          {/* Spatial object position overlay (only when OAM metadata found) */}
          {spatialMeta && spatialMeta.objects.length > 0 && (
            <SpatialMetadataOverlay spatialMeta={spatialMeta} />
          )}
          {spatialMeta && spatialMeta.objects.length === 0 && (
            <div className="rounded-lg border bg-card/50 px-4 py-3 text-xs text-muted-foreground">
              🎯 No OAM object metadata found in bitstream — positional data may be embedded in MHAS frames.
            </div>
          )}
        </motion.div>
      )}

      {/* Spectrogram */}
      <SpectrogramCanvas data={result.spectrogram} />

      {/* Waveform */}
      <WaveformCanvas
        waveformData={result.waveform}
        duration={result.duration}
        sampleRate={nativeSR}
        rmsLevel={result.rmsLevel}
        truePeak={result.samplePeak}
      />

      {/* Media Info */}
      <MediaInfoPanel info={result.mediaInfo} />

      {/* ── Color Legend ── */}
      <div className="liquid-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Legend:</span>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-[#2FE0DA]" />
            <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Good — within spec</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-[#F97316]" />
            <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Warning — check needed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-[#EF4444]" />
            <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Bad — clipping / fake / severe</span>
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">

        {/* True Peak — full precision dBFS, no rounding */}
        <MetricCard
          index={0}
          label="True Peak (BS.1770-4)"
          value={`${result.truePeak > 0 ? "+" : ""}${result.truePeak.toFixed(2)} dBFS`}
          status={result.truePeak > -0.1 ? "bad" : result.truePeak > -1 ? "warning" : "good"}
          detail={`Sample peak: ${result.samplePeak > 0 ? "+" : ""}${result.samplePeak.toFixed(2)} dBFS`}
          reference="ITU-R BS.1770-4: 4× windowed-sinc polyphase FIR (12 taps, Kaiser β=6). Checks all samples above 1% of peak for inter-sample peaks."
        />

        {/* Integrated Loudness — K-weighted BS.1770 */}
        <MetricCard
          index={1}
          label="Integrated Loudness"
          value={`${result.rmsLevel.toFixed(2)} dBFS`}
          status={result.rmsLevel > -6 ? "bad" : result.rmsLevel > -10 ? "warning" : "good"}
          detail="K-weighted · BS.1770"
          reference="ITU-R BS.1770 K-weighted loudness. Two-stage IIR biquad: high-shelf at 1681.97 Hz (+4 dB, Q=0.707) + high-pass at 38.135 Hz (Q=0.500). 400 ms blocks, 100 ms hop. Absolute gate −70 LUFS, relative gate −10 LU. Target: −18 LUFS (EBU R128 / ReplayGain 2.0)."
        />

        <MetricCard
          index={2}
          label="Dynamic Range"
          value={`${result.dynamicRange.toFixed(1)} dB`}
          status={result.dynamicRange < 6 ? "bad" : result.dynamicRange < 12 ? "warning" : "good"}
          detail={`Crest factor: ${result.crestFactor.toFixed(1)} dB`}
          reference="PMF/DR Offline algorithm — 3 s non-overlapping blocks, top-20% loudest blocks averaged for RMS, second-highest peak block used (ignores lone transients). DR = peak_dB − RMS_dB + (−3.01 dB sine-reference offset). Matches foo_dr_meter / DROffline within rounding."
        />

        <MetricCard
          index={3}
          label="Clipping"
          value={result.clippingDetected ? `${result.clippingSamples.toLocaleString()} smp` : "None"}
          status={result.clippingDetected ? "bad" : "good"}
          detail={result.clippingDetected ? "Hard clipping detected" : "Clean signal"}
          reference="Counts samples at ±1.0 dBFS (hard digital ceiling). 3+ consecutive samples at ceiling = clipping event."
        />

        <MetricCard
          index={4}
          label="Compression"
          value={result.compressionLevel}
          status={result.compressionLevel === "Heavy" ? "bad" : result.compressionLevel === "Moderate" ? "warning" : "good"}
          detail={result.limitingDetected ? "Limiting detected" : "No limiting"}
          reference="Dynamic range + peak analysis. Heavy: DR < 6 dB. Moderate: DR 6–10 dB. Limiting detected when >2% of samples exceed 0.98 linear amplitude."
        />

        <MetricCard
          index={5}
          label="Freq Cutoff"
          value={formatFrequency(result.frequencyCutoff)}
          status={result.lossyDetected ? "warning" : "good"}
          detail={result.lossyDetected ? "Lossy encoding signature" : "Full bandwidth"}
          reference="16384-point FFT averaged across up to 32 segments. Scans from Nyquist downward for where smoothed energy drops >30 dB below the 1–8 kHz reference band. Sharp cutoff (brick-wall) = lossy encoder fingerprint."
        />

        <MetricCard
          index={6}
          label="Noise Floor"
          value={`${result.noiseFloor.toFixed(1)} dBFS`}
          status={result.noiseFloor > -50 ? "warning" : "good"}
          detail={result.ditheringDetected ? "Dithering present" : "No dithering"}
          reference="RMS of quietest 25% of 4096-sample blocks. Dithering detected via LSB histogram analysis — uniform/random LSB distribution indicates intentional TPDF or shaped dither."
        />

        {/* Channels — real count from native header */}
        <MetricCard
          index={7}
          label="Channels"
          value={channelLabel}
          status={result.phaseIssues ? "bad" : "good"}
          detail={result.nativeInfo?.channelLayout ?? (nativeCh > 1 ? `Balance: ${result.channelBalance > 0 ? "+" : ""}${result.channelBalance.toFixed(1)} dB` : "Mono source")}
        />

        {/* Phase */}
        <MetricCard
          index={12}
          label="Phase"
          value={nativeCh === 1 ? "N/A" : result.phaseIssues ? "Issues" : result.stereoCorrelation > 0.98 ? "Mono-compat" : result.stereoCorrelation > 0.5 ? "OK" : "Wide"}
          status={result.phaseIssues ? "bad" : nativeCh === 1 ? "neutral" : "good"}
          detail={nativeCh === 1 ? "Mono source" : `Correlation: ${result.stereoCorrelation.toFixed(4)}`}
          reference="Pearson cross-correlation between L/R channels. <0.5 = phase issues (potential mono incompatibility). >0.98 = near-mono (dual-mono). 0.5–0.98 = normal stereo width."
        />

        {/* M/S Encoded */}
        <MetricCard
          index={13}
          label="M/S Encoded"
          value={nativeCh === 1 ? "N/A" : result.msEncoded ? "Yes" : "No"}
          status={nativeCh === 1 ? "neutral" : result.msEncoded ? "good" : "neutral"}
          detail={nativeCh === 1 ? "Mono source" : result.msEncoded ? `Side ratio: ${(result.msRatio * 100).toFixed(2)}%` : "L/R encoding"}
          reference="M/S (Mid/Side) encoding detection. Computes L+R (mid) and L−R (side) energy ratio. Side ratio >1% of total = M/S encoded. Common in vinyl mastering and broadcast."
        />

        {/* Audio Bitrate */}
        <MetricCard
          index={14}
          label="Audio Bitrate"
          value={`${Math.round((result.fileSize * 8) / result.duration / 1000).toLocaleString()} kbps`}
          status="neutral"
          detail={result.fakeDetection.actualBitrate
            ? `Est. actual: ~${result.fakeDetection.actualBitrate} kbps`
            : "From file size / duration"}
          reference="Container bitrate = file_size × 8 / duration. Estimated actual bitrate from spectral cutoff frequency mapped to known lossy encoder bitrate tables (LAME/FhG)."
        />

        {/* Bit Depth — real from header, dither-aware */}
        <MetricCard
          index={8}
          label="Bit Depth"
          value={`${nativeBD}-bit`}
          status={result.bitDepthAuthentic ? "good" : "warning"}
          detail={result.bitDepthAuthentic
            ? `~${result.effectiveBitDepth}-bit effective · LSB entropy ${result.lsbEntropy.toFixed(1)}/8`
            : `Only ~${result.effectiveBitDepth}-bit effective · LSB entropy ${result.lsbEntropy.toFixed(1)}/8`}
          reference="Two-pronged analysis: (1) 16-bit quantization grid check — how many samples land on 16-bit step boundaries. (2) LSB entropy — Shannon entropy of 256-bin histogram of bottom 8 bits when scaled to 24-bit range. Entropy >6.5/8 = genuine 24-bit with dither. <2.0 = padded from 16-bit."
        />

        {/* Sample Rate — always show REAL native rate from header */}
        <MetricCard
          index={9}
          label="Sample Rate"
          value={`${(nativeSR / 1000).toFixed(nativeSR % 1000 === 0 ? 0 : 1)} kHz`}
          status={result.upsamplingDetected ? "warning" : "good"}
          detail={result.upsamplingDetected && result.upsampledFromRate
            ? `Upsampled from ${(result.upsampledFromRate / 1000).toFixed(1)} kHz`
            : result.upsamplingDetected
            ? "Upsampling detected"
            : `Nyquist: ${(nativeSR / 2000).toFixed(nativeSR % 2000 === 0 ? 0 : 1)} kHz`}
          reference="Multi-rate upsampling detection: compares spectral energy in a 1 kHz band just below vs just above candidate source Nyquist frequencies (22.05, 24, 48 kHz). If energy above candidate Nyquist is <1% of below → upsampled from that rate."
        />

        {/* Peak vs True Peak */}
        <MetricCard
          index={10}
          label="Peak vs True Peak"
          value={`Δ ${Math.abs(result.truePeak - result.samplePeak).toFixed(3)} dB`}
          status={Math.abs(result.truePeak - result.samplePeak) > 3 ? "bad" : Math.abs(result.truePeak - result.samplePeak) > 0.5 ? "warning" : "good"}
          detail={`True Peak: ${result.truePeak.toFixed(2)} · Sample: ${result.samplePeak.toFixed(2)} dBFS`}
          reference="Difference between True Peak (inter-sample, BS.1770-4 windowed-sinc) and sample peak (highest discrete sample). Large Δ indicates ISP events — common in lossy transcodes or aggressive limiting."
        />

        {/* Integrity */}
        <MetricCard
          index={11}
          label="Integrity"
          value={result.bitPerfect ? "Authentic" : "Processed"}
          status={result.bitPerfect ? "good" : "neutral"}
          detail={result.integrityReason}
          reference="Composite verdict: authentic if no fake detection flags, no upsampling, no bit-depth padding, no clipping. Any processing artifact = 'Processed'."
        />

        {/* Codec — format type with FourCC */}
        <MetricCard
          index={15}
          label="Codec"
          value={result.format}
          status="neutral"
          detail={result.mediaInfo.codec}
        />

        {/* Decoder used */}
        <MetricCard
          index={16}
          label="Decoder"
          value={
            result.formatExt === "flac"                                    ? "libFLAC WASM" :
            result.formatExt === "mp3"                                     ? "mpg123 WASM" :
            result.formatExt === "ogg"                                     ? "libvorbis WASM" :
            result.formatExt === "wav" || result.formatExt === "wave"      ? "Binary Parser" :
            result.formatExt === "aiff" || result.formatExt === "aif"      ? "Binary Parser" :
            result.formatExt === "m4a" || result.formatExt === "mp4"       ? "mp4box + FFmpeg WASM" :
            result.formatExt === "ac3" || result.formatExt === "ec3" ||
            result.formatExt === "eac3" || result.formatExt === "ac4" ||
            result.formatExt === "ims"                                     ? "FFmpeg WASM" :
                                                                             "FFmpeg WASM"
          }
          status={
            result.formatExt === "flac" || result.formatExt === "wav" ||
            result.formatExt === "aiff" || result.formatExt === "aif" ||
            result.formatExt === "mp3"  || result.formatExt === "ogg"
              ? "good" : "good"
          }
          detail={
            result.formatExt === "flac"
              ? "Bit-perfect · LSBs preserved · MQA-ready"
            : result.formatExt === "wav" || result.formatExt === "wave"
              ? "Binary parser · zero resampling · native bit depth"
            : result.formatExt === "aiff" || result.formatExt === "aif"
              ? "Binary parser · big-endian PCM · zero resampling"
            : result.formatExt === "mp3"
              ? "libmpg123 WASM · native SR · no resampling"
            : result.formatExt === "ogg"
              ? "libvorbis WASM · native SR"
            : result.formatExt === "m4a" || result.formatExt === "mp4"
              ? "mp4box.js demux · ALAC binary PCM / AAC → FFmpeg"
            : result.formatExt === "ac3" || result.formatExt === "ec3" ||
              result.formatExt === "eac3" || result.formatExt === "ac4"
              ? "FFmpeg WASM · multichannel f32le · spatial metadata not preserved"
            : result.formatExt === "ims"
              ? "FFmpeg WASM · AC-4 IMS binaural · spatial metadata not preserved"
            : "FFmpeg WASM · f32le PCM"
          }
        />

        {/* MQA Detection — golden card */}
        {result.mediaInfo.mqaDetected === "Yes" && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 17 * 0.04, ease: [0.4, 0, 0.2, 1] }}
            whileHover={{ y: -2, transition: { duration: 0.2 } }}
            className="flex flex-col gap-2 rounded-xl border border-[rgba(218,165,32,0.35)] bg-[rgba(218,165,32,0.08)] p-4 shadow-[0_0_24px_rgba(218,165,32,0.10)]"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-[rgba(218,165,32,0.8)]">
                MQA
              </span>
              <div className="h-2 w-2 rounded-full bg-[#DAA520]" />
            </div>
            <span className="font-heading text-base font-semibold leading-tight text-[#DAA520]">
              {result.mediaInfo.mqaStudio === "Yes" ? "MQA Studio" : "MQA Detected"}
            </span>
            <span className="text-[11px] font-mono text-[rgba(218,165,32,0.7)]">
              {result.mediaInfo.mqaOriginalRate
                ? `Original: ${result.mediaInfo.mqaOriginalRate} · ${result.mediaInfo.mqaStudio === "Yes" ? "Studio authenticated" : "Watermark confirmed"}`
                : "Watermark found in PCM"}
            </span>
          </motion.div>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-white/10 bg-black/30 p-4 font-mono">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-[11px] uppercase tracking-[0.2em] text-primary/80">
            DR14 / PMF-compatible Calculation
          </h3>
          <div className="text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <div>Track DR: <span className="text-foreground">{Math.round(result.dynamicRange)}</span></div>
            <div>ReplayGain calc: <span className="text-foreground">{result.replayGainTrackGain.toFixed(2)} dB</span></div>
            {result.mediaInfo.replayGainTrack && (
              <div>ReplayGain tag: <span className="text-foreground">{result.mediaInfo.replayGainTrack}</span></div>
            )}
            <div>Track peak calc: <span className="text-foreground">{result.samplePeakLinear.toFixed(6)}</span></div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[11px]">
            <thead className="border-b border-white/10 text-muted-foreground">
              <tr>
                <th className="py-2 text-left font-medium">Channel</th>
                <th className="py-2 text-right font-medium">DR14</th>
                <th className="py-2 text-right font-medium">Top-20% RMS</th>
                <th className="py-2 text-right font-medium">Peak dBFS</th>
                <th className="py-2 text-right font-medium">Peak linear</th>
                <th className="py-2 text-right font-medium">DR peak</th>
                <th className="py-2 text-right font-medium">DR RMS</th>
                <th className="py-2 text-right font-medium">Blocks</th>
              </tr>
            </thead>
            <tbody>
              {result.channelStats.map((ch, i) => (
                <tr key={`${ch.name}-${i}`} className="border-b border-white/5 last:border-0">
                  <td className="py-2 text-left text-foreground">{i === 0 ? "FL" : i === 1 ? "FR" : ch.name}</td>
                  <td className="py-2 text-right text-foreground">{ch.dr.toFixed(2)} dB</td>
                  <td className="py-2 text-right text-foreground">{ch.rmsDb.toFixed(2)} dBFS</td>
                  <td className="py-2 text-right text-foreground">{ch.peakDb.toFixed(2)} dBFS</td>
                  <td className="py-2 text-right text-foreground">{ch.peakLinear.toFixed(6)}</td>
                  <td className="py-2 text-right text-muted-foreground">{Number.isFinite(ch.drPeakDb) ? ch.drPeakDb.toFixed(2) : "—"}</td>
                  <td className="py-2 text-right text-muted-foreground">{Number.isFinite(ch.drTopRmsDb) ? ch.drTopRmsDb.toFixed(2) : "—"}</td>
                  <td className="py-2 text-right text-muted-foreground">{ch.drBlockCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
