import { AwsClient } from 'aws4fetch';

/**
 * Two endpoints, and nothing else:
 *
 *   POST /api/upload-url  → a presigned S3 PUT the guest's browser uploads to
 *   GET  /api/photos      → the current photo list for the slideshow
 *
 * Both require the event key, in an X-Event-Key header or a ?k= parameter.
 *
 * Photos are read straight from the public bucket by the browser, so this
 * Worker is never in the path of an actual image. If it falls over mid-party,
 * the slideshow keeps playing what it already has and only new uploads stop.
 */

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const MAX_BYTES = 12 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 300;
const LIST_CACHE_SECONDS = 30;
const RATE_MAX = 80;              // uploads per IP...
const RATE_WINDOW_SECONDS = 600;  // ...per ten minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/upload-url' && request.method === 'POST') {
        return await handleUploadUrl(request, env, cors);
      }
      if (url.pathname === '/api/photos' && request.method === 'GET') {
        return await handlePhotos(request, env, ctx, cors);
      }
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ error: 'internal', message: 'Upload service failed' }, 500, cors);
    }

    return json({ error: 'not_found' }, 404, cors);
  },
};

/* -- POST /api/upload-url -------------------------------------------------- */

async function handleUploadUrl(request, env, cors) {
  if (!env.EVENT_KEY || !env.B2_KEY_ID || !env.B2_APP_KEY) {
    return json({ error: 'misconfigured', message: 'Worker secrets are not set' }, 500, cors);
  }

  if (!safeEqual(request.headers.get('X-Event-Key') || '', env.EVENT_KEY)) {
    return json({ error: 'forbidden', message: 'Bad or missing event key' }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad_request', message: 'Expected JSON' }, 400, cors);
  }

  const contentType = String(body.contentType || '').toLowerCase();
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return json({ error: 'bad_type', message: 'Images only' }, 400, cors);
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return json({ error: 'too_large', message: `Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB` }, 400, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (await isRateLimited(env, ip)) {
    return json({ error: 'rate_limited', message: 'Too many uploads just now' }, 429, cors);
  }

  // The key is ours, never the client's filename: no overwriting another
  // guest's photo, no path traversal, and it sorts chronologically in the
  // bucket listing.
  const key = `${prefix(env)}${timestamp()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const target = new URL(`${trim(env.B2_ENDPOINT)}/${env.B2_BUCKET}/${key}`);
  target.searchParams.set('X-Amz-Expires', String(UPLOAD_TTL_SECONDS));

  // Only the URL is signed — no signed headers. A signed Content-Type has to be
  // reproduced byte-for-byte by the browser, and browsers quietly normalise
  // request headers; the resulting SignatureDoesNotMatch is miserable to debug
  // on someone else's phone at a reception. S3 still records the Content-Type
  // the browser sends, and the type was validated above.
  const signed = await client(env).sign(target.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
  });

  return json(
    {
      uploadUrl: signed.url,
      key,
      publicUrl: publicUrl(env, key),
      expiresIn: UPLOAD_TTL_SECONDS,
    },
    200,
    cors
  );
}

/* -- GET /api/photos ------------------------------------------------------- */

async function handlePhotos(request, env, ctx, cors) {
  if (!env.EVENT_KEY || !env.B2_KEY_ID || !env.B2_APP_KEY) {
    return json({ error: 'misconfigured', message: 'Worker secrets are not set' }, 500, cors);
  }

  const url = new URL(request.url);

  // The bucket hands an object to anyone holding its URL, so the manifest —
  // the only index of those URLs — is what's actually worth gating. Checked
  // before the cache is touched, so a warm entry can never be served to a
  // request that didn't present the key.
  if (!safeEqual(presentedKey(request, url), env.EVENT_KEY)) {
    return json({ error: 'forbidden', message: 'Bad or missing event key' }, 403, cors);
  }

  // One shared 30s edge cache entry: a room full of reloaded slideshow tabs
  // still costs B2 two list calls a minute. The key deliberately stays out of
  // the cache key — every guest who gets past the check sees the same list.
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/photos`, { method: 'GET' });

  // ?fresh=1 skips the cache in both directions. The slideshow never asks for
  // this; it exists so that when someone says "my photo isn't showing up" you
  // can tell a stale manifest apart from a failed upload in one curl.
  const bypass = url.searchParams.has('fresh');

  const cached = bypass ? null : await cache.match(cacheKey);
  if (cached) return decorate(cached, cors, 'HIT');

  const payload = await listPhotos(env);
  const res = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': bypass ? 'no-store' : `public, max-age=${LIST_CACHE_SECONDS}`,
    },
  });

  if (!bypass) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return decorate(res, cors, bypass ? 'BYPASS' : 'MISS');
}

async function listPhotos(env) {
  const aws = client(env);
  const photos = [];
  let token = '';

  // 20 pages × 1000 keys is far more than any wedding produces, and it stops a
  // pathological loop from burning the Worker's CPU budget.
  for (let page = 0; page < 20; page += 1) {
    const u = new URL(`${trim(env.B2_ENDPOINT)}/${env.B2_BUCKET}`);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix(env));
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);

    const res = await aws.fetch(u.toString(), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`B2 list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    const xml = await res.text();
    for (const chunk of matchAll(xml, /<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(chunk, 'Key');
      const size = Number(tag(chunk, 'Size'));
      if (!key || key.endsWith('/') || !(size > 0)) continue;   // folder markers, aborted PUTs
      photos.push({
        key,
        url: publicUrl(env, key),
        uploaded: Date.parse(tag(chunk, 'LastModified')) || 0,
      });
    }

    if (tag(xml, 'IsTruncated') !== 'true') break;
    token = tag(xml, 'NextContinuationToken');
    if (!token) break;
  }

  photos.sort((a, b) => b.uploaded - a.uploaded);
  return { photos, count: photos.length, generatedAt: Date.now() };
}

/* -- plumbing -------------------------------------------------------------- */

function client(env) {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: env.B2_REGION,
  });
}

async function isRateLimited(env, ip) {
  if (!env.RL || !ip) return false;   // KV binding is optional
  const k = `rl:${ip}`;
  const count = Number(await env.RL.get(k)) || 0;
  if (count >= RATE_MAX) return true;
  // Racy under concurrency, deliberately: an approximate ceiling is all this
  // needs, and a strict counter would mean a Durable Object.
  await env.RL.put(k, String(count + 1), { expirationTtl: RATE_WINDOW_SECONDS });
  return false;
}

function publicUrl(env, key) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${trim(env.B2_PUBLIC_BASE)}/${path}`;
}

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';

  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-event-key',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

// Header for browsers, ?k= for curl and for anything that would rather not
// spend a CORS preflight on a custom header.
function presentedKey(request, url) {
  return request.headers.get('X-Event-Key') || url.searchParams.get('k') || '';
}

function decorate(res, cors, cacheState) {
  const out = new Response(res.body, res);
  Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
  out.headers.set('x-cache', cacheState);

  // The stored copy says `public` so the Worker's own cache keeps one shared
  // entry for everyone. What leaves the Worker says `private`: the manifest is
  // key-gated now, and no intermediary should be holding a copy to hand out.
  const cc = out.headers.get('cache-control') || '';
  if (cc.startsWith('public')) {
    out.headers.set('cache-control', `private, max-age=${LIST_CACHE_SECONDS}`);
  }
  return out;
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

/* -- tiny helpers ---------------------------------------------------------- */

// Workers has no DOMParser, and pulling in an XML library for four fields is
// not worth the bundle. S3 list output is machine-generated and flat.
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : '';
}

function* matchAll(text, re) {
  let m;
  while ((m = re.exec(text)) !== null) yield m[1];
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function prefix(env) {
  return env.PREFIX || 'photos/';
}

function trim(s) {
  return String(s || '').replace(/\/+$/, '');
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
