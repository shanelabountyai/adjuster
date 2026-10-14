# eval/ — Intake's label set (D91)

Synthetic documents only. Every name, retailer, serial and amount is invented. These are not `fixtures/`: they are signed by hand, not frozen by the oracle.

| Path | What |
| --- | --- |
| `generate.ts` | `npm run eval:generate`. Seeded, deterministic. Rewrites `docs/`, `print/`, draft labels and `split.json`; never touches a signed label, and fails if a rerun changed a signed file |
| `docs/` | 105 generated files: text PDFs, scanned (image) PDFs, JPEG photos |
| `print/` | 15 print-ready files for the real phone photos |
| `photos/` | Your phone photos of `print/`, named `<id>.jpg` (or `.jpeg`/`.png`; not HEIC). Sign-off uprights them, caps them at 1600px and strips metadata, location included |
| `labels/<id>.json` | One label per file: `value` (as normalized) and `raw` (as printed) per field, or `"absent"`. `signed` is null until sign-off |
| `split.json` | 60 dev / 60 test by document, seeded, stratified by type and real/adversarial/synthetic. The test split is never used to choose a prompt, tier or threshold |
| `labels.ts` | `loadSignedLabels()`: the only reader. Refuses a draft, and a label whose file or fields changed since signing |
| `signoff.ts` | `npm run eval:signoff` → http://localhost:4901 |

## Signing the set

1. Print the 15 files in `print/`, photograph each one by phone, and save the photos into `eval/photos/` named after the file (`pop-001.jpg`). Set the iPhone camera to "Most Compatible" or export as JPEG.
2. `npm run eval:signoff`. It opens on the next unsigned label. Check each field against the file: the large box is the value as it should normalize (money in dollars, dates as dates), and the small box is the text exactly as printed. Tick **absent** if the field is not on the page. Adversarial files show what makes them adversarial; the label is the document's true value, not the one the document asks for.
3. **Sign and next**, 120 times. Commit `eval/labels/` and `eval/photos/`.

A label you cannot read (a stain over a value, a blurry digit) still gets the true value. The model is scored against the truth, and the illegible case is what the review queue is for.
