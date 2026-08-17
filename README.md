# Wedding photo share

Two pages, one bucket:

- **`/`** — guests scan a QR code at their table, land here, and send photos from their phones.
- **`/slideshow/`** — a projected view that re-reads the photo pool every 60 seconds, so a guest's
  photo reaches the big screen about a minute after they send it.

Photos live in a Backblaze B2 bucket. The site is Hugo on GitHub Pages. A small Cloudflare Worker sits
between the two because both halves need credentials that cannot ship in browser JavaScript — writing
to B2 needs a write token, and *listing* a bucket is an authenticated call even when it is public-read.

Images are fetched by the browser straight from B2, never through the Worker. If the Worker breaks
mid-party, the slideshow keeps cycling what it already has and only new uploads stop.

```
phone ──scan QR──▶ Pages  /?k=KEY
                     │ POST /api/upload-url        (X-Event-Key)
                     ▼
                  Worker ──SigV4──▶ B2 S3 API      (presigned PUT, 5 min)
                     │
phone ──PUT jpeg─────┴─────────────▶ B2 bucket     (direct)

TV ──▶ /slideshow/ ──GET /api/photos every 60s──▶ Worker ──ListObjectsV2──▶ B2
                                                      (30s edge cache)
```

## About the passcode

The event key rides inside the QR link (`/?k=...`). Anyone who scans a card has it, so treat it as
**friction, not a secret**. What it actually buys you:

- crawlers and randoms who find the site can't upload,
- after the wedding, rotating one Worker secret shuts uploads off everywhere at once.

The site itself never embeds the key — only the printable card's QR does.

---

## Setup

### 1. Backblaze B2

1. Create a **public** bucket, e.g. `wedding-photos-alex-sam`.
2. Create an **application key restricted to that bucket**, with `listFiles`, `readFiles`, `writeFiles`.
   Save the keyID and the key — B2 shows the key exactly once.
3. From the bucket page, note the **S3 endpoint** (`s3.us-west-004.backblazeb2.com` — the digits vary by
   account; region is the `us-west-004` part) and the **friendly URL** base
   (`https://f004.backblazeb2.com/file/<bucket>`).
4. **CORS rules** — Bucket Settings → CORS Rules → *Share everything in this bucket with all HTTPS
   origins* works, but the tighter version is a custom rule with:
   - origins: `https://<user>.github.io` and `http://localhost:1313`
   - operations: must include **`s3_put`** and `s3_head` (and `s3_get` if you ever proxy)
   - headers allowed: `*`, max age `3600`

   Uploads failing with an opaque browser CORS error and nothing in the Worker log is almost always
   this step.

### 2. Cloudflare Worker

```sh
cd worker
npm install
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npx wrangler secret put EVENT_KEY     # the passcode that goes in the QR
npx wrangler deploy
```

Edit `worker/wrangler.toml` first: `B2_BUCKET`, `B2_REGION`, `B2_ENDPOINT`, `B2_PUBLIC_BASE`, and
`ALLOWED_ORIGINS` (must name the real Pages origin — that is the second classic setup failure).

Optional per-IP throttle:

```sh
npx wrangler kv namespace create RL     # paste the id into wrangler.toml, uncomment the block
```

Without the KV binding the Worker still runs; it just doesn't throttle.

### 3. The site

Edit `hugo.toml`:

- `apiBase` — the deployed Worker URL, no trailing slash
- `eventKey` — must match the `EVENT_KEY` secret
- `coupleNames`, `eventDate`, `tagline`
- optionally `slideSeconds`, `refreshSeconds`, `maxUploadMB`, `maxEdge`

Push to `main`. In the repo's **Settings → Pages**, set **Source: GitHub Actions**. The workflow refuses
to deploy while the placeholders are still in `hugo.toml`.

### 4. Print the cards

Visit `/print/` and print it. Two fold-in-half table tents per A4 sheet. The passcode is only inside the
QR, so a guest photographing the table doesn't broadcast it.

---

## Local development

### Without a Backblaze account

`worker/dev/mock-b2.mjs` impersonates the bits of the B2 S3 API this project uses — presigned PUTs,
`ListObjectsV2`, and serving files back — so the whole loop runs on your laptop. It does not verify
signatures; that is the one thing a mock can't usefully check.

Three terminals:

```sh
cd worker && npm run mock        # fake B2 on :8790, files land in worker/dev/.uploads/
cd worker && npm run dev:mock    # Worker on :8787, pointed at the mock
hugo server                      # site on :1313
```

Then open **<http://localhost:1313/?k=dev-key>** — the passcode comes from the URL, so `eventKey` in
`hugo.toml` only matters for the printed QR. Send a few photos, then watch
<http://localhost:1313/slideshow/?interval=4&refresh=10>.

`rm -rf worker/dev/.uploads` empties the room again.

### From a real phone

The only way to shake out HEIC, EXIF rotation and the file-picker UX. Everything must be addressed by
your LAN IP, not `localhost`, because the phone resolves these itself:

```sh
cd worker && DEV_HOST=192.168.0.191 npm run dev:mock
HUGO_PARAMS_APIBASE=http://192.168.0.191:8787 \
  hugo server --bind 0.0.0.0 --baseURL http://192.168.0.191:1313/
```

Then open `http://192.168.0.191:1313/?k=dev-key` on the phone. (Substitute your own address —
`ip -4 addr` or `ipconfig getifaddr en0`.)

### Against real Backblaze

Copy `worker/.dev.vars.example` to `worker/.dev.vars`, fill in a real key pair, and run `npm run dev`
instead of `npm run dev:mock`. `http://localhost:1313` has to be in the bucket's CORS rules.

Useful probes:

```sh
curl -X POST localhost:8787/api/upload-url -H 'content-type: application/json' \
  -H 'X-Event-Key: wrong' -d '{"contentType":"image/jpeg","size":1000}'      # → 403
curl localhost:8787/api/photos                                               # → the manifest
```

Slideshow overrides for fiddling: `/slideshow/?interval=4&refresh=15`.

---

## How the pieces behave

**Uploads.** The browser decodes the photo into an `<img>` (which applies EXIF orientation everywhere
since ~2020), draws it onto a canvas capped at `maxEdge` on the long side, and re-encodes to JPEG at
q0.85. That makes uploads survive tired venue wifi, turns iPhone HEIC into something a TV browser can
display, and drops EXIF — including the GPS tag on the guest's photo. If decoding fails (desktop
Chrome/Firefox can't read HEIC), the original is sent as-is and the item is labelled `sent as-is`.

Two uploads run at a time, each with one automatic retry, and anything that still fails keeps a Retry
button rather than disappearing.

**Object keys** are generated by the Worker (`photos/<ISO timestamp>-<random>.<ext>`), never taken from
the client, so no guest can overwrite another's photo.

**The presigned PUT signs only `host`.** A signed `Content-Type` must be reproduced byte-for-byte by
the browser, and browsers normalise request headers; the resulting `SignatureDoesNotMatch` is miserable
to debug on someone else's phone. The type is validated before the URL is issued, and S3 still records
whatever the browser sends.

**The slideshow** keeps a shuffled deck of the whole pool. Each refresh, photos that weren't in the
previous manifest jump to the front (newest first, capped at 12 so a 50-photo dump doesn't hijack the
screen), then playback returns to the shuffle. A failed refresh leaves the current pool playing; a
photo that 404s is dropped from the deck. It requests a screen wake lock so the laptop doesn't dim the
projector during dinner.

---

## Day-of runbook

- **Open the slideshow before guests arrive** and press Fullscreen. It shows the QR and the couple's
  names until the first photo lands, so an empty screen still recruits uploads.
- **Nothing appears on screen.** Open the browser console on the slideshow machine. A red
  "Reconnecting…" badge means `/api/photos` is failing — check `npx wrangler tail` from `worker/`.
- **A guest says the upload failed.** Ask what the row said. `Scan the QR code again` = wrong/expired
  passcode. `Storage rejected it (403)` = B2 CORS or an expired key. Anything else is usually wifi;
  the Retry button is right there.
- **Someone uploads something unwelcome.** Delete the object in the B2 web console. It disappears from
  the slideshow within a refresh cycle, and the slideshow skips it immediately if it's already queued.
- **Turn uploads off after the party:** `npx wrangler secret put EVENT_KEY` with a new value. Every
  printed card stops working immediately. The slideshow keeps working.
- **Collect the photos afterwards:** install the B2 CLI and
  `b2 sync b2://<bucket>/photos ./wedding-photos`.

## Costs

Zero, for a wedding. B2 gives 10 GB of storage free with daily free egress at 3× stored bytes; Workers
free tier is 100k requests/day; GitHub Pages is free. 1000 photos at ~400 KB is ~400 MB.
