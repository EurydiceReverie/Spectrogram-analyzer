/**
 * mpeghWorkerClient.ts
 * --------------------
 * Main-thread client that spawns the mpeghDecodeWorker in a Web Worker
 * and returns a promise resolving to DecodedAudio.
 *
 * This keeps the WASM decode completely off the main thread so the UI
 * stays responsive even for large 24-channel 360 RA files.
 */

import type { DecodedAudio } from './wasmDecoders';
import type { MpeghDecoderChoice } from '../components/MpeghDecoderDialog';

export interface DecodeProgress {
  percent: number;
}

/**
 * Decode an MPEG-H / 360 RA file via a Web Worker.
 *
 * @param arrayBuffer    Raw file bytes
 * @param decoder        'ittiam' | 'fraunhofer'
 * @param onProgress     Optional progress callback (0–100)
 * @param cicpSetup      CICP channel layout (0 = as-coded, default)
 */
export function decodeMpeghInWorker(
  arrayBuffer: ArrayBuffer,
  decoder: MpeghDecoderChoice,
  onProgress?: (pct: number) => void,
  cicpSetup = 0,
): Promise<DecodedAudio> {
  return new Promise((resolve, reject) => {
    // Vite handles ?worker imports — we use a URL constructor for compatibility
    const workerUrl = new URL('../workers/mpeghDecodeWorker.ts', import.meta.url);
    // Classic worker (NOT module) — required because the inner WASM glue uses importScripts()
    // for both Ittiam (decode-mpegh3da.js) and Fraunhofer (fraunhofer-mpegh.js).
    // Module workers throw "Module scripts don't support importScripts()" in Chromium-based browsers.
    const worker = new Worker(workerUrl, { type: 'classic' });

    worker.onmessage = (e: MessageEvent) => {
      const { type, result, message, percent } = e.data;

      if (type === 'progress') {
        onProgress?.(percent);
        return;
      }

      if (type === 'result') {
        worker.terminate();
        // result from worker matches WorkerDecodedAudio which is compatible with DecodedAudio
        resolve(result as DecodedAudio);
        return;
      }

      if (type === 'error') {
        worker.terminate();
        reject(new Error(message));
        return;
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(`Worker error: ${err.message}`));
    };

    // Clone the buffer before transferring — so the original is NOT detached.
    // The inline fallback in decode360RA needs the original buffer if the worker fails.
    const transferBuffer = arrayBuffer.slice(0);
    worker.postMessage(
      { type: 'decode', decoder, buffer: transferBuffer, cicpSetup },
      [transferBuffer],
    );
  });
}
