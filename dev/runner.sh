# Sourced by `just dev` and `just phone`.
#
# The naive version of this is `cmd | sed &` plus `trap 'kill 0' EXIT`, and it
# leaks: wrangler spawns workerd, npm spawns node, and neither is in the shell's
# own process group, so Ctrl-C leaves the ports held and the next `just dev`
# fails on "address already in use". Enabling job control puts each background
# job in its own process group, which can then be killed as a whole tree.

set -m           # each `&` job becomes its own process group
set +e           # a service exiting shouldn't tear the script down mid-cleanup

_pids=()

# Refuse to start on top of something already running. One silently dead
# service in a three-way split is miserable to diagnose.
ensure_ports_free() {
  local busy
  busy=$(ss -tln 2>/dev/null | grep -oE ':(1313|8787|8790) ' | tr -d ': ' | sort -u | tr '\n' ' ')
  if [ -n "$busy" ]; then
    trap - INT TERM EXIT      # nothing started yet; don't run the killer
    echo "ports already in use: ${busy}— run 'just kill' first" >&2
    exit 1
  fi
}

# start "<prefix>" "<shell command>"
start() {
  local prefix="$1" cmd="$2"
  # sed -u, not sed: sed block-buffers when its output isn't a terminal, and
  # `just dev | tee dev.log` then looks completely dead while working fine.
  ( eval "$cmd" 2>&1 | sed -u "s/^/$prefix/" ) &
  _pids+=("$!")
}

_stop() {
  trap - INT TERM EXIT
  echo
  for p in "${_pids[@]:-}"; do kill -TERM "-$p" 2>/dev/null; done
  sleep 1
  for p in "${_pids[@]:-}"; do kill -KILL "-$p" 2>/dev/null; done
  # Backstop, in supervisor-first order: wrangler's node process respawns
  # workerd whenever it dies, so killing workerd on its own just breeds a new
  # one and the port is never released.
  pkill -f 'wrangler-dist/cli\.js de[v]' 2>/dev/null
  sleep 0.5
  pkill -f 'worker[d] serve' 2>/dev/null
  echo "stopped."
  # Ctrl-C is how you're meant to stop this, so don't let just report the
  # conventional 130 as "recipe `dev` failed".
  exit 0
}

trap _stop INT TERM EXIT
