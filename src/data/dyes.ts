/** Dye table (spec §4.3). Display colours are pseudocolours, not true dye colours. */
export type DyeId = 'af546' | 'af647' | 'dapi';
export type ChannelId = 'green' | 'magenta' | 'dapi';

export interface Dye {
  id: DyeId;
  name: string;
  exNm: number;
  emNm: number;
  channel: ChannelId;
  /** Pseudocolour, sRGB hex. */
  color: string;
  /** What the dye roughly looks like to the eye (for the "Why pseudocolour?" popover). */
  trueColorNote: string;
}

export const DYES: Record<DyeId, Dye> = {
  af546: {
    id: 'af546',
    name: 'Alexa Fluor 546',
    exNm: 556,
    emNm: 573,
    channel: 'green',
    color: '#3CFF6A',
    trueColorNote: 'yellow-orange',
  },
  af647: {
    id: 'af647',
    name: 'Alexa Fluor 647',
    exNm: 650,
    emNm: 668,
    channel: 'magenta',
    color: '#FF3CF0',
    trueColorNote: 'far-red, barely visible to the eye',
  },
  dapi: {
    id: 'dapi',
    name: 'DAPI',
    exNm: 358,
    emNm: 461,
    channel: 'dapi',
    color: '#4A7BFF',
    trueColorNote: 'blue',
  },
};

export const CHANNEL_DYE: Record<ChannelId, DyeId> = {
  green: 'af546',
  magenta: 'af647',
  dapi: 'dapi',
};

/** sRGB hex → linear RGB triplet. */
export function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [c[0], c[1], c[2]];
}
