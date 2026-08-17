# Wedding photo share — dev tasks.
#   just            list everything
#   just dev        the whole stack, one terminal, Ctrl-C stops all of it
#   just status     what's actually up

set shell := ["bash", "-uc"]

# First non-loopback address, for the phone recipes.
ip := `ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1`

# Local passcode, read from worker/.dev.vars so the two can never drift apart.
key := `k=$(grep -E '^EVENT_KEY=' worker/.dev.vars 2>/dev/null | cut -d'"' -f2); echo "${k:-dev-key}"`

_default:
    @just --list --unsorted

# --- running things -------------------------------------------------------

# Mock B2 + Worker + site, all in this terminal. Ctrl-C stops everything.
dev:
    #!/usr/bin/env bash
    set -uo pipefail
    trap 'kill 0' EXIT INT TERM
    echo "→ upload page   http://localhost:1313/?k={{key}}"
    echo "→ slideshow     http://localhost:1313/slideshow/?interval=4&refresh=10"
    echo
    (cd worker && npm run --silent mock)     2>&1 | sed 's/^/[b2  ] /' &
    (cd worker && npm run --silent dev:mock) 2>&1 | sed 's/^/[api ] /' &
    hugo server                              2>&1 | sed 's/^/[site] /' &
    wait

# Same, but reachable from a phone on the same wifi. Pass an address to override.
phone host=ip:
    #!/usr/bin/env bash
    set -uo pipefail
    if [ -z "{{host}}" ]; then echo "no LAN address found — pass one: just phone 192.168.1.23"; exit 1; fi
    trap 'kill 0' EXIT INT TERM
    echo "→ open on the phone:  http://{{host}}:1313/?k={{key}}"
    echo
    (cd worker && DEV_HOST={{host}} npm run --silent mock)     2>&1 | sed 's/^/[b2  ] /' &
    (cd worker && DEV_HOST={{host}} npm run --silent dev:mock) 2>&1 | sed 's/^/[api ] /' &
    HUGO_PARAMS_APIBASE=http://{{host}}:8787 \
      hugo server --bind 0.0.0.0 --baseURL http://{{host}}:1313/ 2>&1 | sed 's/^/[site] /' &
    wait

# Individual pieces, when you want one in its own terminal.
mock:
    cd worker && npm run mock

worker:
    cd worker && npm run dev:mock

site:
    hugo server

# Point the Worker at the real Backblaze bucket instead of the mock.
worker-real:
    cd worker && npx wrangler dev

# --- checking things ------------------------------------------------------

# Is each piece up, and does the round trip actually work?
status:
    #!/usr/bin/env bash
    probe() {
      code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || true)
      if [ "$code" = "200" ] || [ "$code" = "404" ]; then
        printf '  %-12s \033[32mup\033[0m    %s\n' "$1" "$2"
      else
        printf '  %-12s \033[31mdown\033[0m  %s  (run: just %s)\n' "$1" "$2" "$3"
      fi
    }
    echo "services:"
    probe site   http://127.0.0.1:1313/           site
    probe worker http://127.0.0.1:8787/api/photos worker
    probe mockb2 'http://127.0.0.1:8790/dev-bucket?list-type=2' mock
    echo
    n=$(curl -s -m 2 'http://127.0.0.1:8787/api/photos?fresh=1' 2>/dev/null \
        | node -pe 'try{String(JSON.parse(require("fs").readFileSync(0,"utf8")).count)}catch(e){"?"}' 2>/dev/null || echo '?')
    echo "photos in the pool: $n"
    echo "passcode:           {{key}}"

# Prove the upload path end to end: ticket → PUT → manifest → fetch back.
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    printf '%s' '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==' | base64 -d > "$tmp/t.jpg"
    echo "1. asking for an upload ticket…"
    t=$(curl -s -X POST http://127.0.0.1:8787/api/upload-url \
          -H 'content-type: application/json' -H 'X-Event-Key: {{key}}' \
          -d '{"contentType":"image/jpeg","size":600}')
    echo "$t" | grep -q uploadUrl || { echo "   FAILED: $t"; exit 1; }
    url=$(echo "$t" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).uploadUrl')
    pub=$(echo "$t" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).publicUrl')
    echo "2. uploading…    $(curl -s -o /dev/null -w '%{http_code}' -X PUT "$url" -H 'Content-Type: image/jpeg' --data-binary @"$tmp/t.jpg")"
    echo "3. manifest…     $(curl -s 'http://127.0.0.1:8787/api/photos?fresh=1' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).count') photo(s)"
    echo "4. reading back… $(curl -s -o /dev/null -w '%{http_code}' "$pub")"
    echo
    echo "all four should be 200 / non-zero. If step 2 failed, the mock isn't running."

# Refuse to let a broken config reach the wedding.
check:
    #!/usr/bin/env bash
    fail=0
    for p in CHANGE-ME WORKER_SUBDOMAIN GITHUB_USER; do
      if grep -q "$p" hugo.toml; then echo "  hugo.toml still has '$p'"; fail=1; fi
    done
    grep -q GITHUB_USER worker/wrangler.toml && { echo "  wrangler.toml ALLOWED_ORIGINS still has 'GITHUB_USER'"; fail=1; }
    [ $fail -eq 0 ] && echo "config looks deployable" || { echo; echo "fix these before deploying"; exit 1; }

# --- housekeeping ---------------------------------------------------------

# Empty the fake bucket — back to the holding card.
clean:
    rm -rf worker/dev/.uploads/*
    @echo "fake bucket emptied"

# Kill anything left listening on the dev ports.
kill:
    #!/usr/bin/env bash
    for port in 1313 8787 8788 8790; do
      pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
      [ -n "$pid" ] && { kill "$pid" 2>/dev/null && echo "  killed $pid on :$port"; }
    done
    echo "done"

# Open the upload page with the passcode already attached.
open:
    xdg-open "http://localhost:1313/?k={{key}}" >/dev/null 2>&1 &

build:
    hugo --minify

# --- deploying ------------------------------------------------------------

deploy-worker:
    cd worker && npx wrangler deploy

# Set (or rotate) the three Worker secrets. Prompts for each.
secrets:
    cd worker && npx wrangler secret put B2_KEY_ID
    cd worker && npx wrangler secret put B2_APP_KEY
    cd worker && npx wrangler secret put EVENT_KEY

# Rotate only the passcode — kills every printed card at once.
rotate-key:
    cd worker && npx wrangler secret put EVENT_KEY
    @echo "now update eventKey in hugo.toml, reprint /print/, and push"

logs:
    cd worker && npx wrangler tail
