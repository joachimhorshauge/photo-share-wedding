# Wedding photo share — dev tasks.
#   just            list everything
#   just dev        the whole stack, one terminal, Ctrl-C stops all of it
#   just status     what's actually up

set shell := ["bash", "-uc"]

# First non-loopback address, for the phone recipes.
ip := `ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1`

# Local passcode, read from worker/.dev.vars so the two can never drift apart.
key := `k=$(grep -E '^EVENT_KEY=' worker/.dev.vars 2>/dev/null | cut -d'"' -f2); echo "${k:-dev-key}"`

# The path part of baseURL — a GitHub project site lives at /<repo>/, and
# `hugo server` serves it there too. Typing localhost:1313/ gets you a 404,
# which is a confusing five minutes, so every URL below carries this.
base := `p=$(sed -n 's|^baseURL *= *"\(.*\)"|\1|p' hugo.toml | head -1 | sed -E 's|^https?://[^/]*||'); echo "/${p#/}" | sed 's|//*$|/|'`

_default:
    @just --list --unsorted

# --- running things -------------------------------------------------------

# Mock B2 + Worker + site, all in this terminal. Ctrl-C stops everything.
dev:
    #!/usr/bin/env bash
    set -uo pipefail
    source "$(just _runner)"
    ensure_ports_free
    start '[b2  ] ' 'cd worker && npm run --silent mock'
    start '[api ] ' 'cd worker && npm run --silent dev:mock'
    start '[site] ' 'hugo server'
    just _wait-ready "http://localhost:1313{{base}}" &
    wait

# Same, but reachable from a phone on the same wifi. Pass an address to override.
phone host=ip:
    #!/usr/bin/env bash
    set -uo pipefail
    if [ -z "{{host}}" ]; then echo "no LAN address found — pass one: just phone 192.168.1.23"; exit 1; fi
    if systemctl is-active --quiet ufw 2>/dev/null; then
      echo "  ⚠  ufw is active and denies inbound by default — the phone will time out."
      echo "     Open the dev ports first:  just firewall"
      echo
    fi
    source "$(just _runner)"
    ensure_ports_free
    start '[b2  ] ' 'cd worker && DEV_HOST={{host}} npm run --silent mock'
    start '[api ] ' 'cd worker && DEV_HOST={{host}} npm run --silent dev:mock'
    start '[site] ' 'HUGO_PARAMS_APIBASE=http://{{host}}:8787 hugo server --bind 0.0.0.0 --baseURL http://{{host}}:1313{{base}}'
    just _wait-ready "http://{{host}}:1313{{base}}" &
    wait

_runner:
    @echo "{{justfile_directory()}}/dev/runner.sh"

# Poll until everything answers, then print the URLs below the startup noise.
_wait-ready site:
    #!/usr/bin/env bash
    for _ in $(seq 1 90); do
      if curl -sf -m 1 -o /dev/null "http://127.0.0.1:1313{{base}}" \
         && curl -sf -m 1 -o /dev/null http://127.0.0.1:8787/api/photos \
         && curl -sf -m 1 -o /dev/null 'http://127.0.0.1:8790/dev-bucket?list-type=2'; then
        printf '\n  ───────────────────────────────────────────────────────────\n'
        printf '   upload:     %s?k=%s\n' '{{site}}' '{{key}}'
        printf '   slideshow:  %sslideshow/?interval=4&refresh=10\n' '{{site}}'
        printf '   cards:      %sprint/\n' '{{site}}'
        printf '  ───────────────────────────────────────────────────────────\n\n'
        exit 0
      fi
      sleep 1
    done
    echo "  (services did not all come up within 90s — try 'just status')" >&2

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
    # Only 200 counts. An earlier version accepted 404 as "up", which cheerfully
    # reported a healthy site while every page was a 404.
    probe() {
      code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || true)
      if [ "$code" = "200" ]; then
        printf '  %-12s \033[32mup\033[0m    %s\n' "$1" "$2"
      elif [ "$code" = "000" ] || [ -z "$code" ]; then
        printf '  %-12s \033[31mdown\033[0m  %s  (run: just %s)\n' "$1" "$2" "$3"
      else
        printf '  %-12s \033[33mHTTP %s\033[0m  %s\n' "$1" "$code" "$2"
      fi
    }
    echo "services:"
    probe site   "http://127.0.0.1:1313{{base}}"  site
    probe worker http://127.0.0.1:8787/api/photos worker
    probe mockb2 'http://127.0.0.1:8790/dev-bucket?list-type=2' mock
    echo
    n=$(curl -s -m 2 'http://127.0.0.1:8787/api/photos?fresh=1' 2>/dev/null \
        | node -pe 'try{String(JSON.parse(require("fs").readFileSync(0,"utf8")).count)}catch(e){"?"}' 2>/dev/null || echo '?')
    echo "photos in the pool: $n"
    echo "passcode:           {{key}}"
    echo "upload page:        http://localhost:1313{{base}}?k={{key}}"

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

# --- the phone can't connect ----------------------------------------------

# Open the dev ports to your own subnet (asks for sudo). ufw denies inbound by
# default, so a phone on the same wifi reaches nothing until this is done.
firewall:
    #!/usr/bin/env bash
    set -euo pipefail
    subnet=$(echo "{{ip}}" | awk -F. '{print $1"."$2"."$3".0/24"}')
    echo "allowing tcp 1313, 8787, 8790 from $subnet"
    sudo ufw allow proto tcp from "$subnet" to any port 1313,8787,8790 comment 'photo-share dev'
    sudo ufw status | grep -E '1313|8787|8790' || true

# Close them again when you're done developing.
firewall-off:
    #!/usr/bin/env bash
    set -euo pipefail
    subnet=$(echo "{{ip}}" | awk -F. '{print $1"."$2"."$3".0/24"}')
    sudo ufw delete allow proto tcp from "$subnet" to any port 1313,8787,8790

# Everything a phone connection depends on, in one place.
doctor:
    #!/usr/bin/env bash
    echo "LAN address:   {{ip}}   (phone must be on this subnet)"
    printf 'ufw:           '
    if systemctl is-active --quiet ufw 2>/dev/null; then
      echo "ACTIVE — run 'just firewall' or the phone cannot connect"
    else
      echo "inactive"
    fi
    echo "bound sockets:"
    ss -tln 2>/dev/null | grep -E ':(1313|8787|8790) ' | awk '{print "  ", $4}'
    echo "  (0.0.0.0:* or *:* means every interface — good;"
    echo "   127.0.0.1:* means loopback only — a phone can never reach it)"
    echo
    echo "from the phone's browser, try:  http://{{ip}}:8790/"
    echo "  a 'not found' page = the network path works, so it's the app"
    echo "  a timeout          = firewall, or the wifi isolates clients from the wired LAN"

# --- housekeeping ---------------------------------------------------------

# Empty the fake bucket — back to the holding card.
clean:
    rm -rf worker/dev/.uploads/*
    @echo "fake bucket emptied"

# Kill anything left listening on the dev ports, plus any strays.
kill:
    #!/usr/bin/env bash
    for port in 1313 8787 8788 8790; do
      for pid in $(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | sort -u); do
        kill "$pid" 2>/dev/null && echo "  killed $pid on :$port"
      done
    done
    # Supervisor first: wrangler's node process respawns workerd the moment you
    # kill it, so the obvious order leaves you with a port you can't reclaim and
    # a growing pile of workerds. The brackets stop the pattern from matching
    # this recipe's own command line.
    for pat in 'wrangler-dist/cli\.js de[v]' 'hugo serve[r]' 'worker[d] serve' 'mock-b[2].mjs'; do
      pkill -f "$pat" 2>/dev/null && { echo "  swept ${pat//[\[\]\\]/}"; sleep 0.5; }
    done
    sleep 1
    ss -tln 2>/dev/null | grep -qE ':(1313|8787|8790) ' && echo "  something is STILL holding a port" || echo "  ports clear"

# Open the upload page with the passcode already attached.
open:
    xdg-open "http://localhost:1313{{base}}?k={{key}}" >/dev/null 2>&1 &

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
