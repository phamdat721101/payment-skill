#!/usr/bin/env sh
# n-payment-skill installer — works without publishing to npm.
#
# Sources, in order of decreasing publish-friction:
#
#   curl -fsSL <install.sh> | sh                                            # npm registry (default)
#   curl -fsSL <install.sh> | sh -s -- --from-git phamdat721101/payment-skill
#   curl -fsSL <install.sh> | sh -s -- --from-git phamdat721101/payment-skill#main
#   curl -fsSL <install.sh> | sh -s -- --from-tarball https://example.com/n-payment-skill-1.0.0.tgz
#   curl -fsSL <install.sh> | sh -s -- --from-path  /Users/me/work/payment-skill
#
# Common flags:
#   --target <host>   claude|kiro|cursor|windsurf|continue|gemini|copilot|all
#   --uninstall       Remove the global install
#   -q, --quiet       Suppress non-error output
#
# Idempotent: re-runs upgrade in place. Falls back to sudo automatically when
# the global npm prefix is not user-writable.

set -eu

PKG="n-payment-skill"
DEFAULT_GIT_REPO="phamdat721101/payment-skill"
DEFAULT_GIT_REF=""
VERSION="${N_PAYMENT_SKILL_VERSION:-latest}"
SOURCE="registry"                       # registry | git | tarball | path
GIT_REPO="$DEFAULT_GIT_REPO"
GIT_REF="$DEFAULT_GIT_REF"
TARBALL_URL=""
LOCAL_PATH=""
TARGET="all"
UNINSTALL=0
QUIET=0

color() { [ -t 1 ] && printf '\033[%sm' "$1" || true; }
green=$(color 32); yellow=$(color 33); red=$(color 31); reset=$(color 0); bold=$(color 1)

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --from-git)
      SOURCE="git"
      GIT_REPO="$2"
      case "$2" in *#*)
        GIT_REPO="${2%%#*}"; GIT_REF="${2#*#}" ;;
      esac
      shift 2 ;;
    --from-tarball) SOURCE="tarball"; TARBALL_URL="$2"; shift 2 ;;
    --from-path)    SOURCE="path";    LOCAL_PATH="$2";  shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --quiet|-q) QUIET=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '%sUnknown option: %s%s\n' "$red" "$1" "$reset" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
warn() { printf '%s%s%s\n' "$yellow" "$*" "$reset" >&2; }
die() { printf '%s%s%s\n' "$red" "$*" "$reset" >&2; exit 1; }

# Sanity: Node >= 18.
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 18+ first (recommended: https://github.com/nvm-sh/nvm)."
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR detected; n-payment-skill requires Node >= 18."
command -v npm >/dev/null 2>&1 || die "npm is not on PATH."

# Uninstall path.
if [ "$UNINSTALL" -eq 1 ]; then
  say "${bold}Uninstalling $PKG...${reset}"
  npm uninstall -g "$PKG" >/dev/null 2>&1 || true
  say "${green}✓ removed global $PKG${reset} (your wallet at ~/.n-payment/ is preserved; rm -rf ~/.n-payment to fully purge)"
  exit 0
fi

# Resolve install target string for `npm install -g`.
case "$SOURCE" in
  registry) INSTALL_TARGET="$PKG@$VERSION" ;;
  git)
    [ -n "$GIT_REPO" ] || die "--from-git requires <user/repo[#ref]>"
    if [ -n "$GIT_REF" ]; then
      INSTALL_TARGET="github:$GIT_REPO#$GIT_REF"
    else
      INSTALL_TARGET="github:$GIT_REPO"
    fi ;;
  tarball)
    [ -n "$TARBALL_URL" ] || die "--from-tarball requires a URL"
    INSTALL_TARGET="$TARBALL_URL" ;;
  path)
    [ -n "$LOCAL_PATH" ] || die "--from-path requires a directory"
    [ -d "$LOCAL_PATH" ] || die "Path not found: $LOCAL_PATH"
    INSTALL_TARGET="$LOCAL_PATH" ;;
  *) die "Unknown source: $SOURCE" ;;
esac

say "${bold}Installing $PKG from $SOURCE: $INSTALL_TARGET${reset}"

# Try without sudo first; fall back to GitHub on registry-404, then sudo if
# the global prefix is read-only.
if ! npm install -g "$INSTALL_TARGET" >/dev/null 2>&1; then
  if [ "$SOURCE" = "registry" ]; then
    warn "Registry install failed (likely 404 — '$PKG' is not published yet). Falling back to GitHub: $DEFAULT_GIT_REPO."
    SOURCE="git"
    INSTALL_TARGET="github:$DEFAULT_GIT_REPO"
    if ! npm install -g "$INSTALL_TARGET" >/dev/null 2>&1; then
      warn "GitHub install also failed; retrying with sudo..."
      if command -v sudo >/dev/null 2>&1; then
        sudo npm install -g "$INSTALL_TARGET" || die "Install still failed. Try a user-writable npm prefix: \`npm config set prefix ~/.npm-global\`."
      else
        die "Install failed and sudo is unavailable. Run: npm install -g $INSTALL_TARGET"
      fi
    fi
  else
    warn "Global install failed; retrying with sudo..."
    if command -v sudo >/dev/null 2>&1; then
      sudo npm install -g "$INSTALL_TARGET" || die "Install still failed. Try a user-writable npm prefix: \`npm config set prefix ~/.npm-global\`."
    else
      die "Install failed and sudo is unavailable. Run: npm install -g $INSTALL_TARGET"
    fi
  fi
fi
say "${green}✓ installed $PKG${reset}"

# Setup orchestration (zero-config wallet + faucet + host wiring).
say "${bold}Running setup...${reset}"
ARGS="setup"
[ "$QUIET" -eq 1 ] && ARGS="$ARGS --quiet"
n-payment-skill $ARGS

# Scoped install if user passed --target ≠ all.
if [ "$TARGET" != "all" ]; then
  say "${bold}Installing for $TARGET only...${reset}"
  n-payment-skill install --target "$TARGET"
fi

say ""
say "${green}${bold}Done.${reset} Type \"pay for https://x402-demo.example/data\" in your AI agent."
