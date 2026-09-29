# smFISH Viewport — Specification

An interactive three.js web app that shows how single-molecule FISH (smFISH) works. You follow the whole method in one continuous zoom: an mRNA molecule, probes binding to it, diffraction turning those probes into a single spot, and finally a cell full of spots.

This spec replaces `brief.md`.

---

## 1. Purpose and audience

- **Audience:** undergraduate and postgraduate teaching, plus public outreach. Assume the user knows basic biology but not microscopy or optics.
- **Learning goals.** After a few minutes with the app, a user should be able to explain:
  1. The structure of an mRNA: the 5′ cap, the 5′UTR, the CDS, the 3′UTR and the poly(A) tail.
  2. How smFISH probes bind to their target: short antisense DNA strands, one dye each, pairing antiparallel.
  3. Why many probes are needed. One dye is too dim to see; many dyes on one mRNA add up to one bright spot.
  4. What the diffraction limit and the point-spread function (PSF) are, and why a spot is longer along z than it is wide.
  5. How two colours of probe tell isoforms apart. A long-3′UTR mRNA shows both colours (white when merged); a short-3′UTR mRNA shows magenta only.
  6. That one spot is one mRNA. Counting spots in a cell measures how strongly a gene is expressed.
- **Tone:** beautiful and exploratory, but scientifically honest. Wherever the app simplifies, it says so in a caption.

## 2. Design reference and principles

The model is [sael.net/plane-of-focus](https://sael.net/plane-of-focus/): a single screen with a large 3D viewport and a slim control panel. Every control updates the scene immediately. Keyboard shortcuts jump between preset views.

Principles:

- **One continuous zoom.** The four stages are points along a single scale axis, not separate pages.
- **The physics drives the visuals.** PSF size comes from the chosen dye's wavelength and the objective's NA. Spot brightness comes from the number of probes. Nothing is faked where the real model is cheap enough to compute.
- **Change one thing, see one thing.** Each control has one visible effect.
- **Microscope-like look.** Near-black background, glowing fluorophores, additive channel mixing, and optional camera noise and pixels.

## 3. The core interaction: a scale axis

There is one global parameter, **`s = log10(field of view in nm)`**. It runs from about 20 nm (individual bases) to about 30 µm (the whole cell).

| Stage | Key | FOV (approx.) | Scene | What it shows |
|---|---|---|---|---|
| 1 · Molecule | `1` | 330 nm | Molecular | The whole long-isoform mRNA as a clean strand folded into rows, regions coloured. No probes yet. |
| 2 · Hybridise | `2` | 40 nm | Molecular | Close-up of a probe cluster in the CDS. The hybridisation animation plays. |
| 3 · Diffraction | `3` | 2.8 µm | Optical | Both mRNAs (long and short isoform) turn into PSF spots. Focal plane, NA and probe count controls. |
| 4 · Cell | `4` | 25 µm | Cell | A translucent cell with DAPI nucleus, about 150 mRNA spots and transcription sites. |

- **Mouse wheel, trackpad pinch or touch pinch** always changes `s` (zooming toward the cursor). `+` / `−` zoom from the keyboard.
- **Drag** orbits. **Shift-, Ctrl- or ⌘-drag** pans (up, down, left, right), as do right-drag, two-finger drag and the arrow keys (Shift for bigger steps).
- **Double-click** zooms into whatever is under the cursor: in the cell, an RNA's diffraction-limited spot (~2.8 µm FOV); on a spot, the molecule itself (~400 nm FOV, facing its folded strand); on a molecule, a closer look at that point.
- **Stage keys or buttons** fly the camera smoothly to that stage's preset `s`, target and angle (about 1.2 s, eased). Stage 2 also starts the hybridisation animation if the probes aren't bound yet.
- **Scene hand-off by cross-fade:**
  - Molecular scene: visible up to 800 nm FOV, fading out between 400 and 800 nm.
  - Optical scene: fades in between 400 and 800 nm, fades out between 4 and 8 µm.
  - Cell scene: visible from 4 µm upwards.
- **Each scene has its own units and camera** (molecular: 1 unit = 1 nm; optical and cell: 1 unit = 1 µm). This avoids floating-point precision problems and lets each scene be drawn in its own style. A shared controller turns `s` into each scene's camera distance and opacity.
- **Continuity between scenes.** The optical scene uses the actual fluorophore positions from the molecular scene, converted to µm. What you saw bind is exactly what gets blurred.
- **Every RNA is zoomable.** Each of the ~185 RNAs in the cell (cytoplasmic, nuclear and nascent) is a real molecule in the model: a record with a position, orientation and one of a few shape variants. Zoom toward any spot and the optical scene shows the PSFs of the RNAs around the camera target, then the molecular scene builds those molecules in full detail (with their probes), so the zoom is continuous all the way from the cell to the bases. The cell volume, the optical spots and the molecules all use the same fluorophore positions.
- **Persistent HUD:**
  - A scale bar that snaps to 1-2-5 values and relabels as you zoom (e.g. "10 nm", "200 nm", "5 µm").
  - The current stage name.
  - Stage-specific readouts, such as FWHM values in stage 3.

## 4. Scientific model

### 4.1 Made-up transcript

The sequence is generated, not a real gene: seeded PRNG, fixed seed, reproducible. It is labelled in the UI as *"Made-up sequence for teaching"*.

| Region | Length (nt) | Notes |
|---|---|---|
| m7G cap | — | Sphere at the 5′ end, with a 5′–5′ triphosphate stub |
| 5′UTR | 120 | |
| CDS | 1,500 | Starts with `AUG`, ends with `UAA`, and has no in-frame stop codons in between (the generator re-rolls any codon that would be one) |
| 3′UTR, common | 300 | Ends with the proximal polyadenylation signal `AAUAAA`, about 20 nt before the proximal cleavage site |
| 3′UTR, extended | 1,200 | **Long isoform only.** Ends with the distal `AAUAAA` and cleavage site |
| poly(A) | 150 | Drawn in full, as a slightly thinner, more flexible tail |

- **Short isoform** (proximal polyadenylation): cap + 5′UTR + CDS + common 3′UTR + poly(A). About 2.07 kb.
- **Long isoform** (distal polyadenylation): cap + 5′UTR + CDS + common + extended 3′UTR + poly(A). About 3.27 kb.
- GC content around 45–50%. Nucleotide composition is random apart from the fixed motifs above.

### 4.2 Probe sets

| Set | Target | Dye | Pseudocolour | Binds |
|---|---|---|---|---|
| **CDS set** | Tiled along the CDS | **Alexa Fluor 647** | Magenta | Both isoforms |
| **Distal-3′UTR set** | Tiled along the extended 3′UTR, clustered toward the poly(A) end | **Alexa Fluor 546** | Green | Long isoform only |

- **Probe design:**
  - 18 nt DNA, the reverse complement of the target (T in place of U).
  - At least 2 nt between neighbouring probes.
  - Probe GC content 40–60%. The generator picks target windows that meet this.
- **Probes per set:** 10 by default, adjustable from 1 to 48 (§6.3).
  - Probe positions are computed for 48 per set; the first *N* by rank are shown. Changing *N* adds or removes probes without shuffling the others.
  - The CDS (1,500 nt) and the extended 3′UTR (1,200 nt) each have room for 48 probes at 20 nt per probe including the gap.
  - Caption: *"Real smFISH designs typically use ~20–48 probes per set."*
- **Direction:**
  - Probes pair antiparallel: probe 5′→3′ against mRNA 3′→5′.
  - The dye is on the **probe's 3′ end**, joined by a short linker (drawn as a C6 amino-linker stub). So each dye sits at the mRNA-5′ side of its target site.
  - Small 5′/3′ labels appear on the mRNA and on a hovered probe.
- **Probe tooltip** (hover or tap): probe sequence 5′→3′, target coordinates, GC%, an approximate Tm (simple nearest-neighbour or Wallace estimate, labelled "approx."), the dye, and its excitation/emission peaks.

### 4.3 Dyes and channels

| Dye | Ex peak | Em peak | Channel | Display colour |
|---|---|---|---|---|
| Alexa Fluor 546 | ~556 nm | ~573 nm | Green | `#3CFF6A` (pseudocolour) |
| Alexa Fluor 647 | ~650 nm | ~668 nm | Magenta | `#FF3CF0` (pseudocolour) |
| DAPI (cell stage) | ~358 nm | ~461 nm | Blue | `#4A7BFF` |

- The channels mix additively: green (0,1,0) + magenta (1,0,1) = white. That's why colocalised spots look white in the merge.
- A **"Why pseudocolour?"** info popover explains that Alexa 546 actually looks yellow-orange and Alexa 647 is far-red (barely visible to the eye). Green and magenta are chosen because they're easy to tell apart, colour-blind friendly, and merge to white.
- The two dyes are treated as equally bright. The caption says this is a simplification.

### 4.4 Point-spread function (widefield)

The PSF is modelled as a 3D Gaussian using the widefield approximation from Zhang et al. (2007):

```
σ_xy = 0.21 · λ_em / NA
σ_z  = 0.66 · λ_em · n / NA²
FWHM = 2.355 · σ
```

Reference values at the default setting (oil immersion, n = 1.515, NA = 1.40). These are also unit-test fixtures:

| Dye | λ_em | FWHM lateral | FWHM axial | Axial / lateral |
|---|---|---|---|---|
| Alexa 546 | 573 nm | ~202 nm | ~688 nm | ~3.4× |
| Alexa 647 | 668 nm | ~236 nm | ~803 nm | ~3.4× |

**Objective presets.** The NA slider is limited so that NA < n.

| Immersion | n | NA range | Default NA |
|---|---|---|---|
| Air | 1.00 | 0.30–0.95 | 0.75 |
| Water | 1.33 | 0.80–1.27 | 1.20 |
| Oil (default) | 1.515 | 0.80–1.49 | 1.40 |

- **Camera sampling** (for the 2D image inset): pixel size 65 nm, e.g. a 6.5 µm sCMOS pixel behind a 100× objective. There is a **"Show camera pixels"** toggle. The z-step for "stack" views is 200 nm.
- **Chromatic offset** (a toggle, off by default): shifts the magenta channel by about 30 nm laterally and 100 nm axially, to show why real two-colour data needs registration.

### 4.5 Signal and noise model

This drives the probe-count lesson and the camera-like look. The parameters are illustrative, and the "Learn more" text says so.

```
signal per spot    = N_bound · photons_per_dye            (default photons_per_dye ≈ 40)
pixel value        = background + Σ spots · PSF(x,y,z)  →  Poisson(shot noise) + Gaussian(read noise, σ ≈ 1.5)
background         = autofluorescence (≈ 20) + unbound-probe haze (≈ 60 before wash, ≈ 0 after)
SNR (readout)      = signal_peak / sqrt(signal_peak + background + read²)
```

- **Before the wash**, the haze from unbound probes raises the background, and dim spots get lost in it.
- **With 1–2 probes**, the spot sits at or below the noise floor. From about 8–10 probes it clearly stands out.

### 4.6 Molecular geometry (approximately to scale)

- **Units:** 1 world unit = 1 nm.
- **Single-stranded RNA backbone:** about 0.6 nm per nt, drawn as a clean, **mostly straight strand with slight, irregular wiggles**, folded into parallel rows (~24 nm apart) joined by U-turns, with no crossings. It reads 5′→3′ like lines of text. The fold is nearly flat and faces the stage 1 camera. The long isoform is ~280 × 140 nm (6 rows); the poly(A) tail curls off the end of the last row. RNA secondary structure is not modelled; the tidy fold stands in for the compaction real mRNAs have in cells.
- **Colocalisation by design:** a straight 3.3 kb mRNA would be ~2 µm long, putting the CDS (magenta) and distal-3′UTR (green) probes ~1.3 µm apart, i.e. two separate spots. The long isoform's row length is chosen so the CDS probe cluster and the distal probe cluster sit in same-direction rows directly above one another, ~90–120 nm apart, inside one diffraction-limited spot (unit-tested).
- **Shape variants:** each isoform has a few variants (different wiggles and bows) used across the cell population. Nascent RNAs at transcription sites are prefixes of a long-isoform chain.
- **Hybridised segments:** straightened. Two display modes:
  - **Schematic (default):** the probe runs alongside the mRNA as a parallel rail joined by **4 rungs** (a ladder, as in the brief).
  - **Helical:** an 18 bp A-form-like RNA–DNA hybrid helix, about 11 bp per turn and about 0.28 nm rise per bp, so roughly 1.6 turns and 5 nm long. The ladder smoothly twists into the helix.
- **Bases:** drawn as instanced sticks about 1 nm long, at full density.
  - Level of detail: bases fade in below about 120 nm FOV. Above that, the backbone is a coloured tube only.
  - An optional **"Colour by nucleotide"** toggle (A/U/G/C) applies in close-up; otherwise bases take their region's colour.
- **Minimum on-screen size:** fluorophores and the cap never shrink below a few pixels, so they stay readable at 300 nm FOV. The caption notes this.
- **Placement:** the two featured molecules (long and short isoform) are about **700 nm apart**, chosen so they resolve as two separate spots in stage 3; other cell RNAs keep at least 2.6 µm away from them so the stage 3 view shows just the pair.
- **Hybridised duplexes lie flat in the plane of the fold**, all probes on the same side, so the ladders read face-on.

## 5. Visual design

- **Background:** near-black with a faint blue tint (`#05070A`). A subtle drifting-particle field suggests cytoplasm, and a light depth fog in the molecular scene.
- **Cell-stage backdrop:** a dim, out-of-focus microscopy lab behind the cell: benches, several fluorescence microscopes, a confocal enclosure, shelves of reagent bottles, an incubator and centrifuge, a monitor showing an smFISH image, a night window and small instrument LEDs. Built from primitives in code (no assets), rendered at quarter resolution and blurred. It follows the camera's heading (orbiting turns the room) with its tilt halved, so it shows the room even when looking down at the cell. It fades in with the cell scene, is dimmer in MIP view, can be switched off, and is decorative (not to scale).
- **Region colours.** These are dark and saturated, readable but deliberately quieter than the fluorophores.

| Element | Colour token | Suggested value |
|---|---|---|
| m7G cap | `--cap` | `#C9A24A` (muted gold, soft emissive) |
| 5′UTR | `--utr5` | `#1F5A63` (deep teal) |
| CDS | `--cds` | `#2E3478` (deep indigo) |
| 3′UTR common | `--utr3` | `#5E2745` (deep plum) |
| 3′UTR extended | `--utr3ext` | `#6A4A1E` (deep amber) |
| poly(A) | `--polya` | `#3C424C` (slate) |
| Probe DNA | `--probe` | `#D9DCE3` (ivory-grey, slightly glossy) |
| Alexa 546 dye | `--ch-green` | `#3CFF6A` (emissive + bloom) |
| Alexa 647 dye | `--ch-magenta` | `#FF3CF0` (emissive + bloom) |

- **Rendering:**
  - `MeshPhysicalMaterial` for the backbone and probes, with a soft clearcoat.
  - Selective bloom on emissive fluorophores only.
  - Gentle depth of field in the molecular scene. It's on theme, and it adjusts to the zoom distance.
  - ACES tone mapping.
- **Fluorophores:** an emissive core sphere, an additive halo sprite, and a very faint point-light contribution to nearby geometry (limited to the 8 closest dyes).
- **UI:**
  - Semi-transparent dark "glass" panel with thin dividers.
  - Fonts: **Inter** for text and **IBM Plex Mono** for numeric readouts, loaded from Google Fonts.
  - Muted grey labels. Accent colours only for channels.
- **Motion:** eased camera flights. The hybridisation animation is about 6 s. `prefers-reduced-motion` shortens camera flights and replaces the probe animation with a quick fade.

## 6. Stage-by-stage behaviour

### 6.1 Stage 1: Molecule
- **Scene:** the long-isoform mRNA fills the view, its folded rows facing the camera. The short isoform is out of frame, about 700 nm away. Region labels are shown on the molecule nearest the camera target.
- **Controls:**
  - Isoform switch (**Long / Short**): flies the camera to the other molecule.
  - Region labels on/off. Floating labels: *5′ cap, 5′UTR, CDS, 3′UTR, extended 3′UTR, poly(A)*. The extended-3′UTR label appears on the long isoform only.
  - Colour by nucleotide.
  - Auto-rotate.
- **Interaction:** hover a region to highlight it and show its name and length in nt.

### 6.2 Stage 2: Hybridise
- **Scene:** close-up (about 40 nm FOV) on a CDS probe cluster.
- **Hybridisation animation**, `H` to replay:
  1. About 3× excess probes drift in by Brownian motion. Unbound probes are drawn in the same colours but dimmer.
  2. Each correct probe docks at its complementary site and **zips** along it, 5′→3′ against the target, rungs appearing one by one.
  3. Mismatched collisions bounce off (a brief, subtle flash).
  4. An animation speed control (0.25–2×).
- **Wash** (`W`): unbound probes are swept out of frame and fade away. The HUD background readout drops, which links to the SNR lesson.
- **Controls:**
  - Schematic / Helical (`S`).
  - Show 5′/3′ labels.
  - Probe set visibility (CDS / distal 3′UTR).
  - Probes per set, 1–48 (shared with stage 3).
- **Short isoform:** only magenta (CDS) probes bind. Green probes drift past and are washed away, because their target sequence isn't there. Camera button: *"Show short isoform"*.

### 6.3 Stage 3: Diffraction
- **Scene:** both featured molecules in view (about 2.8 µm FOV). Anywhere else in the cell, the RNAs around the camera target are shown (up to 20 PSF spots); the inset image and focal plane are centred on the camera target, the focal plane at the target's height plus the focal offset. FWHM overlays and labels are shown for the spots being looked at (the selected spot and those within ~0.6 µm of the target); click a spot to select it for the profile chart and SNR readout.
- **Scene transition:** as `s` crosses about 400–800 nm, the fluorophores go from sharp points to PSF blobs. A **"Diffraction: off / on"** toggle lets users compare *ideal points* with *what the microscope records*.
- **3D PSF volume:**
  - Ray-marched in a fragment shader, summing analytic Gaussians. There are 2 molecules × up to 96 dyes, so this is cheap.
  - Green and magenta are rendered additively.
  - **FWHM ellipsoid overlay** (wireframe) with dimension labels, e.g. *"202 nm × 688 nm"*. This makes the axial elongation obvious when you rotate.
- **Focal plane:**
  - A translucent plane you can drag along z (`[` and `]` step by 200 nm).
  - A **2D image inset** in the panel shows that optical section: per-channel or merged, with camera pixels, noise and background from §4.5.
  - Spots above or below the plane dim and blur, as in a real z-stack.
- **Controls:**
  - Immersion preset and NA slider. Updates the PSF, ellipsoid and inset live.
  - **Probes per set, 1–48.** Spot brightness and the SNR readout update live. At 1 probe the spot disappears into the noise.
  - Channels: Green (`G`), Magenta (`M`), Merge.
  - Camera noise on/off. Camera pixels on/off. Chromatic offset on/off.
  - Before/after wash: reflects the stage 2 state and can be toggled here too.
- **Line-profile chart** (small canvas in the panel): lateral and axial intensity through the selected spot. Green and magenta curves, with FWHM marked.
- **Teaching moment:** the long-isoform spot is **white** in the merge and the short-isoform spot is **magenta only**. The caption spells this out.

### 6.4 Stage 4: Cell
- **Scene:** an adherent, flattened cell, about 20 × 15 × 6 µm.
  - Translucent membrane using a Fresnel-rim shader.
  - Faint cytoplasmic autofluorescence.
  - Ellipsoidal nucleus about 10 × 8 × 4 µm, with a DAPI channel (a soft blue volume with a noise texture for chromatin).
- **Spots:**
  - About 150 cytoplasmic mRNAs (seeded, randomised positions), mixed long and short isoforms.
  - About 10 nuclear mRNAs.
  - **2 transcription sites** in the nucleus. These are brighter clusters of about 8–15 nascent RNAs. Nascent transcripts that haven't yet been transcribed past the extended 3′UTR carry only CDS probes, so transcription sites look **magenta-dominant** (pinkish-white). Explained in "Learn more".
- **Rendering:** PSF-convolved `Data3DTexture` per channel, about 256×192×48, rebuilt in a Web Worker when NA, probe count, isoform ratio, duplex mode or seed changes, then ray-marched. Every RNA contributes its actual fluorophores (from its molecule), not a point approximation.
- **Zooming in:** hover a spot to see what it is; double-click to zoom to its spot, and again to the molecule (§3).
- **Backdrop:** the dim lab (§5), with a **Lab backdrop** toggle.
- **Controls:**
  - Channels: Green, Magenta, DAPI (`D`), Merge. Cell outline on/off.
  - **3D ↔ Maximum-intensity projection** (`P`). The MIP is the flat 2D image researchers usually look at.
  - Focal plane across the cell thickness, with the 2D inset as in stage 3.
  - **Long-isoform fraction** slider (0–100%, default 60%).
  - **Randomise cell** (new seed).
  - Camera noise.
- **Readout:** *"Spots: 160 · White (long): 96 · Magenta-only (short): 64"*. The counts come from the model, not from image analysis.

## 7. Captions (draft, one per stage)

Each caption card has a 2–3 sentence summary and an expandable **Learn more** section.

1. **Molecule.** *"This is a messenger RNA (mRNA), a copy of a gene the cell uses as a template to make protein. A protective m7G cap sits at the 5′ end, the coding sequence (CDS) lies between two untranslated regions (UTRs), and a poly(A) tail finishes the 3′ end. This gene makes two isoforms that differ only in the length of their 3′UTR."*
2. **Hybridise.** *"smFISH probes are short DNA strands (~18–20 nt) that match a stretch of the mRNA and pair with it antiparallel. Each carries a single fluorescent dye on its 3′ end. Magenta probes (Alexa 647) tile the CDS and bind both isoforms. Green probes (Alexa 546) target the extended 3′UTR, which only the long isoform has. Unbound probes are washed away."*
3. **Diffraction.** *"Light can't be focused to a perfect point. A microscope images each dye as a blurred spot, the point-spread function (PSF), about 200–240 nm wide and 3–4× longer along the optical axis. All the probes on one mRNA fall inside that blur, so they merge into one bright, diffraction-limited spot. One dye alone is too dim to see; many together make a single mRNA visible."*
4. **Cell.** *"Each spot is one mRNA molecule, so counting spots measures gene expression in individual cells. White spots carry both colours (long 3′UTR); magenta-only spots are the short isoform. The bright spots in the nucleus are transcription sites, where new RNAs are being made."*

**Simplifications**, noted under Learn more:
- Made-up sequence.
- 10 probes shown by default (real designs use about 20–48).
- No RNA secondary structure or bound proteins.
- The PSF is an idealised Gaussian.
- Both dyes treated as equally bright.
- Fluorophores drawn with a minimum on-screen size.
- Each mRNA drawn as a tidy folded strand (one of a few shapes) rather than a real, irregular fold.
- The lab behind the cell is decoration, not to scale.

## 8. Global UI

- **Layout (desktop):**
  - The viewport takes about 70% of the width. The control panel on the right takes about 30%, with a maximum of 380 px.
  - Top-left HUD: stage name, scale bar and readouts.
  - Bottom-left: caption card.
  - Stage buttons 1–4 at the top of the panel. Controls for the current stage below them. Channel toggles are always visible.
- **Mobile/tablet:** the panel becomes a bottom sheet that can be dragged. Touch orbit and pinch-zoom (pinch drives `s`). No horizontal scrolling. 16 px side gutters.
- **Presentation mode** (`F`): hides the panel, enlarges captions and the HUD, and shows larger key hints. For lectures and projectors.
- **Shareable state:** the URL hash holds the stage, camera, NA, immersion, probe count, channels, wash state, isoform ratio and seed. Example: `#stage=3&na=1.4&imm=oil&n=10&ch=gm`. This lets a lecturer link straight to a particular view.
- **Help overlay** (`?`): lists controls and shortcuts.
- **Screenshot** button: saves a PNG of the viewport.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `1`–`4` | Go to stage |
| `H` | Replay hybridisation |
| `W` | Wash |
| `S` | Schematic ↔ Helical |
| `G` / `M` / `D` | Toggle green / magenta / DAPI channel |
| `P` | 3D ↔ MIP (stage 4) |
| `[` / `]` | Move focal plane down / up |
| `R` | Reset camera for the current stage |
| Arrow keys | Pan (Shift: bigger steps) |
| `+` / `−` | Zoom in / out |
| Shift/Ctrl/⌘ + drag | Pan |
| Double-click | Zoom into the RNA (or point) under the cursor |
| `F` | Presentation mode |
| `?` | Help |

## 9. Accessibility and performance

- **Accessibility:**
  - All controls reachable by keyboard, with visible focus rings.
  - ARIA labels on custom controls.
  - Captions available as real text, readable by screen readers.
  - Green/magenta is the colour-blind-friendly default. An optional alternative lookup table (cyan/orange) is a stretch goal.
  - Honours `prefers-reduced-motion`.
- **Performance targets:**
  - 60 fps on a 2020 MacBook Air (M1) and a mid-range Windows laptop with integrated graphics.
  - 30 fps or more on a recent iPhone or iPad.
- **Automatic quality downgrade** on low-end devices, e.g. when frame time stays above 22 ms: turn off depth of field, lower bloom resolution, halve ray-march steps and the cell volume texture size, and cap device pixel ratio at 1.5.
- **Budgets:** initial JS bundle ≤ 400 kB gzipped. No large binary assets; everything is generated in code.
- **Requirements:** WebGL2 (needed for `Data3DTexture`). Show a friendly fallback message if it isn't available.

## 10. Technical architecture

- **Stack:**
  - Vite and TypeScript (strict), with `three` (current release).
  - `camera-controls` for smooth camera flights, orbit and dolly.
  - `postprocessing` (pmndrs) for selective bloom and depth of field.
  - No UI framework: a custom HTML/CSS panel driven by a small observable store.
  - Vitest for unit tests and Playwright for visual smoke tests.
- **Deployment:** a static build, hosted on GitHub Pages or Netlify.

```
src/
  main.ts                 # bootstrap, render loop
  state/store.ts          # observable app state + URL-hash sync
  core/
    renderer.ts           # WebGLRenderer, composer, quality manager
    scaleController.ts    # s ↔ per-scene camera distance/opacity, stage flights
    sceneManager.ts       # cross-fade compositing of the three scenes
  data/
    rng.ts                # seeded PRNG
    transcript.ts         # made-up sequence + regions + isoforms
    probes.ts             # probe design (revcomp, GC, spacing, Tm approx)
    dyes.ts               # dye table
    optics.ts             # PSF σ/FWHM, immersion presets, noise model
    conformation.ts       # folded-strand geometry, hybridised pose, dye positions
    model.ts              # molecule library (shape variants, nascent prefixes), placements
    population.ts         # every cell RNA as a record → molecule model + fluorophores
    cell.ts, volume.ts    # cell shape, spot seeds, PSF-convolved volume
  scenes/
    molecular/            # backbone spline, instanced bases, probes, hybridisation anim
    optical/              # PSF ray-march volume, FWHM ellipsoid, focal plane
    cell/                 # membrane, nucleus/DAPI, spot field, volume texture, lab backdrop
  workers/volume.worker.ts  # PSF-convolved Data3DTexture builder
  shaders/                # psfRaymarch, slice, mip, fresnel, halo
  ui/                     # panel, hud, captions, tooltip, inset image, profile chart, help
tests/                    # vitest + playwright
```

- **Everything runs from shared state.** The molecular fluorophore positions (in nm) are the single source of truth. The optical and cell scenes read from them rather than duplicating data.
- **The 2D inset and the MIP** are computed on the GPU, with a render-to-texture pass sampling the same PSF function or texture as the 3D view. So the 2D and 3D views always agree.

## 11. Delivery phases and acceptance criteria

**Phase 0: Scaffold**
- Vite + TypeScript + three set up, lint and format configured, CI build, deployment to Pages.
- Empty dark scene, panel shell, store, URL-hash sync.
- ✅ Loads in the browser, and changing the URL hash changes the stage label.

**Phase 1: Molecule and hybridisation (stages 1–2)**
- Transcript and probe generation, with unit tests.
- Backbone, instanced bases with LOD, cap, poly(A), region colours and labels.
- Probes in both modes (schematic and helical), fluorophores with bloom.
- Hybridisation animation, wash, isoform switch, tooltips.
- ✅ The short isoform binds only magenta probes. Probes are antiparallel with dyes on their 3′ ends. 60 fps on an M1 Air.

**Phase 2: Diffraction (stage 3) and the continuous zoom**
- Scale controller and cross-fade from the molecular to the optical scene.
- PSF ray-march, FWHM ellipsoid, NA and immersion controls.
- Focal plane with 2D inset, noise, pixels, chromatic offset, probe-count slider and SNR readout, line-profile chart.
- ✅ Scrolling out from stage 2 to stage 3 is continuous. FWHM readouts match §4.4 within ±2 nm. The long spot is white in the merge and the short spot is magenta.

**Phase 3: Cell (stage 4)**
- Membrane, nucleus with DAPI, spot field, transcription sites.
- Volume worker, 3D/MIP toggle, isoform ratio slider, counts readout.
- ✅ Cross-fade from the optical to the cell scene. Changing NA or probe count rebuilds the volume in under 500 ms on an M1 Air.

**Phase 4: Polish**
- Captions and Learn more, presentation mode, help overlay, screenshot button.
- Mobile bottom sheet, reduced motion, accessibility pass, quality manager.
- ✅ Keyboard-only walkthrough of all stages works. 30 fps or more on an iPad. Lighthouse accessibility score ≥ 90.

**Stretch goals** (after phase 4):
- **Resolution demo:** drag the two molecules together and watch the spots merge at the diffraction limit.
- "True colour" toggle for the dyes.
- Automatic spot-detection overlay: rings plus colocalisation classification, teaching the analysis step.
- Confocal PSF option.
- Alternative colour-blind lookup table.
- Guided "tour" mode that steps through all four stages with captions.

## 12. Testing

- **Unit tests (Vitest):**
  - Reverse complement.
  - Probe spacing and GC% limits.
  - No overlapping probes.
  - CDS has no in-frame stop codons.
  - `AAUAAA` present at both polyadenylation sites.
  - Distal-set probes fall only in the extended 3′UTR.
  - PSF FWHM fixtures from §4.4.
  - NA limited below n.
  - URL-hash round-trip.
  - Folded strand: size, flatness, no self-crossings, CDS/distal clusters within one spot.
  - Population: unique records, isoform counts match, dyes near their RNA, nascent prefixes, rigid placement.
- **Visual smoke tests (Playwright):** screenshot each stage at a fixed seed and camera, and check that rendering isn't blank. Manual visual review stays the main check for beauty.

## 13. Out of scope

- Loading real sequences, probe designs or microscope images.
- Image-analysis pipelines, apart from the stretch-goal overlay.
- Ribosomes, translation, RNA-binding proteins, RNA secondary structure.
- Super-resolution methods and multiplexed FISH (MERFISH, seqFISH).

## 14. References

- Femino AM, Fay FS, Fogarty K, Singer RH (1998). Visualization of single RNA transcripts in situ. *Science* 280:585–590.
- Raj A, van den Bogaard P, Rifkin SA, van Oudenaarden A, Tyagi S (2008). Imaging individual mRNA molecules using multiple singly labeled probes. *Nature Methods* 5:877–879.
- Zhang B, Zerubia J, Olivo-Marin J-C (2007). Gaussian approximations of fluorescence microscope point-spread function models. *Applied Optics* 46:1819–1829.
- Design inspiration: [The Plane of Focus](https://sael.net/plane-of-focus/).
