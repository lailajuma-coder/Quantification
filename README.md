# KidneyQuant

![KidneyQuant](public/og.png)

KidneyQuant is a private, self-hostable kidney tissue stain-analysis workbench. It supports project-specific thresholds while keeping the analysis workflow consistent across stains.

> **Research use only.** KidneyQuant is an experimental research workflow, not a medical device, diagnostic system, or validated clinical tool.

## Current capabilities

- Unsigned, uncompressed, single-plane **BlackIsZero grayscale or interleaved RGB TIFF** decoding locally in the browser; compressed, palette, CMYK, two-sample, alpha, planar-separate, signed, floating-point, and multipage TIFF variants fail closed
- JP2-family and ND2 decoding through the included private Python companion service
- Stain modes for alpha-SMA IF, vimentin IF, lotus lectin/LTL IF, Sirius Red, PAS, and H&E
- Simultaneous RGB and composite/threshold-overlay previews beside independently scrolling desktop controls
- Separate minimum, maximum, brightness, and Auto controls for every RGB channel in the left sidebar; image panels stay free of controls for screenshots; fluorescent channel edits persist when switching between named stains
- Per-channel automatic brightness and sampled Otsu threshold suggestions, with remembered manual overrides for the current image; live previews are downsampled, while Analyze all channels measures full-resolution analysis copies
- Color-coded RGB channel views and numeric threshold entry: 0–255 for converted fluorescence; 0–1 for Sirius Red magenta
- Background-worker image decoding with cancellable loading
- Sidebar co-staining status and editable stain/channel assignments (including DAPI, ApoJ/Clusterin, and custom markers); selecting a marker switches its preview and fluorescence measurement channel
- Antibody/fluorophore notes and stain/channel assignments preserved in CSV/JSON exports
- Configurable fluorescence signal channel and positive-stain thresholds
- Connected slide-background detection with exclusion or separate reporting
- Analyst-defined rectangular ROI categories for glomeruli, podocytes, proximal tubules, all tubules, and interstitial tissue; these labels do not perform anatomical segmentation
- Overlay, original-image, and binary-mask review views
- Provenance-rich CSV and JSON export with source identity/SHA-256, processing and plane metadata, complete ROI/settings snapshot, threshold-positive fraction, all-analyzed-pixel score statistics, four-neighbor grid perimeter, score sum, background metrics, algorithm identifiers, and warnings

## Run locally for development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`. Browser-local TIFF analysis works without the companion; JP2-family and ND2 input require the self-hosted stack.

## Local ND2/JP2 decoder (macOS/Linux)

From the repository root (the folder containing `package.json`), create `.dev.vars` with:

```dotenv
ANALYSIS_SERVICE_URL=http://127.0.0.1:8000
```

The Cloudflare development runtime reads `.dev.vars`. Keep it local; it is ignored by Git. Restart `npm run dev` after changing it.

In a second terminal, also at the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r analysis-service/requirements.txt
.venv/bin/python -m uvicorn main:app --app-dir analysis-service --host 127.0.0.1 --port 8000
```

Keep both servers running. `http://127.0.0.1:8000/health` should return `{"status":"ok"}`. Upload through the website at `http://localhost:3000`; the decoder has no homepage.

A `/api/decode` 501 means the service URL is missing. A 502 means the proxy request failed; inspect the website terminal for the underlying exception. The proxy uses manual redirect handling because the Cloudflare runtime rejects `redirect: 'error'`, and it refuses companion redirects rather than forwarding uploaded data to another address.

## Self-host the private stack

The production request path is:

```text
Nginx Proxy Manager -> auth (Basic Auth + limits/headers) -> web -> analysis companion
```

Only `auth` joins the external `nginx-proxy-manager_default` network. `web` and `analysis` have no published host ports and communicate on an internal Docker network.

Set `NEXT_PUBLIC_SITE_ORIGIN`, `KIDNEYQUANT_HTPASSWD_PATH`, `KIDNEYQUANT_PROXY_ASSERTION_PATH`, and the smallest correct `KIDNEYQUANT_TRUSTED_PROXY_CIDR` in a protected Compose `.env` file. The proxy assertion is a separate externally generated 256-bit secret file shared only by `auth` and `web`; never place its value in Compose or source control. Then build and start the stack:

```bash
docker compose up -d --build
```

Configure Nginx Proxy Manager to forward the HTTPS proxy host to `kidneyquant-auth` on port `8080`. Do not forward NPM directly to `web` or publish the backend ports. See [SELF_HOSTING.md](SELF_HOSTING.md) for the complete deployment and validation procedure.

## Data handling and limits

- TIFF is decoded in the browser and is not sent to the server.
- JP2-family and ND2 files are sent through the authenticated web route to the private companion. The companion uses request-scoped temporary storage and deletes the upload after decoding.
- The authenticated ingress and companion are configured for a **512 MiB maximum upload**; browser-local TIFF/JPEG demonstration input has a stricter **128 MiB** limit. Reverse proxies in front of `auth` must use at least the intended companion limit or document the lower effective limit.
- Decoding fails closed above **8 million pixels per selected plane** or more than **3 retained channels/components**.
- The experimental pipeline selects the first available ND2 plane. Supported unsigned samples up to 16 bits are preserved as the source; a separate 8-bit copy is used for the macro workflow. ND2/JP2 native samples use a lossless gzip transport, requiring the updated web and companion services. Conversion ranges are recorded for every image. Signed and floating-point data are not supported.
- CSV and JSON exports stay with the user. Phase 1 has no project database or image archive.

## Bundled demonstration asset

`public/synthetic-demo-tile.jpg` is procedurally generated by `scripts/generate-synthetic-demo.py` using seed `20260831`. It contains geometric texture only: **no patient, specimen, stain acquisition, microscope, institution, or external licensed source**. It exists solely to exercise the interface and must not be interpreted as biological reference material.

## Private review copy

The current ChatGPT Site is an owner-only review deployment:

https://kidneyquant-lab-test.nerfan143.chatgpt.site

It is not the required production host. The application and private companion can be hosted on infrastructure and a domain controlled by the lab.

## Scientific scope

Structure-specific regions are selected and reviewed by the analyst; they are not produced by a validated automatic histology model. First-plane selection, preview scaling, thresholding, background handling, and ROI measurements are experimental.

Before publication—and before any use beyond exploratory research—validate thresholds, channel assignments, background tolerance, ROI selection, first-plane behavior, preview scaling, and agreement with the lab's Fiji workflow on a blinded test set. Add pixel calibration when physical units such as µm² or µm are required. Do not use KidneyQuant for diagnosis, treatment decisions, or other clinical purposes.

### Macro workflows and reference tiles

Fluorescence uses a separate 8-bit copy before display adjustments. Conversion follows ImageJ TypeConverter short-to-byte scaling: round((sample-min)*256/(max-min+1)), clamped to 0–255. Original 8-bit inputs are preserved. Defaults use each source channel's full-image extrema; enter Fiji's import display ranges in Conversion settings if different. The ND2 importer does not provide an exact Fiji/Bio-Formats display-range guarantee. Validate against matching imported images before treating outputs as interchangeable.

Sirius Red computes (max(R,G,B)-G)/max(R,G,B) on the RGB analysis copy, with fractional thresholds 0–1; undefined all-black scores are excluded. This is a separate score, not a red channel threshold. Its exported magenta view and RGB composite accompany measurements.

Open a folder for one sample. Save reviewed reference tiles (typically 10), keeping a fixed maximum per channel. The app shows individual minima and averages the reference minima within each sample ID first, then averages those sample means equally within the group. It displays the resulting mean and applied value (nearest integer for 8-bit, four decimals for magenta). Accepting locks thresholds. Full-image folder quantification is sequential and uses those thresholds on all tiles, including reference tiles. Failed files are listed; stopping retains completed tiles. For glomeruli or manual tissue crops, draw freehand or rectangular regions on each tile and Analyze all channels to save that tile. Outlines are never reused on other images. Overlapping regions form a union, and percentages use that selected region after any explicit background exclusion.

Normal-color images remain the default. Show counted pixels is optional; there is no Mask tab or automatic switch to detection. Screenshots contain clean images plus ROI outlines, and exports include separate detection screenshots. Display settings do not affect the already-converted analysis copy.

Next sample preserves completed results and keeps the group's references and accepted thresholds. Save group / switch group saves that group's thresholds and staining assignments; Resume saved group restores them. Group and sample IDs are generic: no species or organ is assumed. Excel uses staining tabs, horizontal sample column groups and vertically stacked tiles with baseline/positive rows and neighboring images, plus Reference thresholds and Provenance tabs. ND2 calibrated pixel dimensions, when available, are used for Excel Area and IntDen; otherwise units are explicitly pixels. RawIntDen remains the uncalibrated sum. JSON/CSV describe the current analysis; Excel contains collected samples. Results live in the browser session: export before closing or refreshing.

Positive mean, sample standard deviation, min, max and raw integrated intensity use only counted pixels. Zero-positive statistics are recorded as zero. All-region statistics are retained separately. Four-neighbor mask perimeter is not Fiji's ROI perimeter. ND2 calibration, conversion ranges, ROIs, stain assignments and per-tile thresholds are recorded in provenance. The app does not infer glomeruli or automatically validate threshold selection.

### ND2 source channel colors

The companion reads ND2 acquisition channel colors. When three channels have distinct dominant red, green and blue colors, it reorders their native samples into RGB display order without rescaling intensities. For example, a blue/green/red acquisition becomes source 3 → Red, source 2 → Green, source 1 → Blue. The viewer discloses this mapping, and CSV, JSON and Excel provenance include the original zero-based source indices and acquisition channel names. Missing, ambiguous or incomplete colors retain source order and are explicitly marked unverified; marker identities are not inferred from acquisition names. Restart the Python companion and reopen existing ND2 images after upgrading. Previous measurements made with swapped channels must be rerun.

### Grouped samples and GraphPad exports

Use a group ID, a sample ID, and one folder of tile images for that sample. The image dropdown jumps directly to a filename without stepping through adjacent tiles. Reference tiles can come from multiple sample IDs: use Next sample to collect more references before accepting the group average. Once accepted, all samples in that group use the same minimum and maximum per channel. Other groups may use separate threshold sets; record the selection rationale because threshold differences can affect comparisons. The accepted group thresholds and individual reference choices are exported. Re-analyzing the same tile for the same group, sample, stain and region replaces its saved result.

Staining sheets retain image pairs and measurements for every tile, arranged in sample column groups. Tile values contains every measured tile's percentage, filename, group, sample ID and thresholds. GraphPad tiles sheets provide a nested layout: groups across, sample IDs in subcolumns, all tile values down rows. Groups with fewer sample IDs have blank subcolumns, and missing measurements stay blank rather than becoming zeros. Each staining/channel/region combination is separate. Copy the numerical block into an appropriately configured Prism Nested table and retain its group/sample labels. Tile row numbers are not matching or repeated measures between samples. See [GraphPad's nested table documentation](https://www.graphpad.com/guides/prism/10/user-guide/nested-tables.htm) for the data arrangement.

Sample summary and Group summary are additional descriptive outputs, not replacements for tile values. Sample means give each valid tile equal weight; group means give each sample mean equal weight. Group SD uses the sample standard deviation across sample means (N−1), and SEM is SD/sqrt(N). SD/SEM are blank with fewer than two samples; empty analyzed regions are excluded and counted explicitly. Multiple threshold ranges within a group are flagged. No significance tests or p-values are calculated automatically; the experimental design and dependence of tiles within samples must inform the analysis in Prism. Export before refreshing: collected data and saved group settings last only for the current browser session.

The Analysis scope selector chooses all available channels or a specific red, green, blue, or grayscale channel for both individual tiles and folder runs. Only the requested channels are quantified and added to results/exports; the four-channel viewer and image screenshots remain available. Re-analyzing a saved tile replaces its earlier results with the newly selected scope. Sirius Red remains a single derived magenta-score measurement.
