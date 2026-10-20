import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { OTHER_TYPE } from '@/intake/schema';
import { refusal } from './local-only';
import { EVAL_DIR, LABEL_DIR, labelIds, loadSchema, readLabel, shapeProblems, sign, unsignedReason, type FieldLabel, type Label } from './labels';

// `npm run eval:signoff` (D91 e): one file beside its draft label; confirm or fix each field, then sign. Signing is
// the hand labeling. Local only, no dependencies beyond sharp (for the real photos). Port 4901, beside the app's 4900.

const PORT = Number(process.env.PORT ?? 4901);
const SIGNER = execSync('git config user.name', { encoding: 'utf8' }).trim() || 'unknown';
const schema = loadSchema();
const PHOTO_DIR = join(EVAL_DIR, 'photos');
const PHOTO_MAX = 1600;
mkdirSync(PHOTO_DIR, { recursive: true });

/** Pair a dropped phone photo with its label by file name: <id>.jpg|jpeg|png, any case. Upright it, cap it at
 * 1600px and drop its metadata (location included). An already-adopted file is left byte-for-byte alone, so a
 * signature on it survives. */
async function adoptPhoto(id: string): Promise<'ok' | 'missing'> {
  const target = join(PHOTO_DIR, `${id}.jpg`);
  const found = readdirSync(PHOTO_DIR).find((f) => /^(.+)\.(jpe?g|png)$/i.exec(f)?.[1] === id);
  if (!found) return 'missing';
  const src = join(PHOTO_DIR, found);
  const meta = await sharp(src).metadata();
  if (src === target && !meta.exif && Math.max(meta.width!, meta.height!) <= PHOTO_MAX) return 'ok';
  const out = await sharp(src).rotate().resize({ width: PHOTO_MAX, height: PHOTO_MAX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  writeFileSync(target, out);
  if (src !== target) unlinkSync(src);
  return 'ok';
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dollars = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const fieldsOf = (label: Label) => (label.type === OTHER_TYPE ? [] : schema.types[label.type] ?? []);

function page(label: Label, errors: string[] = [], photo: 'ok' | 'missing' = 'ok'): string {
  const ids = labelIds();
  const signedCount = ids.filter((id) => !unsignedReason(readLabel(id), schema)).length;
  const i = ids.indexOf(label.id);
  const reason = unsignedReason(label, schema);
  const ext = extname(label.file).toLowerCase();
  const viewer = photo === 'missing'
    ? `<p class="warn">No photo yet. Print <a href="/file/print/${esc(label.id)}.pdf">print/${esc(label.id)}.pdf</a>, photograph it, and save it as <code>eval/photos/${esc(label.id)}.jpg</code> (JPEG or PNG, not HEIC).</p>`
    : ext === '.pdf' ? `<embed src="/file/${esc(label.file)}" type="application/pdf">` : `<img src="/file/${esc(label.file)}" alt="${esc(label.id)}">`;
  const rows = fieldsOf(label).map((f) => {
    const l = label.fields[f.name];
    const absent = l === 'absent' || l === undefined;
    const v = absent ? '' : l.value;
    const input = f.kind === 'bool'
      ? `<select name="${f.name}.value"><option${v === true ? ' selected' : ''}>true</option><option${v === false ? ' selected' : ''}>false</option></select>`
      : f.kind === 'date' ? `<input type="date" name="${f.name}.value" value="${esc(v)}">`
      : f.kind === 'cents' ? `<input name="${f.name}.value" value="${absent ? '' : dollars(v as number)}" inputmode="decimal" placeholder="1099.00">`
      : `<input name="${f.name}.value" value="${esc(v)}">`;
    const raw = f.kind === 'bool' ? '' : `<input class="raw" name="${f.name}.raw" value="${esc(absent ? '' : (l as { raw?: string }).raw ?? '')}" title="exactly as printed">`;
    return `<tr><th>${f.name}<small>${f.kind}</small></th><td>${input}${raw}</td><td><label><input type="checkbox" name="${f.name}.absent"${absent ? ' checked' : ''}> absent</label></td></tr>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-off ${esc(label.id)}</title><style>
  body{font:14px system-ui;margin:0;display:grid;grid-template-columns:1fr 520px;height:100vh;color:#222;background:#fafafa}
  .view{background:#555;display:flex;align-items:center;justify-content:center;overflow:auto}
  .view embed{width:100%;height:100%}.view img{max-width:100%;max-height:100%}.view .warn{color:#fff;padding:2em}.view a{color:#ffd}
  form{padding:16px;overflow:auto}th{text-align:left;font-weight:600;padding:6px 8px 6px 0;vertical-align:top}th small{display:block;color:#888;font-weight:400}
  td input,td select{width:100%;box-sizing:border-box;padding:5px;font:inherit}td input.raw{margin-top:3px;font:12px ui-monospace,monospace;color:#555}
  .err{color:#b00020}.note{background:#fff4d6;padding:6px 8px}.ok{color:#11700e}button{font:inherit;padding:8px 18px;margin-top:12px}nav{display:flex;gap:12px;margin-bottom:8px}
  </style></head><body><div class="view">${viewer}</div><form method="post">
  <nav><a href="/label/${esc(ids[i - 1] ?? label.id)}">&larr; prev</a><a href="/label/${esc(ids[i + 1] ?? label.id)}">next &rarr;</a><a href="/">next unsigned</a><span>${signedCount}/${ids.length} signed</span></nav>
  <h2>${esc(label.id)} <small>${esc(label.type)} · ${esc(label.kind)}</small></h2>
  ${label.note ? `<p class="note">${esc(label.note)}</p>` : ''}
  <p class="${reason ? 'err' : 'ok'}">${reason ? esc(reason) : `signed by ${esc(label.signed!.by)} at ${esc(label.signed!.at)}`}</p>
  ${errors.map((e) => `<p class="err">${esc(e)}</p>`).join('')}
  <p>Value as it should normalize (money in dollars, date as a date); the small box is the text exactly as printed.</p>
  <table>${rows.join('') || '<tr><td>No fields: check that this really is none of the four types.</td></tr>'}</table>
  <button ${photo === 'missing' ? 'disabled' : ''}>Sign and next</button></form></body></html>`;
}

function parseFields(label: Label, form: URLSearchParams): { fields: Record<string, FieldLabel>; errors: string[] } {
  const fields: Record<string, FieldLabel> = {};
  const errors: string[] = [];
  for (const f of fieldsOf(label)) {
    if (form.get(`${f.name}.absent`)) { fields[f.name] = 'absent'; continue; }
    const v = (form.get(`${f.name}.value`) ?? '').trim();
    const raw = (form.get(`${f.name}.raw`) ?? '').trim();
    if (f.kind === 'bool') { fields[f.name] = { value: v === 'true' }; continue; }
    if (!raw) errors.push(`${f.name}: printed text is empty (tick absent if it is not on the page)`);
    if (f.kind === 'cents') {
      const m = /^(\d+)\.(\d{2})$/.exec(v);
      if (!m) { errors.push(`${f.name}: "${v}" is not dollars and cents like 1099.00`); continue; }
      fields[f.name] = { value: Number(m[1]) * 100 + Number(m[2]), raw };
    } else fields[f.name] = { value: f.kind === 'serial' ? v.toUpperCase().replace(/\s+/g, '') : v, raw };
  }
  return { fields, errors };
}

const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
const redirect = (res: ServerResponse, to: string) => { res.writeHead(303, { location: to }); res.end(); };
const TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png' };
const body = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });
const nextUnsigned = () => labelIds().find((id) => unsignedReason(readLabel(id), schema));
const photoFor = async (label: Label) => (label.kind === 'real_photo' ? adoptPhoto(label.id) : 'ok');

createServer(async (req, res) => {
  try {
    const refused = refusal(req.method, req.headers, PORT);
    if (refused) return send(res, 403, `refused: ${refused}`, 'text/plain');
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/') {
      const id = nextUnsigned();
      return id ? redirect(res, `/label/${id}`) : send(res, 200, '<p>All labels signed. Nothing downstream will refuse them.</p>');
    }
    if (url.pathname.startsWith('/file/')) {
      const path = resolve(EVAL_DIR, decodeURIComponent(url.pathname.slice(6)));
      if (!path.startsWith(resolve(EVAL_DIR) + '/') || !existsSync(path)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(path), TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
    }
    const m = /^\/label\/([a-z]{3}-\d{3})$/.exec(url.pathname);
    if (!m || !existsSync(join(LABEL_DIR, `${m[1]}.json`))) return send(res, 404, 'not found', 'text/plain');
    const label = readLabel(m[1]!);
    const photo = await photoFor(label);
    if (req.method !== 'POST') return send(res, 200, page(label, [], photo));
    if (photo === 'missing') return send(res, 409, page(label, ['no photo to sign against'], photo));
    const { fields, errors } = parseFields(label, new URLSearchParams(await body(req)));
    if (errors.length) return send(res, 422, page({ ...label, fields: { ...label.fields, ...fields } }, errors, photo));
    const draft = { ...label, fields };
    errors.push(...shapeProblems(draft, schema));
    if (errors.length) return send(res, 422, page(draft, errors, photo));
    writeFileSync(join(LABEL_DIR, `${label.id}.json`), `${JSON.stringify(sign(draft, SIGNER, new Date().toISOString()), null, 2)}\n`);
    const next = nextUnsigned();
    return redirect(res, next ? `/label/${next}` : '/');
  } catch (e) {
    send(res, 500, `<pre>${esc((e as Error).stack)}</pre>`);
  }
}).listen(PORT, '127.0.0.1', async () => {
  const ids = labelIds();
  const photos = ids.map(readLabel).filter((l) => l.kind === 'real_photo');
  const missing = (await Promise.all(photos.map((l) => adoptPhoto(l.id)))).filter((s) => s === 'missing').length;
  const signed = ids.filter((id) => !unsignedReason(readLabel(id), schema)).length;
  console.log(`eval:signoff: http://127.0.0.1:${PORT}  ${signed}/${ids.length} signed, ${photos.length - missing}/${photos.length} real photos in eval/photos`);
});
