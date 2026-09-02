#!/usr/bin/env sh
# Dispatcher installer for macOS and Linux, modeled on the bun/deno install scripts.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
#
# Installs the latest release; pin one with DISPATCHER_VERSION=0.3.0 before the
# pipe. Override the install directory with DISPATCHER_INSTALL. Everything else
# (config, plugin, credentials) is the interactive `dispatcher init`, run
# afterwards inside your repository.
set -eu

repo="backside4charter/dispatcher"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "error: unsupported OS $(uname -s) - download a binary from https://github.com/$repo/releases" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

asset="dispatcher-$os-$arch"
install_dir="${DISPATCHER_INSTALL:-$HOME/.local/bin}"
if [ -n "${DISPATCHER_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/v$DISPATCHER_VERSION/$asset"
else
  url="https://github.com/$repo/releases/latest/download/$asset"
fi

mkdir -p "$install_dir"
target="$install_dir/dispatcher"
echo "downloading $url"
curl -fSL --retry 3 --retry-delay 2 --progress-bar -o "$target" "$url"
chmod +x "$target"
echo "installed $("$target" version) -> $target"

# Put the install directory on PATH once, the way bun's installer does: append
# an export to the shell rc files that exist, guarded by a marker comment.
case ":$PATH:" in
  *":$install_dir:"*) echo "$install_dir is already on your PATH" ;;
  *)
    added=""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [ -f "$rc" ] && ! grep -q "# dispatcher install" "$rc"; then
        printf '\n# dispatcher install\nexport PATH="%s:$PATH"\n' "$install_dir" >> "$rc"
        echo "added $install_dir to PATH in $rc (open a new shell to pick it up)"
        added="yes"
      fi
    done
    if [ -z "$added" ]; then
      echo "note: add $install_dir to your PATH: export PATH=\"$install_dir:\$PATH\""
    fi
    ;;
esac

echo
echo "next: cd into your repository and run:  dispatcher init"
