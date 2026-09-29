import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, fromHash, initialState, toHash, type AppState } from '../../src/state/store';

describe('URL hash', () => {
  it('round-trips the shareable state', () => {
    const s: AppState = {
      ...DEFAULT_STATE,
      stage: 3,
      na: 1.2,
      immersion: 'water',
      probesPerSet: 24,
      chGreen: true,
      chMagenta: false,
      chDapi: false,
      washed: true,
      helical: true,
      longFraction: 0.35,
      seed: 42,
      mip: true,
      isoform: 'short',
      cam: [1.5, -2.25, 0.5, 0.4, 1.1, 3.3],
    };
    const back = { ...DEFAULT_STATE, ...fromHash(toHash(s)) };
    for (const k of ['stage', 'na', 'immersion', 'probesPerSet', 'chGreen', 'chMagenta', 'chDapi', 'washed', 'helical', 'longFraction', 'seed', 'mip', 'isoform', 'cam'] as const) {
      expect(back[k], k).toEqual(s[k]);
    }
  });

  it('parses the example from the spec', () => {
    const p = fromHash('#stage=3&na=1.4&imm=oil&n=10&ch=gm');
    expect(p).toMatchObject({ stage: 3, na: 1.4, immersion: 'oil', probesPerSet: 10, chGreen: true, chMagenta: true, chDapi: false });
  });

  it('clamps and ignores invalid values', () => {
    const p = fromHash('#stage=9&na=3&imm=air&n=500&seed=-4&long=180');
    expect(p.stage).toBeUndefined();
    expect(p.na).toBe(0.95); // air NA limited below n = 1
    expect(p.probesPerSet).toBe(48);
    expect(p.seed).toBeUndefined();
    expect(p.longFraction).toBe(1);
  });

  it('deep links to stages 3–4 imply a finished, washed experiment', () => {
    expect(initialState('#stage=3')).toMatchObject({ hyb: 'bound', washed: true });
    expect(initialState('#stage=3&wash=0')).toMatchObject({ hyb: 'bound', washed: false });
    expect(initialState('#stage=2')).toMatchObject({ hyb: 'running' });
    expect(initialState('')).toMatchObject({ stage: 1, hyb: 'none' });
  });
});
