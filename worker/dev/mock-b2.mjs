/**
 * A stand-in for the Backblaze S3 API, for local development only.
 *
 * It speaks just enough of the protocol for the Worker and the browser to be
 * exercised end to end without a Backblaze account:
 *
 *   GET  /<bucket>?list-type=2&prefix=photos/   ListObjectsV2 XML
 *   PUT  /<bucket>/<key>?X-Amz-...              accepts the presigned upload
 *   GET  /file/<bucket>/<key>                   serves it back, like B2's
 *                                               friendly URL does
 *
 * It does NOT verify signatures — that is the one thing a mock cannot usefully
 * check, and the real thing will. Uploads land in worker/dev/.uploads/ so you
 * can look at them, and `rm -rf` resets the room to empty.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 8790, not 8788: wrangler dev claims 8787 for the Worker and 8788 for its
// inspector.
const PORT = Number(process.env.PORT || 8790);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.uploads');

const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '3600',
};

await fs.mkdir(ROOT, { recursive: true });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') return send(res, 204, CORS);

    try {
      // Serving a stored photo back — stands in for B2's friendly URL.
      if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
        const key = url.pathname.split('/').slice(3).map(decodeURIComponent).join('/');
        return await serve(res, key);
      }

      // Presigned upload.
      if (req.method === 'PUT') {
        const key = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
        return await store(req, res, key);
      }

      // ListObjectsV2.
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        return await list(res, url.searchParams.get('prefix') || '');
      }
    } catch (err) {
      console.error(err);
      return send(res, 500, {}, String(err.message || err));
    }

    send(res, 404, {}, 'not found');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`mock B2 listening on http://0.0.0.0:${PORT}`);
    console.log(`uploads land in ${ROOT}`);
  });

async function store(req, res, key) {
  if (!key || key.includes('..')) return send(res, 400, CORS, 'bad key');
  const dest = path.join(ROOT, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  await fs.writeFile(dest, body);

  console.log(`PUT  ${key}  ${(body.length / 1024).toFixed(0)} KB  (${req.headers['content-type']})`);
  send(res, 200, { ...CORS, etag: '"mock"' });
}

async function serve(res, key) {
  const file = path.join(ROOT, key);
  if (!file.startsWith(ROOT)) return send(res, 400, CORS, 'bad key');
  const body = await fs.readFile(file).catch(() => null);
  if (!body) return send(res, 404, CORS, 'not found');
  send(res, 200, {
    ...CORS,
    'content-type': TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'public, max-age=300',
  }, body);
}

async function list(res, prefix) {
  const files = await walk(ROOT);
  const contents = files
    .filter((f) => f.key.startsWith(prefix))
    .map(
      (f) =>
        `<Contents><Key>${escapeXml(f.key)}</Key>` +
        `<LastModified>${f.mtime.toISOString()}</LastModified>` +
        `<ETag>&quot;mock&quot;</ETag><Size>${f.size}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`
    )
    .join('\n');

  console.log(`LIST prefix=${prefix} → ${files.length} object(s)`);
  send(res, 200, { ...CORS, 'content-type': 'application/xml' },
    `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>dev-bucket</Name><Prefix>${escapeXml(prefix)}</Prefix>
<KeyCount>${files.length}</KeyCount><MaxKeys>1000</MaxKeys>
<IsTruncated>false</IsTruncated>
${contents}
</ListBucketResult>`);
}

async function walk(dir, base = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const key = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(full, key)));
    else {
      const st = await fs.stat(full);
      out.push({ key, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

function send(res, status, headers, body = '') {
  res.writeHead(status, headers).end(body);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
