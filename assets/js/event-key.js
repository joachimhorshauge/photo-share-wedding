// The passcode rides in the QR link as ?k=. Both pages need it now — the share
// page to get an upload ticket, the slideshow to read the manifest — so picking
// it up and remembering it lives in one place.

const KEY_STORAGE = 'wps.eventKey';

export function eventKey() {
  const fromUrl = new URLSearchParams(location.search).get('k');
  if (fromUrl) {
    store(KEY_STORAGE, fromUrl);
    return fromUrl;
  }
  // A guest who came back later, or wandered off to the slideshow tab and back,
  // still has it. The link stays intact in the URL so guests can pass it around.
  // It's also how the projector gets unlocked: open the QR link once on that
  // laptop and the slideshow tab inherits the key from storage.
  return read(KEY_STORAGE) || '';
}

function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
