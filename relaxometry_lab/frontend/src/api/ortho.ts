/**
 * Binary volume/segmentation fetches for the ortho viewer
 * (GET /api/load/{sid}/volume, GET /api/load/{sid}/seg-volume).
 * These return raw float32/int32 buffers with shape/voxel-size in headers,
 * not JSON, so they're kept separate from api/client.ts.
 */

export interface VolumeData {
  shape: [number, number, number]; // [Z, Y, X]
  voxMm: [number, number, number]; // [dz, dy, dx]
  data: Float32Array;
}

export interface SegVolumeData {
  shape: [number, number, number];
  data: Int32Array;
}

export async function fetchVolume(sid: string, echo: number): Promise<VolumeData> {
  const r = await fetch(`/api/load/${sid}/volume?echo=${echo}`);
  if (!r.ok) throw new Error("Volume fetch failed");
  const shapeHdr = r.headers.get("X-Shape");
  const voxHdr = r.headers.get("X-VoxelMm");
  if (!shapeHdr) throw new Error("Volume response missing X-Shape header");
  const shape = shapeHdr.split(",").map(Number) as [number, number, number];
  const voxMm = (voxHdr ? voxHdr.split(",").map(Number) : [1, 1, 1]) as [number, number, number];
  const buf = await r.arrayBuffer();
  return { shape, voxMm, data: new Float32Array(buf) };
}

export async function fetchSegVolume(sid: string): Promise<SegVolumeData | null> {
  try {
    const r = await fetch(`/api/load/${sid}/seg-volume`);
    if (!r.ok) return null;
    const shapeHdr = r.headers.get("X-Shape");
    if (!shapeHdr) return null;
    const shape = shapeHdr.split(",").map(Number) as [number, number, number];
    const buf = await r.arrayBuffer();
    return { shape, data: new Int32Array(buf) };
  } catch {
    return null;
  }
}
