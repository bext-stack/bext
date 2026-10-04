#!/bin/sh
# Install one checksummed Bext + tsc-rs + PRISM release. No service restarts.
set -eu

base=${BEXT_RELEASE_URL:-https://get.bext.dev}
base=${base%/}
say() { printf '%s\n' "$*"; }
die() { say "error: $*" >&2; exit 1; }
if command -v curl >/dev/null 2>&1; then
  fetch() { curl --fail --location --silent --show-error "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die 'curl or wget is required'
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die 'sha256sum or shasum is required'
fi
command -v tar >/dev/null 2>&1 || die 'tar is required'

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) triple=x86_64-unknown-linux-gnu ;;
  *) die 'This release supports Linux x64. See https://docs.bext.dev/getting-started/installation for other builds.' ;;
esac

scratch=$(mktemp -d "${TMPDIR:-/tmp}/bext-install.XXXXXX")
trap 'rm -rf "$scratch"' 0
trap 'exit 1' 1 2 3 15
if [ -n "${BEXT_RELEASE_ID:-}" ]; then
  release=$BEXT_RELEASE_ID
else
  fetch "$base/channels/stable" "$scratch/channel"
  release=$(cat "$scratch/channel")
fi
case "$release" in ''|*[!A-Za-z0-9._-]*) die 'Invalid release ID' ;; esac

archive="$base/releases/$release/$triple.tar.gz"
say "Downloading matched release $release ($triple)"
fetch "$archive.sha256" "$scratch/checksum"
expected=$(awk -v name="$triple.tar.gz" '$2==name {print $1}' "$scratch/checksum")
[ "${#expected}" = 64 ] || die 'Release checksum is missing or ambiguous'
case "$expected" in *[!a-f0-9]*) die 'Invalid SHA256 checksum' ;; esac
fetch "$archive" "$scratch/release.tar.gz"
[ "$(digest "$scratch/release.tar.gz")" = "$expected" ] || die 'Release checksum mismatch'
tar -xzf "$scratch/release.tar.gz" -C "$scratch"
bundle="$scratch/$release"
[ -x "$bundle/bin/bext-server" ] && [ -x "$bundle/bin/tsc-rs" ] \
  && [ -f "$bundle/runtime/framework/package.json" ] || die 'Incomplete release bundle'
# Validate both executables on this machine before replacing any installation.
"$bundle/bin/bext-server" --version > "$scratch/bext-version" 2>/dev/null \
  || die 'Bext cannot run on this machine (Linux x64, glibc 2.31+ required)'
"$bundle/bin/tsc-rs" --version > "$scratch/tsc-version" 2>/dev/null \
  || die 'tsc-rs cannot run on this machine'

dir=${BEXT_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
mkdir -p "$dir" 2>/dev/null || true
privilege=
if [ ! -w "$dir" ]; then
  command -v sudo >/dev/null 2>&1 || die "Install directory is not writable: $dir"
  privilege=sudo
fi
$privilege mkdir -p "$dir"
dir=$(CDPATH= cd -- "$dir" && pwd)
destination="$dir/.bext-releases/$release"
$privilege mkdir -p "$dir/.bext-releases"
if [ -e "$destination" ]; then
  [ -f "$destination/.archive-sha256" ] \
    && [ "$(cat "$destination/.archive-sha256")" = "$expected" ] \
    || die 'Existing release directory has different contents'
else
  printf '%s\n' "$expected" > "$bundle/.archive-sha256"
  # Native discovery resolves current_exe(), so its own bin directory needs
  # the matching framework alias as well as the adjacent compiler.
  ln -s ../runtime/framework "$bundle/bin/bext-framework"
  stage="$dir/.bext-releases/.stage-$release-$$"
  $privilege cp -R "$bundle" "$stage"
  $privilege mv "$stage" "$destination"
fi
# One atomic symlink chooses the matched engine, compiler and framework.
pointer="$dir/.bext-current-$$"
$privilege ln -s ".bext-releases/$release/bin" "$pointer"
$privilege mv -Tf "$pointer" "$dir/.bext-current"
for name in bext tsc-rs bext-framework; do
  case "$name" in bext) target=.bext-current/bext-server ;; *) target=.bext-current/$name ;; esac
  alias="$dir/.bext-alias-$$"
  $privilege ln -s "$target" "$alias"
  if [ -d "$dir/$name" ] && [ ! -L "$dir/$name" ]; then
    backup="$dir/.$name-before-$release-$$"
    $privilege mv "$dir/$name" "$backup"
    say "Previous $name directory preserved at $backup"
  fi
  $privilege mv -Tf "$alias" "$dir/$name"
done
say "Installed $dir/bext"
cat "$scratch/bext-version" "$scratch/tsc-version"
case ":$PATH:" in *:"$dir":*) ;; *) say "Add $dir to PATH to run bext." ;; esac
