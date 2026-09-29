/** Caption card: a short summary per stage plus "Learn more" (spec §7). */
import type { Stage, Store } from '../state/store';
import { STAGE_NAMES } from '../core/scale';
import { CAMERA } from '../data/optics';
import { el } from './controls';

const SIMPLIFICATIONS = `
  <p><b>Simplifications in this model</b></p>
  <ul>
    <li>The sequence is made up for teaching; it is not a real gene.</li>
    <li>10 probes per set are shown by default; real designs typically use ~20–48.</li>
    <li>No RNA secondary structure, ribosomes or bound proteins.</li>
    <li>The point-spread function is an idealised 3D Gaussian.</li>
    <li>Both dyes are treated as equally bright.</li>
    <li>Fluorophores, the cap and very thin strands are drawn with a minimum on-screen size.</li>
    <li>Each mRNA is drawn as a tidy folded helical strand (one of a few shapes) rather than a real, irregular fold.</li>
    <li>The lab behind the cell is decoration, not to scale.</li>
  </ul>`;

const CAPTIONS: Record<Stage, { summary: string; more: string }> = {
  1: {
    summary:
      'This is a messenger RNA (mRNA): a protective m7G cap at the 5′ end, the coding sequence (CDS) between two untranslated regions (UTRs), and a poly(A) tail at the 3′ end. Like all RNA, the single strand winds into a right-handed helix. Press <kbd>H</kbd> to add smFISH probes: short DNA strands (~18–20 nt), each with one dye on its 3′ end, that find their matching stretch and pair with it antiparallel. <span class="sw m">Magenta</span> probes (Alexa 647) tile the CDS of both isoforms; <span class="sw g">green</span> probes (Alexa 546) bind the extended 3′UTR that only the long isoform has.',
    more: `
      <p>Both isoforms share the 5′UTR (120 nt), the CDS (1,500 nt, from AUG to UAA) and the first 300 nt of the 3′UTR. They differ in where the RNA is cut and polyadenylated. The <b>short isoform</b> uses a proximal AAUAAA signal, while the <b>long isoform</b> reads on through another 1,200 nt, the extended 3′UTR, to a distal AAUAAA. Choosing between the two is called alternative polyadenylation. It is common and changes how an mRNA is regulated.</p>
      <p>The strand is drawn to scale. Its bases stack on one another, so single-stranded RNA coils into an A-form-like right-handed helix, about 11 nt per turn and 2 nm across; zoom in to see it. Even so, the 3.3 kb long isoform would be about 1 µm long if stretched out. Here it is folded into a few neat rows, read like lines of text from the 5′ cap to the poly(A) tail, so the whole molecule is only ~300 nm across. Real mRNAs in cells are compacted by secondary structure and bound proteins; that compaction is why probes at both ends end up in one diffraction-limited spot. Hover over the strand to see each region's name and length.</p>
      <p>Probes are added in excess and find their targets by diffusion. A probe that meets its complementary sequence pairs base by base, or "zips", into an RNA–DNA hybrid that continues the RNA's own helix. Mismatched encounters don't hold, and those probes drift off again. Unbound probes are then washed away (<kbd>W</kbd>). On the short isoform, the green probes have nothing to bind, so they are washed away too.</p>
      <p>Each probe is the reverse complement of its 18-nt target, with 40–60% GC and at least 2 nt between neighbouring probes. Hover over a probe to see its sequence, target position and an approximate melting temperature.</p>
      <p><b>Helical</b> view shows the A-form-like hybrid duplex: about 11 bp per turn and 0.28 nm per bp, so an 18-bp probe is only ~5 nm long. <b>Schematic</b> view (press <kbd>S</kbd>) unwinds each bound probe into a ladder.</p>
      <p>Made-up sequence for teaching.</p>`,
  },
  2: {
    summary:
      'Light can\'t be focused to a perfect point. A microscope images each dye as a blurred spot, the point-spread function (PSF), about 200–240 nm wide and 3–4× longer along the optical axis. All the probes on one mRNA fall inside that blur, so they merge into one bright, diffraction-limited spot. One dye alone is too dim to see; many together make a single mRNA visible.',
    more: `
      <p>The PSF here uses the widefield Gaussian approximation (Zhang et al. 2007): σ<sub>xy</sub> = 0.21·λ/NA and σ<sub>z</sub> = 0.66·λ·n/NA². Longer wavelengths (Alexa 647) give slightly larger spots, and a higher numerical aperture (NA) gives smaller ones.</p>
      <p>In the merge, the long isoform is <span class="sw w">white</span> because it carries both colours. The short isoform is <span class="sw m">magenta only</span>.</p>
      <p>The inset shows what a camera records in the chosen focal plane. The model assumes ${CAMERA.pixelNm} nm pixels, about ${CAMERA.photonsPerDye} photons per dye, shot noise, read noise of ${CAMERA.readNoise} e⁻, and background from autofluorescence (~${CAMERA.autofluorescence}) plus unbound probes (~${CAMERA.unboundHaze}, before the wash). These numbers are illustrative, not from a particular instrument. Try 1–2 probes per set: the spot disappears into the noise.</p>
      <p>Green and magenta are pseudocolours. Alexa 546 actually looks yellow-orange and Alexa 647 is far-red, which is barely visible to the eye. Green and magenta are easy to tell apart, colour-blind friendly, and merge to white.</p>`,
  },
  3: {
    summary:
      'Each spot is one mRNA molecule, so counting spots measures gene expression in individual cells. <span class="sw w">White</span> spots carry both colours (long 3′UTR); <span class="sw m">magenta-only</span> spots are the short isoform. The bright spots in the nucleus are transcription sites, where new RNAs are being made.',
    more: `
      <p>This cell has ~74 cytoplasmic and ~6 nuclear mRNAs (80 in all), and two transcription sites. Every spot is a real molecule in the model: double-click one to zoom to its spot, and again to see the mRNA itself with its probes. The spot counts come from the model, not from image analysis. Real experiments detect and count spots automatically.</p>
      <p>Transcription sites look <b>magenta-dominant</b>. Nascent RNAs are made 5′→3′, so most of them already carry the CDS (magenta) probe targets but haven't yet been transcribed as far as the extended 3′UTR (green).</p>
      <p>Press <kbd>P</kbd> for a maximum-intensity projection (MIP). It flattens the 3D stack into the kind of 2D image researchers usually look at.</p>
      <p>The nucleus is stained with DAPI, a blue DNA dye.</p>`,
  },
};

export class Captions {
  private root: HTMLElement;
  private stage: Stage | 0 = 0;
  private collapsed = false;

  constructor(parent: HTMLElement, store: Store) {
    this.root = el('section', { id: 'caption', 'aria-live': 'polite' });
    parent.append(this.root);
    // On phones the caption starts collapsed so it doesn't cover the view.
    this.collapsed = window.matchMedia('(max-width: 760px)').matches;
    store.watch(['stage'], (s) => this.show(s.stage));
  }

  private show(stage: Stage): void {
    if (stage === this.stage) return;
    this.stage = stage;
    const c = CAPTIONS[stage];
    const btn = el('button', { class: 'collapse', type: 'button', 'aria-label': 'Collapse caption' }, this.collapsed ? '+' : '–');
    btn.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('collapsed', this.collapsed);
      btn.textContent = this.collapsed ? '+' : '–';
    });
    this.root.replaceChildren(
      btn,
      el('h2', {}, `${stage} · ${STAGE_NAMES[stage]}`),
      el('p', { html: c.summary }),
      el('details', {}, el('summary', {}, 'Learn more'), el('div', { html: c.more + SIMPLIFICATIONS })),
    );
    this.root.classList.toggle('collapsed', this.collapsed);
  }

  userInteracted(): void {
    // Reserved for the guided tour; captions stay put while exploring.
  }
}
