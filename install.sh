#!/usr/bin/env bash
# coldtrail installer — installs the `coldtrail` binary and points you at setup.
#
#   curl -fsSL https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh | bash
#
# Env overrides:
#   COLDTRAIL_BIN   path to a prebuilt binary to install (skips download; used in tests/dev)
#   COLDTRAIL_REF   branch, tag (v*), or commit SHA for the from-source fallback (default: main)
set -euo pipefail

REPO="dilpreet92/coldtrail"
BIN_DIR="${HOME}/.local/bin"
BIN="${BIN_DIR}/coldtrail"

info() { printf '  %s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; }

# --- 1. provider check (non-fatal) --------------------------------------------
# coldtrail needs a "brain": a CLI agent (Claude Code or Codex) is easiest, but you can also
# bring your own OpenAI-compatible endpoint / local Ollama and pick it in Setup — no CLI needed.
# So this is informational; installation continues regardless.
if command -v claude >/dev/null 2>&1; then
  info "found Claude Code (\`claude\`)."
elif command -v codex >/dev/null 2>&1; then
  info "found Codex (\`codex\`)."
else
  info "no agent CLI found yet — that's fine. In Setup you can use either:"
  info "    Claude Code:  npm i -g @anthropic-ai/claude-code"
  info "    Codex:        npm i -g @openai/codex"
  info "  …or pick BYOK / Ollama (any OpenAI-compatible endpoint), which needs no CLI."
fi

# --- 2. detect platform target ------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Darwin-arm64)   target="aarch64-apple-darwin" ;;
  Darwin-x86_64)  target="x86_64-apple-darwin" ;;
  Linux-x86_64)   target="x86_64-unknown-linux-musl" ;;
  *) err "unsupported platform: ${os} ${arch}"; exit 1 ;;
esac

mkdir -p "${BIN_DIR}"

# --- 3. obtain the binary -----------------------------------------------------
if [ -n "${COLDTRAIL_BIN:-}" ]; then
  # Test/dev path: install a locally-built binary.
  info "installing local binary: ${COLDTRAIL_BIN}"
  install -m 0755 "${COLDTRAIL_BIN}" "${BIN}"
else
  url="https://github.com/${REPO}/releases/latest/download/coldtrail-${target}.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT
  info "downloading ${url}"
  if curl -fsSL "${url}" -o "${tmp}/coldtrail.tar.gz" 2>/dev/null; then
    tar -xzf "${tmp}/coldtrail.tar.gz" -C "${tmp}"
    install -m 0755 "${tmp}/coldtrail" "${BIN}"
  elif command -v cargo >/dev/null 2>&1; then
    info "no release asset yet — building from source with cargo"
    # cargo's --branch/--tag/--rev are distinct; pick by the ref shape so a tag or
    # SHA override works, not just branch names.
    ref="${COLDTRAIL_REF:-main}"
    if [[ "${ref}" =~ ^v[0-9] ]]; then
      ref_flag=(--tag "${ref}")
    elif [[ "${ref}" =~ ^[0-9a-f]{7,40}$ ]]; then
      ref_flag=(--rev "${ref}")
    else
      ref_flag=(--branch "${ref}")
    fi
    cargo install --git "https://github.com/${REPO}" "${ref_flag[@]}" --root "${HOME}/.local"
  else
    err "could not download a release and cargo is not installed."
    info "install Rust (https://rustup.rs) and re-run, or grab a release manually:"
    info "    https://github.com/${REPO}/releases"
    exit 1
  fi
fi

chmod +x "${BIN}" 2>/dev/null || true

# --- macOS Gatekeeper: a downloaded binary is quarantined and would be blocked
# ("cannot be opened — Apple cannot check it for malicious software"). Clear the quarantine
# flag and ad-hoc-sign so it runs. (Not notarization — fine for install-it-yourself testing.)
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "${BIN}" >/dev/null 2>&1 || true
  codesign --force --sign - "${BIN}" >/dev/null 2>&1 || true
fi

info "installed coldtrail -> ${BIN}"

# --- 4. PATH guidance (we don't edit your shell rc) ---------------------------
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    printf '\n'
    err "${BIN_DIR} is not on your PATH."
    info "add this line to your shell profile (e.g. ~/.zshrc), then restart your shell:"
    info "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# --- 5. next steps ------------------------------------------------------------
printf '\n'
info "done. now run:"
info "    coldtrail"
info "  it opens the app in your browser — pick a provider, connect Discovery"
info "  (Canonical) + Destination (Gmail), write your Company profile, then run the loop in Chat."
