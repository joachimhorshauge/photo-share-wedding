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
            (X-Event-Key)                             (30s edge cache)
```

## About the passcode

The event key rides inside the QR link (`/?k=...`). Anyone who scans a card has it, so treat it as
**friction, not a secret**. What it actually buys you:

- crawlers and randoms who find the site can't upload,
- nor read the photo list, so the Worker URL alone doesn't hand anyone the album,
- after the wedding, rotating one Worker secret shuts everything off at once.

The site itself never embeds the key — only the printable card's QR does. The slideshow needs it too:
open the QR link once on the projector machine and it keeps the key in that browser's local storage.

The photos themselves sit in a public bucket, so a leaked *photo* URL stays readable regardless. The
passcode gates the index, not the images.

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

```sh
just dev        # mock B2 + Worker + site in one terminal, Ctrl-C stops all three
```

It prints the URLs once all three answer. Note the path: `baseURL` in `hugo.toml` ends in
`/photo-share-wedding/`, and `hugo server` honours that, so plain `http://localhost:1313/` is a **404**.
The real page is:

```
http://localhost:1313/photo-share-wedding/?k=dev-key
```

The passcode comes from the URL, so `eventKey` in `hugo.toml` only matters for the printed QR. Send a
few photos, then watch `…/photo-share-wedding/slideshow/?interval=4&refresh=10`.

Other recipes (`just` on its own lists them all):

| | |
|---|---|
| `just status` | which of the three are up, and how many photos are in the pool |
| `just smoke` | ticket → PUT → manifest → read back, without a browser |
| `just clean` | empty the fake bucket, back to the holding card |
| `just kill` | free the dev ports when something is left running |
| `just check` | fail if the config placeholders would reach production |
| `just mock` / `just worker` / `just site` | one piece at a time, own terminal |

Ports: site `1313`, Worker `8787` (wrangler also takes `8788` for its inspector), mock B2 `8790`.

### From a real phone

The only way to shake out HEIC, EXIF rotation and the file-picker UX. Everything must be addressed by
your LAN IP, not `localhost`, because the phone resolves these itself:

```sh
just firewall           # once per machine — see below
just phone              # detects your LAN address
just phone 192.168.1.23 # or name it yourself
```

It prints the URL to open on the phone. Everything is addressed by the LAN IP rather than `localhost`,
because the phone resolves these names itself.

**If the phone times out**, run `just doctor`. In order of likelihood:

1. **A host firewall.** `ufw` denies inbound by default, so nothing reaches ports 1313/8787/8790 no
   matter how the servers are bound. `just firewall` opens them to your own subnet only;
   `just firewall-off` closes them again.
2. **The phone is on a different subnet** — a guest SSID, or wifi and wired LAN that the router keeps
   apart. `just doctor` prints the address the phone has to be able to reach.
3. **Client isolation** on the access point. Load `http://<LAN-ip>:8790/` in the phone's browser: a
   "not found" page means the network path is fine and the problem is in the app; a timeout means it
   never arrived.

### Against real Backblaze

Copy `worker/.dev.vars.example` to `worker/.dev.vars`, fill in a real key pair, and run `npm run dev`
instead of `npm run dev:mock`. `http://localhost:1313` has to be in the bucket's CORS rules.

Useful probes:

```sh
curl -X POST localhost:8787/api/upload-url -H 'content-type: application/json' \
  -H 'X-Event-Key: wrong' -d '{"contentType":"image/jpeg","size":1000}'      # → 403
curl 'localhost:8787/api/photos'                                             # → 403
curl 'localhost:8787/api/photos?k=<key>'                                     # → the manifest
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
  "Genopretter forbindelse…" badge means `/api/photos` is failing — check `just logs`. A "Låst"
  badge means that machine has no passcode: open `/?k=...` on it once, then go back to the slideshow.
- **"My photo isn't showing up."** The manifest is cached for 30 seconds, so give it a minute first.
  Then `curl '<worker>/api/photos?fresh=1&k=<passcode>'` — `?fresh=1` skips the cache in both
  directions and tells a stale manifest apart from an upload that never landed.
- **A guest says the upload failed.** Ask what the row said. The UI is in Danish: `Scan QR-koden igen`
  = wrong/expired passcode. `Lageret afviste den (403)` = B2 CORS or an expired key.
  `Forbindelsen blev afbrudt` is usually wifi — the `Prøv igen` button is right there.
- **Someone uploads something unwelcome.** Delete the object in the B2 web console. It disappears from
  the slideshow within a refresh cycle, and the slideshow skips it immediately if it's already queued.
- **Turn uploads off after the party:** `npx wrangler secret put EVENT_KEY` with a new value. Every
  printed card stops working immediately — and so does the slideshow, which reads the manifest with
  the same key. Leave it until the screen is off.
- **Collect the photos afterwards:** install the B2 CLI and
  `b2 sync b2://<bucket>/photos ./wedding-photos`.

## Costs

Zero, for a wedding. B2 gives 10 GB of storage free with daily free egress at 3× stored bytes; Workers
free tier is 100k requests/day; GitHub Pages is free. 1000 photos at ~400 KB is ~400 MB.
