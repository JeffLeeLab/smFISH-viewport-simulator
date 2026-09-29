/// <reference lib="webworker" />
/** Builds the PSF-convolved cell volume off the main thread (spec §6.3). */
import { buildStructure, pack, splatSpots, type VolumeParams } from '../data/volume';

export interface BuildRequest {
  id: number;
  params: VolumeParams;
}

export interface BuildResult {
  id: number;
  data: Uint8Array;
  ms: number;
}

let cacheKey = '';
let cache: ReturnType<typeof buildStructure> | null = null;
let green: Float32Array | null = null;
let magenta: Float32Array | null = null;

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const t0 = performance.now();
  const { id, params } = e.data;
  const g = params.grid;
  const key = `${params.shape.seed}|${g.nx}x${g.ny}x${g.nz}`;
  if (key !== cacheKey || !cache) {
    cache = buildStructure(g, params.shape);
    cacheKey = key;
  }
  const n = g.nx * g.ny * g.nz;
  if (!green || green.length !== n) {
    green = new Float32Array(n);
    magenta = new Float32Array(n);
  }
  splatSpots(params, green, magenta!);
  const data = pack(green, magenta!, cache.dapi, cache.mask);
  const msg: BuildResult = { id, data, ms: performance.now() - t0 };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, [data.buffer]);
};
