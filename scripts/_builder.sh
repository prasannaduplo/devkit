# shellcheck shell=bash
# Sourced by scripts/build-extension.sh and scripts/build-all.sh — decides whether a build runs on the
# caller's machine or inside the builder container, and launches the container when it should.
#
# Why a container at all: the dev-kit's runtime is entirely containerized, but the build was not — it
# hard-required `jq dotnet npm zip curl unzip` on the developer's laptop (and `jq` isn't shipped by
# macOS, so it was an undeclared prerequisite that failed at line 15). Docker Compose is now the only
# prerequisite.
#
# REQUIRES scripts/_target.sh, sourced FIRST: this file uses its `_envv` (to read .env for BUILDER_IMAGE /
# BUILDER_PULL / BUILDER_TAG / STUDIO_PORT) and its `_TARGET`. Both current callers do source it first;
# that is a requirement of sourcing this file, not an accident of their layout.

# builder_truthy <value> -> echoes 1 or 0; returns 1 (no output) if <value> isn't a boolean at all.
#
# Accepts the spellings a human actually types into an env var, case-insensitively, because
# DUPLO_BUILD_NATIVE is documented as a boolean and `DUPLO_BUILD_NATIVE=true` silently getting a
# *container* build would defeat the whole point of an escape hatch. Unset/empty is false — that's the
# normal "env var not set" case, not an error. Anything else is genuine garbage and is rejected rather
# than coerced, so a typo (or a probe in Task 3 that starts echoing something unexpected) fails loudly.
builder_truthy() {
  case "$(printf '%s' "${1-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)      echo 1 ;;
    0|false|no|off|'')  echo 0 ;;
    *)                  return 1 ;;
  esac
}

# builder_mode <force_native> <in_container> <have_toolchain> <have_docker> -> native|container|error:<why>
#
# Kept as a pure function of four booleans (no `command -v`, no filesystem probes) so the whole
# decision matrix can be exercised without Docker, a platform, or a toolchain.
builder_mode() {
  # Normalize every argument up front, before any branch is taken, so a bad value can't be silently
  # read as false by whichever comparison happens to see it first. Separate declaration from assignment:
  # `local x=$(cmd)` masks the command's exit status behind `local`'s own, so the || would never fire.
  local force_native in_container have_toolchain have_docker
  force_native=$(builder_truthy "${1-}")   || { echo error:badarg; return; }
  in_container=$(builder_truthy "${2-}")   || { echo error:badarg; return; }
  have_toolchain=$(builder_truthy "${3-}") || { echo error:badarg; return; }
  have_docker=$(builder_truthy "${4-}")    || { echo error:badarg; return; }

  # The explicit escape hatch outranks everything: --native / DUPLO_BUILD_NATIVE=1 means the caller
  # has their own toolchain and wants it used, so don't second-guess them.
  [ "$force_native" = 1 ] && { echo native; return; }

  # Already inside a container. Nesting is not an option — the agent container has the docker CLI but NO
  # /var/run/docker.sock, so builder_probe_docker's daemon check fails — and it isn't needed either,
  # because the agent image ships the whole toolchain. This is the branch the agent's build takes. It is
  # also the branch the re-launched build takes inside the builder image, which stops the wrapper recursing.
  if [ "$in_container" = 1 ]; then
    [ "$have_toolchain" = 1 ] && { echo native; return; }
    echo error:toolchain; return
  fi

  # A host with Docker: containerize, even if a local toolchain exists, so that laptop, CI and agent
  # builds all use one pinned toolchain. `--native` is there for anyone who wants their own.
  [ "$have_docker" = 1 ] && { echo container; return; }

  # No Docker. A complete local toolchain still works, so degrade gracefully rather than fail (this
  # keeps a Docker-less CI runner building).
  [ "$have_toolchain" = 1 ] && { echo native; return; }
  echo error:docker
}

# The tools build-extension.sh has always required. One list, used both to decide (builder_probe_toolchain)
# and to report (builder_missing_tools), so the error message can never name a different set than the check.
_BUILDER_TOOLS=(jq dotnet npm zip curl unzip)

# --- Probes: the impure half. Each answers one of builder_mode's four booleans. -------------------

# Files that exist only inside a container. A list rather than an inline chain so the set is data (like
# _BUILDER_TOOLS above) and the probe's positive branch is testable on a machine that is not a container.
#   /.dockerenv        — written by Docker into every container it creates.
#   /run/.containerenv — podman's equivalent. Podman does NOT write /.dockerenv, so without this entry
#                        the probe answers 0 inside podman, which is the dangerous direction: the wrapper
#                        would then try to nest a build in a container that has no Docker socket.
_BUILDER_CONTAINER_MARKERS=(/.dockerenv /run/.containerenv)

builder_probe_in_container() {
  local m
  for m in "${_BUILDER_CONTAINER_MARKERS[@]}"; do
    [ -f "$m" ] && { echo 1; return; }
  done
  # Pre-cgroup-v2 fallback, and only that. Under cgroup v2 (Debian 11+, Ubuntu 21.10+, Fedora 31+ — i.e.
  # most current Linux) /proc/1/cgroup reads "0::/" inside a container as well as outside, so this pattern
  # matches nothing and carries no weight there; it still fires on older hosts, which is why it stays.
  grep -qaE '(docker|containerd|podman|kubepods)' /proc/1/cgroup 2>/dev/null && echo 1 || echo 0
}

builder_probe_toolchain() {
  local t
  for t in "${_BUILDER_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { echo 0; return; }
  done
  echo 1
}

builder_probe_docker() {
  # The CLI existing is not enough — the agent image HAS the docker binary and no daemon, so
  # `command -v docker` alone would answer 1 there and send the build looking for a socket that isn't
  # mounted. Only a reachable daemon counts.
  #
  # `version --format {{.Server.Version}}` rather than `info`: printing the SERVER version requires
  # contacting the server, so it proves exactly as much, and it is ~25x cheaper (measured 0.042s vs
  # 1.074s). builder_dispatch evaluates all four probes as *arguments* to builder_mode, so bash runs
  # this one even when --native has already decided the answer — and build-all.sh --native pays it once
  # per extension.
  if command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}

builder_missing_tools() {
  local t out=""
  for t in "${_BUILDER_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || out="$out $t"
  done
  printf '%s' "${out# }"
}

# --- Image resolution ----------------------------------------------------------------------------

# _envv is a raw `grep | cut`, so whatever follows the `=` in .env survives verbatim: a CRLF-edited file
# yields "v1<CR>", a quoted value yields "\"v1\"", trailing spaces stay spaces. Docker rejects all three
# with "invalid reference format". Strip the three that are unambiguously accidental rather than fail on
# them — nobody means to pin a tag whose name contains a carriage return.
builder_clean_value() {
  local v="${1-}"
  v="${v//$'\r'/}"                                    # CRLF line endings
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; esac # "quoted"
  case "$v" in \'*\') v="${v#\'}"; v="${v%\'}" ;; esac # 'quoted'
  v="${v#"${v%%[![:space:]]*}"}"                      # leading whitespace
  v="${v%"${v##*[![:space:]]}"}"                      # trailing whitespace
  printf '%s' "$v"
}

# Resolve BUILDER_IMAGE, pulling (or, if that fails, building locally) so `docker compose run` finds it.
# A local fallback keeps the dev-kit usable before the image is published, and for anyone without quay
# access. Every success path EXPORTS the name: compose reads it from the environment, and an unexported
# one means compose silently falls back to the `${BUILDER_IMAGE:-quay…}` default in docker-compose.yml —
# i.e. runs a different image than the one that was just resolved.
#
# Caching: an image that is already local is used as-is, without contacting the registry, so a warm build
# never pays for a pull. The cost is that a MOVING tag is never refreshed — and BUILDER_TAG=latest, our
# default, is exactly that, on an image whose content is a .NET SDK. BUILDER_PULL=1 forces the re-pull;
# without it the only recourse would be `docker rmi`.
#
# Both knobs are read from the environment AND from .env (via _envv), because compose interpolates
# docker-compose.yml against .env too: if .env's BUILDER_IMAGE were ignored here, compose would honour it
# while this function exported a different name over the top of it.
# Shared tail of both pull attempts: a pull that failed while a copy is already local is a warning, not an
# error — "offline with BUILDER_PULL=1 set" is the ordinary way to get here, and a stale toolchain beats no
# build. Returns 0 when BUILDER_IMAGE is usable as-is.
builder_keep_local_copy() { # builder_keep_local_copy <pull-error-text>
  docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1 || return 1
  echo "WARNING: could not re-pull $BUILDER_IMAGE, using the local copy." >&2
  echo "         docker pull said: $(printf '%s' "${1-}" | tail -1)" >&2
}

# The toolchain image a build uses when neither BUILDER_IMAGE nor BUILDER_TAG is set, pinned by digest so two
# builds of one extension version compile with the same toolchain. `:latest` moves on every toolchain publish,
# which would let two builds of one version differ. The digest is the multi-arch index, so it resolves on amd64
# and arm64 alike. .github/workflows/builder-image.yml prints the new digest after each publish. Moving this pin
# (and docker-compose.yml's matching default) is a reviewed change, since it changes what every extension builds with.
_BUILDER_PINNED_IMAGE="quay.io/duplocloud/duplo-extension-builder@sha256:8185e6a74379ae99e145f55608b3bc17e3037e95e64a612a226fe0eb15c0dbcd"

builder_resolve_image() {
  # The raw value is kept for the error message: BUILDER_PULL may have come from .env rather than the
  # environment, and naming a value the user cannot see in their shell is not a diagnostic.
  local force_pull raw_pull
  raw_pull="$(builder_clean_value "${BUILDER_PULL:-$(_envv BUILDER_PULL)}")"
  force_pull="$(builder_truthy "$raw_pull")" || {
    echo "ERROR: BUILDER_PULL must be a boolean (1/true/yes/on or 0/false/no/off); got '$raw_pull'." >&2
    return 1
  }

  local img pull_err
  img="$(builder_clean_value "${BUILDER_IMAGE:-$(_envv BUILDER_IMAGE)}")"
  if [ -n "$img" ]; then
    BUILDER_IMAGE="$img"; export BUILDER_IMAGE
    if [ "$force_pull" != 1 ] && docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1; then return 0; fi
    pull_err="$(docker pull -q "$BUILDER_IMAGE" 2>&1)" && return 0
    builder_keep_local_copy "$pull_err" && return 0
    # A pinned image that cannot be obtained is fatal: the caller named one specific image, so quietly
    # building a different one would not be doing what they asked.
    echo "ERROR: BUILDER_IMAGE=$BUILDER_IMAGE is neither present locally nor pullable." >&2
    echo "       docker pull said: $(printf '%s' "$pull_err" | tail -1)" >&2
    return 1
  fi

  local tag; tag="$(builder_clean_value "$(_envv BUILDER_TAG)")"
  if [ -z "$tag" ]; then
    BUILDER_IMAGE="$_BUILDER_PINNED_IMAGE"
  else
    # Docker's own tag grammar: [A-Za-z0-9_][A-Za-z0-9._-]{0,127}. Checked here because the alternative is
    # a pull that fails for an unobvious reason and a silent fall-through to building something else.
    case "$tag" in
      *[!A-Za-z0-9._-]* | [!A-Za-z0-9_]* )
        echo "ERROR: BUILDER_TAG is not a valid image tag: $(printf '%q' "$tag")" >&2
        echo "       Tags are [A-Za-z0-9_][A-Za-z0-9._-]* — check .env for quotes, stray whitespace or" >&2
        echo "       Windows line endings." >&2
        return 1 ;;
    esac
    BUILDER_IMAGE="quay.io/duplocloud/duplo-extension-builder:$tag"
  fi
  export BUILDER_IMAGE
  if [ "$force_pull" != 1 ] && docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1; then return 0; fi

  echo "==> Fetching the build toolchain image ($BUILDER_IMAGE)" >&2
  pull_err="$(docker pull -q "$BUILDER_IMAGE" 2>&1)" && return 0
  builder_keep_local_copy "$pull_err" && return 0

  # Not published, or no quay access — build it from the Dockerfile that ships in this repo. `build` is
  # the context, not `.`: the Dockerfile COPYs nothing from the context, so sending the whole repo
  # (samples/, packages/, node_modules/) to the daemon would be pure waste.
  #
  # The pull error is reported, not swallowed: "unauthorized", "manifest unknown" and a registry rate
  # limit all land here, and they are the difference between "the image isn't published yet" (fine, build
  # it) and "your credentials expired" (which a two-minute local build silently papers over).
  echo "    pull failed: $(printf '%s' "$pull_err" | tail -1)" >&2
  BUILDER_IMAGE="duplo-extension-builder:local"; export BUILDER_IMAGE
  docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1 && return 0
  echo "    building it locally from build/Dockerfile.builder instead (one time, ~2 min)" >&2
  docker build -q -f build/Dockerfile.builder -t "$BUILDER_IMAGE" build >/dev/null \
    || { echo "ERROR: could not build the builder image from build/Dockerfile.builder" >&2; return 1; }
}

# --- Dispatch ------------------------------------------------------------------------------------

# builder_studio_state -> in-project | absent | unknown
#
# One `docker compose ps` (~0.06s isolated, ~0.11s amortized against a build) — this sits in front of
# every containerized build, so it has to stay a single call.
#
# `docker compose` is PROJECT-scoped, and the project defaults to the directory name. So this answers a
# narrower question than "is the platform up": it answers "is the studio on the network this build will
# join". A second checkout (or a git worktree, which is how this repo is developed) is a different
# project, and its running studio is invisible here — hence three states, not two: `absent` is evidence,
# `unknown` (the query itself failed) is not, and they must not lead to the same message.
builder_studio_state() {
  local running
  running="$(docker compose ps --status running --services 2>/dev/null)" || { echo unknown; return; }
  if printf '%s\n' "$running" | grep -qx duplo-ai-studio; then echo in-project; else echo absent; fi
}

# builder_studio_url -> the URL a containerized build should use to reach the studio (stdout), plus a
# warning on stderr if it had to fall back.
#
# In-project, the compose network resolves duplo-ai-studio directly and needs no published port at all.
# Otherwise the published host port is the only way in — that is what reaches a studio belonging to
# another checkout's project, or one started by hand. It is also the safer answer when the state is
# `unknown`: the host port works in BOTH topologies (the stack publishes it either way), whereas the
# compose-network name only works in one.
builder_studio_url() {
  local state; state="$(builder_studio_state)"
  if [ "$state" = in-project ]; then
    printf 'http://duplo-ai-studio:60021'
    return
  fi

  # Matches _target.sh's own default for STUDIO_PORT.
  local port; port="$(builder_clean_value "$(_envv STUDIO_PORT)")"; port="${port:-60021}"
  local url="http://host.docker.internal:$port"

  # Only `absent` earns a warning — and it is non-fatal, because the fallback is a real chance of
  # success rather than a guess, so this says what it is doing instead of refusing to try. `unknown`
  # stays silent: a scary message in front of every build, on no evidence, teaches people to ignore it.
  if [ "$state" = absent ]; then
    echo "WARNING: no running duplo-ai-studio in this compose project (docker compose scopes services" >&2
    echo "         per project, and this one is the directory '$(basename "$PWD")'), so the build will" >&2
    echo "         try the published host port instead: $url" >&2
    echo "         That reaches a platform started from another checkout, or by other means. If nothing" >&2
    echo "         is listening there, start this one with ./run.sh. Continuing anyway." >&2
  fi
  printf '%s' "$url"
}

# builder_dispatch <script-relative-path> [args...]
# Returns 0 to mean "carry on natively". Otherwise it runs the build in the container and exits with
# the container's status — it never returns in that case.
#
# CALL IT EARLY: before installing any EXIT trap and before creating any temp file. The container path
# ends in `exec`, which replaces this process — so the caller's EXIT trap never fires and anything it
# would have cleaned up is leaked. (The native and error paths do run the trap; only the container path
# skips it.) Both current callers happen to satisfy this because dispatch sits near the top of the
# script, above their traps and mktemps; that is a requirement, not a coincidence to preserve by luck.
builder_dispatch() {
  local script="$1"; shift

  # Precedence: --native (which sets the variable) → the environment → .env → default containerized.
  # Reading .env matters because that is the only per-repo, per-user place to say "this laptop has the
  # toolchain, always build natively" — an exported shell variable is per-shell, and every other knob
  # here (BUILDER_TAG, BUILDER_IMAGE, BUILDER_PULL) is already an .env key. builder_clean_value strips
  # the CR and stray quotes a Windows-edited .env leaves behind, so `DUPLO_BUILD_NATIVE=1` there behaves
  # the same as on the command line. Captured in a variable so the badarg message below can echo the
  # value we actually resolved, which is not necessarily the one in the environment.
  local want_native; want_native="$(builder_clean_value "${DUPLO_BUILD_NATIVE:-$(_envv DUPLO_BUILD_NATIVE)}")"

  local mode; mode="$(builder_mode \
    "$want_native" \
    "$(builder_probe_in_container)" \
    "$(builder_probe_toolchain)" \
    "$(builder_probe_docker)")"

  case "$mode" in
    native) return 0 ;;
    error:toolchain)
      echo "ERROR: missing build tool(s): $(builder_missing_tools)" >&2
      echo "       This is running inside a container with no Docker daemon, so the build cannot be" >&2
      echo "       delegated. Use an image that ships the toolchain (.NET SDK 8 + Node 22), e.g." >&2
      echo "       build/Dockerfile.builder in this repo." >&2
      exit 1 ;;
    error:docker)
      echo "ERROR: Docker is not available and the local toolchain is incomplete." >&2
      echo "       Missing: $(builder_missing_tools)" >&2
      echo "       Install Docker (Compose v2) — that is the only prerequisite — or install the" >&2
      echo "       toolchain yourself and re-run with --native." >&2
      exit 1 ;;
    container) ;;
    # error:badarg, or a mode this function hasn't been taught. The only way to reach it in practice is
    # a non-boolean DUPLO_BUILD_NATIVE, which is exactly the typo builder_truthy refuses to coerce — so
    # say so instead of falling through to a container build the caller may not have asked for.
    *)
      echo "ERROR: could not decide how to build ($mode)." >&2
      echo "       DUPLO_BUILD_NATIVE must be a boolean (1/true/yes/on or 0/false/no/off); got" >&2
      echo "       '$want_native'. Check your environment and the DUPLO_BUILD_NATIVE line in .env." >&2
      exit 1 ;;
  esac

  # Only /work (this checkout) is mounted, so a path that resolves outside it does not exist in the
  # container and the build dies with a confusing "No manifest.json in /Users/you/elsewhere". Say the
  # real thing here. Checked only on the container path — natively those paths work fine, and the
  # arguments are the caller's extension directory, never the script path, which is ours.
  local a
  for a in "$@"; do
    case "$a" in
      /* | ../* | */../* | .. | */..)
        echo "ERROR: '$a' is outside this checkout, and only the checkout is mounted into the build" >&2
        echo "       container (at /work). Use a path relative to the checkout root, e.g." >&2
        echo "       samples/helloworld — or build with --native to use a path anywhere on disk." >&2
        exit 1 ;;
    esac
  done

  # localhost means nothing in here, so a local target needs a real route to the studio: the compose
  # network if it is in this project, the published host port otherwise. Only the URL is overridden —
  # .env is inside the bind mount, so _target.sh still resolves the token itself inside the container.
  #
  # `-z "${DUPLO_BASE:-}"` matters: a caller who set DUPLO_BASE has already said where the platform is
  # (a remote host, a tunnel, a port-forward), and overwriting it would silently redirect their build.
  #
  # Settled BEFORE the image is resolved, because resolving can mean a multi-minute local image build:
  # nobody should sit through that only to then be told their platform isn't running.
  if [ "${_TARGET:-local}" = local ] && [ -z "${DUPLO_BASE:-}" ]; then
    DUPLO_BASE="$(builder_studio_url)"
  fi

  builder_resolve_image || exit 1

  # Run as the caller so dist/ is theirs, not root's — BOTH halves: uid alone leaves the group as the
  # compose default, i.e. a bundle the caller's group cannot write.
  DUPLO_UID="$(id -u)" DUPLO_GID="$(id -g)"
  export DUPLO_UID DUPLO_GID BUILDER_IMAGE DUPLO_BASE DUPLO_TARGET="${_TARGET:-local}"

  echo "==> Building in $BUILDER_IMAGE (uid $DUPLO_UID:$DUPLO_GID) — --native to use your own toolchain"
  # --rm: the container is a one-shot. --no-deps: never start the platform as a side effect of a build.
  # -T: nothing in a build wants a TTY, and this is exec'd from a script whose stdio may already be a pipe.
  exec docker compose run --rm -T --no-deps builder "$script" "$@"
}
