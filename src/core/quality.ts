/**
 * Automatic quality downgrade (spec §9): if frame time stays above ~22 ms, step down —
 * no depth of field, capped pixel ratio, fewer ray-march steps, smaller volume.
 */
import type { Renderer } from './renderer';

export type QualityLevel = 0 | 1 | 2;

export class QualityManager {
  level: QualityLevel = 0;
  private acc = 0;
  private frames = 0;
  private slowWindows = 0;
  private warmup = 90;

  constructor(
    private renderer: Renderer,
    private onChange: (level: QualityLevel) => void,
  ) {
    const q = new URLSearchParams(location.search).get('quality');
    if (q === 'low') this.set(2);
    else if (q === 'medium') this.set(1);
  }

  sample(dt: number): void {
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    if (document.hidden) return;
    this.acc += dt;
    this.frames++;
    if (this.frames < 60) return;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    if (avg > 0.022) this.slowWindows++;
    else this.slowWindows = Math.max(0, this.slowWindows - 1);
    if (this.slowWindows >= 2 && this.level < 2) {
      this.slowWindows = 0;
      this.warmup = 120;
      this.set((this.level + 1) as QualityLevel);
    }
  }

  set(level: QualityLevel): void {
    this.level = level;
    this.renderer.pixelRatioCap = level === 0 ? 2 : 1.5;
    this.renderer.bloom.resolution.scale = level === 0 ? 0.5 : 0.35;
    this.onChange(level);
  }
}
