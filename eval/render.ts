import sharp, { type Sharp } from 'sharp';

// One page layout, two renderings: a text PDF (real text layer, base-14 fonts, nothing embedded) and an SVG that
// sharp rasterizes for the degraded variants (D91 c). Coordinates are points from the top-left; y is the baseline.

export type Font = 'sans' | 'bold' | 'mono' | 'hand';
export type Item =
  | { t: 'text'; x: number; y: number; size: number; text: string; font?: Font }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { t: 'path'; points: [number, number][] }; // a pen stroke (signatures, crack lines)
export type Page = { w: number; h: number; items: Item[] };

export const LETTER = { w: 612, h: 792 };

// ---- text PDF

const PDF_FONT: Record<Exclude<Font, 'hand'>, string> = { sans: 'F1', bold: 'F2', mono: 'F3' };
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
const n = (v: number) => String(Math.round(v * 100) / 100);

function assemble(objects: (string | Buffer)[]): Buffer {
  // Object i (1-based) is objects[i-1]; xref offsets are byte offsets, so everything is built as Buffers.
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n')]);
    offsets.push(at);
    parts.push(body);
    at += body.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const stream = (dict: string, data: Buffer) =>
  Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);

export function textPdf(page: Page): Buffer {
  const ops: string[] = ['0 g 0 G 0.8 w'];
  for (const it of page.items) {
    if (it.t === 'text') {
      if (it.font === 'hand') throw new Error('hand font has no PDF rendering; rasterize the page');
      ops.push(`BT /${PDF_FONT[it.font ?? 'sans']} ${n(it.size)} Tf ${n(it.x)} ${n(page.h - it.y)} Td ${pdfString(it.text)} Tj ET`);
    } else if (it.t === 'line') ops.push(`${n(it.x1)} ${n(page.h - it.y1)} m ${n(it.x2)} ${n(page.h - it.y2)} l S`);
    else ops.push(it.points.map(([x, y], i) => `${n(x)} ${n(page.h - y)} ${i ? 'l' : 'm'}`).join(' ') + ' S');
  }
  const font = (base: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    font('Helvetica'),
    font('Helvetica-Bold'),
    font('Courier'),
    stream('', Buffer.from(ops.join('\n'), 'latin1')),
  ]);
}

/** A scanned PDF: one JPEG, full page, no text layer. */
export async function imagePdf(jpeg: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(jpeg).metadata();
  const w = 612;
  const h = Math.round((w * height!) / width!);
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg),
    stream('', Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`)),
  ]);
}

// ---- SVG and raster

const SVG_FONT: Record<Font, string> = {
  sans: 'font-family="Helvetica, Arial, sans-serif"',
  bold: 'font-family="Helvetica, Arial, sans-serif" font-weight="bold"',
  mono: 'font-family="Courier New, Courier, monospace"',
  hand: 'font-family="Bradley Hand, Comic Sans MS, cursive" font-weight="bold"',
};
const xml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function svg(page: Page, background = '#ffffff', extra = ''): string {
  const body = page.items.map((it) => {
    if (it.t === 'text') return `<text x="${n(it.x)}" y="${n(it.y)}" font-size="${n(it.size)}" ${SVG_FONT[it.font ?? 'sans']}>${xml(it.text)}</text>`;
    if (it.t === 'line') return `<line x1="${n(it.x1)}" y1="${n(it.y1)}" x2="${n(it.x2)}" y2="${n(it.y2)}" stroke="#000" stroke-width="0.8"/>`;
    return `<polyline points="${it.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="none" stroke="#000" stroke-width="1"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.w}" height="${page.h}" viewBox="0 0 ${page.w} ${page.h}"><rect width="100%" height="100%" fill="${background}"/>${body.join('')}${extra}</svg>`;
}

const DPI_SCALE = 150 / 72;
export const rasterize = (svgText: string, scale = DPI_SCALE) => sharp(Buffer.from(svgText), { density: 72 * scale });
const jpeg = (img: Sharp, quality: number) => img.jpeg({ quality, mozjpeg: false }).toBuffer();

export const cleanJpeg = (svgText: string) => jpeg(rasterize(svgText), 85);

/** A crooked flatbed scan: rotated a few degrees on white. */
export const rotatedScan = (svgText: string, degrees: number) =>
  jpeg(rasterize(svgText).rotate(degrees, { background: '#ffffff' }).modulate({ brightness: 0.97 }), 70);

/** A phone photo of a printout: lost resolution, soft focus, uneven light. */
export async function lowResPhoto(svgText: string, page: Page): Promise<Buffer> {
  const shade = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.w * DPI_SCALE}" height="${page.h * DPI_SCALE}"><defs><radialGradient id="g" cx="35%" cy="30%" r="90%"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#3a3020" stop-opacity="0.45"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  const full = await rasterize(svgText).composite([{ input: Buffer.from(shade) }]).png().toBuffer();
  const small = await sharp(full).resize({ width: Math.round(page.w * DPI_SCALE * 0.35) }).toBuffer();
  return jpeg(sharp(small).resize({ width: Math.round(page.w * DPI_SCALE * 0.7) }).blur(0.9), 55);
}

/** A coffee ring placed by the caller (it may land on a value; the sign-off catches an unreadable label). */
export function stainRing(cx: number, cy: number, r: number): string {
  return `<g opacity="0.55"><ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r)}" ry="${n(r * 0.9)}" fill="#c8a165" fill-opacity="0.35" stroke="#7a5122" stroke-width="5" stroke-opacity="0.6"/></g>`;
}
