// Runtime config comes from the <script type="application/json"> block that
// baseof.html renders, so these files stay plain JS that a linter can read.
const node = document.getElementById('wps-config');

export const config = node ? JSON.parse(node.textContent) : {};

export function api(path) {
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  return base + path;
}

export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Number(fallback);
}
