/**
 * dolbyMp4Fragmenter.ts
 * ---------------------
 * Re-packages an unfragmented Dolby (AC-3 / EAC-3 / EAC3-JOC / AC-4) M4A file
 * into a FRAGMENTED MP4 (init segment + media segments) that MSE will accept.
 *
 * Why this is needed
 * ------------------
 * MSE (MediaSource Extensions) refuses to ingest a regular non-fragmented MP4
 * — it requires `mvex` in `moov` and audio samples wrapped in `moof`/`mdat`
 * fragments. Edge's error is:
 *   PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED:
 *   "Failure parsing MP4: Detected unfragmented MP4. Media Source Extensions
 *    require ISO BMFF moov to contain mvex to indicate that Movie Fragments
 *    are to be expected."
 *
 * Most consumer EAC3-JOC files (e.g. Amazon Music Atmos) ship as
 * unfragmented MP4. We need to transmux them client-side before feeding MSE.
 *
 * mp4box.js already has full fragmentation support via `setSegmentOptions` +
 * `start()`. We harness that: ingest the input bytes, ask mp4box to emit init
 * segment + media segments via `onSegment`, then concatenate everything into
 * a single ArrayBuffer that the caller can `appendBuffer()` to MSE.
 */

export interface FragmentedMp4Result {
  /** A single buffer containing init segment + all media segments concatenated */
  buffer: ArrayBuffer;
  /** Audio track id (1-based) for diagnostics */
  trackId: number;
  /** mp4box-reported codec string (e.g. "ec-3" / "ac-3" / "ac-4") */
  codec: string;
  /** Native sample rate from mp4box */
  sampleRate: number;
  /** Native channel count from mp4box */
  channels: number;
}

/**
 * Re-package an unfragmented Dolby M4A file as a fragmented MP4 ready for MSE.
 *
 * @param srcBuffer - the original .m4a file bytes
 * @returns the fragmented MP4 (init seg + media segs concatenated)
 */
export async function fragmentDolbyMp4(srcBuffer: ArrayBuffer): Promise<FragmentedMp4Result> {
  const mp4boxModule = await import('mp4box');
  const MP4Box = (mp4boxModule as any).default ?? mp4boxModule;

  // Suppress mp4box warnings about unknown boxes (Dolby's dec3/dac3 etc.)
  if (MP4Box?.Log?.setLogLevel) {
    try { MP4Box.Log.setLogLevel(MP4Box.Log.error); } catch { /* ignore */ }
  }

  return await new Promise<FragmentedMp4Result>((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    const segments: ArrayBuffer[] = [];
    let initSeg: ArrayBuffer | null = null;
    let trackId = -1;
    let codec = '';
    let sampleRate = 0;
    let channels = 0;
    let segmentBytesTotal = 0;

    let onReadyFired = false;

    const finalize = () => {
      if (initSeg === null) {
        reject(new Error('[DolbyFragmenter] mp4box did not emit init segment'));
        return;
      }
      const totalSize = initSeg.byteLength + segmentBytesTotal;
      const out = new Uint8Array(totalSize);
      out.set(new Uint8Array(initSeg), 0);
      let off = initSeg.byteLength;
      for (const seg of segments) {
        out.set(new Uint8Array(seg), off);
        off += seg.byteLength;
      }
      console.log(`[DolbyFragmenter] ✅ produced ${totalSize} bytes (init=${initSeg.byteLength} + ${segments.length} media segs=${segmentBytesTotal})`);
      resolve({
        buffer: out.buffer,
        trackId,
        codec,
        sampleRate,
        channels,
      });
    };

    mp4.onError = (err: any) => {
      reject(new Error(`[DolbyFragmenter] mp4box parse error: ${err}`));
    };

    mp4.onReady = (info: any) => {
      onReadyFired = true;
      // Prefer audioTracks (filtered list) over tracks (unfiltered).
      let audioTrack: any = null;
      if (Array.isArray(info.audioTracks) && info.audioTracks.length > 0) {
        audioTrack = info.audioTracks[0];
      } else if (Array.isArray(info.tracks)) {
        audioTrack = info.tracks.find((t: any) => t.type === 'audio')
                  ?? info.tracks.find((t: any) => /alac|mp4a|ac-3|ec-3|ac-4/i.test(t.codec ?? ''));
      }
      if (!audioTrack) {
        reject(new Error('[DolbyFragmenter] no audio track found in MP4'));
        return;
      }
      trackId    = audioTrack.id;
      codec      = audioTrack.codec ?? '';
      sampleRate = audioTrack.audio?.sample_rate ?? 0;
      channels   = audioTrack.audio?.channel_count ?? 0;
      console.log(`[DolbyFragmenter] mp4box.onReady: track=${trackId} codec=${codec} ch=${channels} sr=${sampleRate} samples=${audioTrack.nb_samples}`);

      // Enrol the audio track for fragmentation BEFORE start().
      mp4.setSegmentOptions(audioTrack.id, /* user */ null, { nbSamples: 100 });

      // initializeSegmentation() returns the init seg PER REGISTERED TRACK.
      const initSegments: any = mp4.initializeSegmentation();
      let ourInit: any = null;
      const len = initSegments?.length ?? 0;
      for (let i = 0; i < len; i++) {
        const s = initSegments[i];
        if (s && s.id === audioTrack.id) { ourInit = s; break; }
      }
      if (!ourInit && len > 0) ourInit = initSegments[0];
      if (!ourInit || !ourInit.buffer) {
        reject(new Error(`[DolbyFragmenter] no init segment for track ${audioTrack.id} (got ${len} entries — setSegmentOptions may need to be called BEFORE appendBuffer parsed the moov)`));
        return;
      }
      initSeg = ourInit.buffer;
      console.log(`[DolbyFragmenter] init segment: ${initSeg!.byteLength} bytes`);

      // start() arms the sample-walker; the existing buffered samples will be
      // emitted as onSegment events when we re-feed via appendBuffer below.
      mp4.start();
    };

    mp4.onSegment = (id: number, _user: any, buffer: ArrayBuffer, _sampleNum: number, _isLast: boolean) => {
      if (id !== trackId) return;
      segments.push(buffer);
      segmentBytesTotal += buffer.byteLength;
    };

    // ── Two-phase append strategy ────────────────────────────────────────
    // Phase 1: Feed the whole file in one big appendBuffer to trigger onReady
    //          (which calls setSegmentOptions + initializeSegmentation + start)
    // Phase 2: Re-feed the file in CHUNKS so mp4box's sample walker emits
    //          onSegment events. Without re-feeding, the samples have already
    //          been processed and fragmentation produces 0 segments.
    //
    // We make a SECOND mp4 instance to do the actual segmentation on the
    // same source bytes, but with setSegmentOptions called BEFORE the moov
    // is parsed (by virtue of being set up on the first instance's onReady).
    // This is the canonical "chunked feed" pattern from mp4box.js docs.
    const u8src = new Uint8Array(srcBuffer);
    const buf1 = u8src.buffer.slice(0) as any;
    buf1.fileStart = 0;
    try {
      mp4.appendBuffer(buf1);
      mp4.flush();
    } catch (err) {
      reject(new Error(`[DolbyFragmenter] phase-1 appendBuffer threw: ${err}`));
      return;
    }

    if (!onReadyFired) {
      reject(new Error('[DolbyFragmenter] mp4box.onReady never fired — file may be corrupt or have no moov'));
      return;
    }

    // Phase 2: feed the file again in chunks now that segmentation is armed.
    // Re-feeding is required because mp4box's onSegment is event-driven by
    // the sample walker, which only emits during NEW appendBuffer activity.
    // This time, samples are wrapped in moof/mdat fragments per setSegmentOptions.
    const CHUNK = 1024 * 1024; // 1 MB
    let pos = 0;
    try {
      while (pos < u8src.length) {
        const end = Math.min(pos + CHUNK, u8src.length);
        const chunk = u8src.slice(pos, end).buffer as any;
        chunk.fileStart = pos;
        mp4.appendBuffer(chunk);
        pos = end;
      }
      mp4.flush();
    } catch (err) {
      reject(new Error(`[DolbyFragmenter] phase-2 chunked appendBuffer threw: ${err}`));
      return;
    }

    if (segments.length === 0) {
      reject(new Error(`[DolbyFragmenter] mp4box did not emit any segments after re-feeding (${u8src.length} bytes). The file may use an unsupported sample layout.`));
      return;
    }

    finalize();
  });
}
