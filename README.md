# smFISH Viewport

An interactive three.js visualisation of single-molecule FISH for teaching and outreach. It is one continuous zoom:

1. **Molecule:** an mRNA with its regions coloured.
2. **Hybridise:** 3′-labelled probes bind in two colours.
3. **Diffraction:** the probes blur into diffraction-limited spots.
4. **Cell:** the spots sit in a whole cell.

The design and science are specified in [spec.md](spec.md).

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run build` | Type-check and build a static site into `dist/` (relative paths, so it can be hosted anywhere) |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests (Vitest): transcript, probe design, PSF fixtures, cell model, volume, URL hash |
| `npm run test:e2e` | Visual smoke tests (Playwright, uses the locally installed Chrome) |
| `npm run lint` / `npm run format` | ESLint / Prettier |

The WebGL2 app needs a recent Chrome, Edge, Firefox or Safari. Append `?quality=low` or `?quality=medium` to force a lower quality level. Otherwise the app steps quality down automatically if frames are slow.

`.github/workflows/deploy.yml` lints, tests and builds on every push. On `main` it also deploys to GitHub Pages; set the repository's Pages source to "GitHub Actions".

## Using it

- **Scroll or pinch** to zoom through the scales. **Drag** to orbit.
- **Shift-, Ctrl- or ⌘-drag** to pan up/down/left/right (also right-drag, two-finger drag, or the arrow keys).
- **Double-click** any RNA in the cell to zoom to its spot, and again to see the molecule with its probes.
- Press **1–4** to fly to a stage, or **?** to see all shortcuts.
- The **URL** updates as you explore (stage, camera, NA, probe count, channels, wash, isoform ratio and seed), so a lecturer can copy it and link straight to a view.
- **F** enters presentation mode for projectors.

## How it's built

```
src/
  main.ts, app.ts          bootstrap, store ↔ scene wiring, render loop, input
  state/store.ts           observable app state + URL-hash sync
  core/                    renderer + compositing, camera rig and flights, scale axis, quality manager
  data/                    pure, tested models: rng, transcript, probes, dyes, optics, conformation (folded strand),
                           model (molecule library + placements), population (every cell RNA),
                           world model, cell, volume
  scenes/molecular/        coil backbone (dynamic tubes), bases with LOD, probe animation system
  scenes/optical/          analytic PSF volume, FWHM ellipsoids, focal plane, camera image, profiles
  scenes/cell/             ray-marched cell volume, membrane, nucleus, section/MIP inset, lab backdrop
  workers/volume.worker.ts builds the PSF-convolved cell volume off the main thread
  ui/                      panel, HUD, captions, tooltip, help, keyboard
```

Key implementation choices:

- **Three scenes, one camera.** A single camera-controls rig works in cell-world µm, with z as the optical axis.
  - The molecular scene (nm) and the optical scene (µm, centred on the featured molecules) derive their cameras from it each frame.
  - A final pass cross-fades them by `s = log10(FOV in nm)`.
  - Only the molecular layer gets depth of field, bloom and ACES tone mapping. The optical and cell layers are display-mapped per channel, so green + magenta stays exactly white.
- **Fluorophores are the single source of truth.** The optical and cell scenes read the bound dye positions from the molecular model every frame. What you saw bind is what gets blurred.
- **The PSF volume isn't ray-marched.** Each dye's 3D Gaussian is integrated along the view ray in closed form, which is exact for emission-only rendering and cheap even at 48 probes per set. The 2D camera image uses the same Gaussian parameters on the CPU, with Poisson shot noise and Gaussian read noise.
- **The cell volume** (256×192×48, RGBA8 with square-root encoding) is built in a worker:
  - Spots are splatted directly as separable Gaussians. That is fast: NA and probe-count changes rebuild in about 20 ms, and a new cell seed in about 70 ms.
  - The DAPI chromatin texture is cached per cell seed.
- **Every RNA is a molecule.** Each cell RNA is a record (position, rotation, shape variant) resolved against a small molecule library. Near the camera target the molecular scene builds up to 8 of them in full detail, and the optical scene draws PSFs for up to 20; the cell volume splats every RNA's actual dyes. So you can zoom continuously into any spot.
- **The folded strand** keeps the RNA to scale and uncrossed while staying compact: the long isoform's row length stacks its CDS and distal probe clusters in one diffraction-limited spot (~100 nm apart).
- **The lab backdrop** is a procedural room rendered at quarter resolution from a fixed eye that follows the camera heading (tilt halved), blurred in the composite pass behind the cell layer.
- **Stage 2 camera.** The close-up is chosen from the predicted *bound* pose, looking side-on at the probe cluster from the least cluttered direction. A near clip plane cuts away strands in front.

## Dev helpers

`scripts/shot.mjs`, `scripts/flight.mjs`, `scripts/interact.mjs`, `scripts/zoomcell.mjs` and `scripts/perf.mjs` capture screenshots, flight sequences, hover/zoom checks and frame timings from a running dev server with headless Chrome. For example:

```sh
node scripts/shot.mjs /tmp/shots s3='stage=3@3000' mip='stage=4&mip=1@4000'
```

## Differences from spec.md

| Spec | What the build does, and why |
|---|---|
| 2D inset computed on the GPU | Computed on the CPU from the same PSF parameters. It needs Poisson noise per pixel and it is small (64² or 256² pixels). The spec's goal, that 2D and 3D always agree, still holds. |
| "Spots above or below the plane dim and blur" | The Gaussian model makes out-of-focus spots **dim** but not wider. It's listed under "idealised Gaussian" in the simplifications. |
| Stage FOVs 300 nm / 2 µm | 330 nm and 2.8 µm, which frame the folded strand and the two PSF columns better. (spec.md now records these.) |
| Minimum on-screen size for fluorophores and the cap | Also applied to the RNA backbone, and the strand glows faintly when zoomed out, so it reads at 300 nm. The caption notes it. |
| Stretch goals | Not started. |
