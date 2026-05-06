#!/usr/bin/env bash
# build-runtime-macos.sh — Build self-contained PostgreSQL 16 + pgvector runtime on macOS.
# Runs on macos-13 (x64) and macos-14 (arm64) hosted runners; native arch.
# Produces: dist/mixdog-runtime-darwin-{arch}-pg{pgver}-pgvector{vecver}.tar.gz
# Bundles Homebrew dyn deps via otool closure (binaries + extension modules) +
# install_name_tool rewrite + ad-hoc codesign so the tarball boots cleanly on a
# fresh macOS without Homebrew. Final smoke: initdb + CREATE EXTENSION vector +
# distance query.

set -euo pipefail

PG_VERSION="16.4"
PGVECTOR_VERSION="0.8.2"
TARGET_OS="${TARGET_OS:-darwin}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m | sed 's/x86_64/x64/')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/runtime-darwin-$TARGET_ARCH"
STAGE_DIR="$BUILD_DIR/stage"
DIST_DIR="$ROOT_DIR/dist"
RUNTIME_DIR="$BUILD_DIR/runtime"

OUTPUT_NAME="mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

mkdir -p "$BUILD_DIR" "$STAGE_DIR" "$DIST_DIR" "$RUNTIME_DIR"/{bin,lib,share}

echo "==> Installing build dependencies via Homebrew"
brew install readline icu4c openssl@3 pkg-config curl git

BREW_PREFIX="$(brew --prefix)"
export CPPFLAGS="-I${BREW_PREFIX}/opt/readline/include -I${BREW_PREFIX}/opt/openssl@3/include -I${BREW_PREFIX}/opt/icu4c/include"
export LDFLAGS="-L${BREW_PREFIX}/opt/readline/lib -L${BREW_PREFIX}/opt/openssl@3/lib -L${BREW_PREFIX}/opt/icu4c/lib"
export PKG_CONFIG_PATH="${BREW_PREFIX}/opt/openssl@3/lib/pkgconfig:${BREW_PREFIX}/opt/icu4c/lib/pkgconfig"

echo "==> Downloading PostgreSQL $PG_VERSION source"
cd "$BUILD_DIR"
curl -fsSL "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.gz" \
  -o "postgresql-${PG_VERSION}.tar.gz"
rm -rf "postgresql-${PG_VERSION}"
tar xzf "postgresql-${PG_VERSION}.tar.gz"

echo "==> Configuring PostgreSQL"
cd "postgresql-${PG_VERSION}"
./configure \
  --prefix="$STAGE_DIR" \
  --without-perl \
  --without-python \
  --without-tcl \
  --with-openssl \
  --with-icu \
  --with-readline \
  --enable-thread-safety \
  CFLAGS="-O2"

echo "==> Building PostgreSQL"
unset TARGET_OS TARGET_ARCH
make -j"$(sysctl -n hw.logicalcpu)"
make install
make -C contrib/pgcrypto install

PG_CONFIG="$STAGE_DIR/bin/pg_config"
export PATH="$STAGE_DIR/bin:$PATH"

echo "==> Stripping macOS binaries"
find "$STAGE_DIR/bin" -type f -exec strip -S -x {} \; 2>/dev/null || true
find "$STAGE_DIR/lib" -name '*.dylib' -type f -exec strip -S -x {} \; 2>/dev/null || true

echo "==> Cloning pgvector $PGVECTOR_VERSION"
cd "$BUILD_DIR"
rm -rf pgvector
git clone --branch "v${PGVECTOR_VERSION}" --depth 1 \
  https://github.com/pgvector/pgvector.git pgvector

echo "==> Building pgvector"
cd pgvector
make PG_CONFIG="$PG_CONFIG" -j"$(sysctl -n hw.logicalcpu)"
make PG_CONFIG="$PG_CONFIG" install

echo "==> Assembling runtime layout"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"/{bin,lib,share}
for BIN in postgres pg_ctl pg_dump pg_restore psql initdb; do
  cp -a "$STAGE_DIR/bin/$BIN" "$RUNTIME_DIR/bin/" 2>/dev/null || echo "WARN: $BIN not found"
done
cp -a "$STAGE_DIR/lib"/.   "$RUNTIME_DIR/lib/"   2>/dev/null || true
cp -a "$STAGE_DIR/share"/. "$RUNTIME_DIR/share/" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Bundle foreign Homebrew dyn deps — seed from binaries AND every extension
# module under lib/postgresql/ (dlopen-loaded). Recursive otool closure.
# ---------------------------------------------------------------------------
echo "==> Bundling foreign Homebrew dynamic libraries"

FOREIGN_PREFIXES=("${BREW_PREFIX}/opt" "/opt/homebrew" "/usr/local/Cellar" "/opt/local")
is_foreign() {
  local p="$1"
  for prefix in "${FOREIGN_PREFIXES[@]}"; do
    [[ "$p" == "$prefix"/* ]] && return 0
  done
  return 1
}

declare -a SCAN_QUEUE
declare -A SCANNED
for seed in "$RUNTIME_DIR/bin/postgres" "$RUNTIME_DIR/bin/psql" "$RUNTIME_DIR/bin/pg_ctl"; do
  [[ -f "$seed" ]] && SCAN_QUEUE+=("$seed")
done
while IFS= read -r -d '' ext; do
  SCAN_QUEUE+=("$ext")
done < <(find "$RUNTIME_DIR/lib/postgresql" -name '*.dylib' -print0 2>/dev/null)

bundle_dylib() {
  local src="$1"
  local real
  real="$(readlink -f "$src" 2>/dev/null || echo "$src")"
  local dest_real="$RUNTIME_DIR/lib/$(basename "$real")"
  if [[ ! -f "$dest_real" ]]; then
    cp -L "$real" "$dest_real"
    chmod u+w "$dest_real"
    SCAN_QUEUE+=("$dest_real")
  fi
  local src_dir
  src_dir="$(dirname "$real")"
  while IFS= read -r -d '' link; do
    local link_target
    link_target="$(readlink "$link")"
    local resolved="$src_dir/$link_target"
    local resolved_norm
    resolved_norm="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd)/$(basename "$resolved")" || true
    if [[ "$resolved_norm" == "$real" ]]; then
      local dest_link="$RUNTIME_DIR/lib/$(basename "$link")"
      [[ ! -e "$dest_link" ]] && ln -s "$(basename "$real")" "$dest_link"
    fi
  done < <(find "$src_dir" -maxdepth 1 -type l -print0 2>/dev/null)
}

while [[ ${#SCAN_QUEUE[@]} -gt 0 ]]; do
  current="${SCAN_QUEUE[0]}"
  SCAN_QUEUE=("${SCAN_QUEUE[@]:1}")
  real_current="$(readlink -f "$current" 2>/dev/null || echo "$current")"
  [[ -n "${SCANNED[$real_current]+x}" ]] && continue
  SCANNED["$real_current"]=1
  while IFS= read -r line; do
    dep="$(echo "$line" | awk '{print $1}')"
    [[ -z "$dep" || "$dep" == @* ]] && continue
    [[ "$dep" == /usr/lib/* || "$dep" == /System/Library/* ]] && continue
    if is_foreign "$dep"; then
      bundle_dylib "$dep"
    fi
  done < <(otool -L "$current" 2>/dev/null | tail -n +2)
done

# ---------------------------------------------------------------------------
# Rewrite install_names — three Mach-O classes
# ---------------------------------------------------------------------------
echo "==> Rewriting install_names"

rewrite_macho() {
  local macho="$1" macho_type="$2"
  while IFS= read -r line; do
    dep="$(echo "$line" | awk '{print $1}')"
    [[ -z "$dep" || "$dep" == @* ]] && continue
    [[ "$dep" == /usr/lib/* || "$dep" == /System/Library/* ]] && continue
    local should=0
    if is_foreign "$dep"; then should=1; fi
    if [[ "$dep" == "$STAGE_DIR/lib"* || "$dep" == "$RUNTIME_DIR/lib"* ]]; then should=1; fi
    if [[ "$should" -eq 1 ]]; then
      local bname new
      bname="$(basename "$dep")"
      case "$macho_type" in
        binary)    new="@loader_path/../lib/$bname" ;;
        toplib)    new="@loader_path/$bname" ;;
        extension) new="@loader_path/../../lib/$bname" ;;
      esac
      install_name_tool -change "$dep" "$new" "$macho" 2>/dev/null || true
    fi
  done < <(otool -L "$macho" 2>/dev/null | tail -n +2)

  case "$macho_type" in
    toplib)    install_name_tool -id "@rpath/$(basename "$macho")" "$macho" 2>/dev/null || true ;;
    extension) install_name_tool -id "@rpath/postgresql/$(basename "$macho")" "$macho" 2>/dev/null || true ;;
  esac

  case "$macho_type" in
    binary)
      if ! otool -l "$macho" 2>/dev/null | grep -q '@loader_path/../lib'; then
        install_name_tool -add_rpath "@loader_path/../lib" "$macho" 2>/dev/null || true
      fi ;;
    extension)
      if ! otool -l "$macho" 2>/dev/null | grep -q '@loader_path/../../lib'; then
        install_name_tool -add_rpath "@loader_path/../../lib" "$macho" 2>/dev/null || true
      fi ;;
  esac
}

while IFS= read -r -d '' bin; do
  file "$bin" 2>/dev/null | grep -q 'Mach-O' && rewrite_macho "$bin" binary
done < <(find "$RUNTIME_DIR/bin" -type f -print0)

while IFS= read -r -d '' lib; do
  file "$lib" 2>/dev/null | grep -q 'Mach-O' && rewrite_macho "$lib" toplib
done < <(find "$RUNTIME_DIR/lib" -maxdepth 1 -type f -name '*.dylib' -print0)

while IFS= read -r -d '' extlib; do
  file "$extlib" 2>/dev/null | grep -q 'Mach-O' && rewrite_macho "$extlib" extension
done < <(find "$RUNTIME_DIR/lib/postgresql" -type f -name '*.dylib' -print0 2>/dev/null)

echo "==> Stripping static archives from lib/"
find "$RUNTIME_DIR/lib" -name '*.a' -delete

echo "==> Ad-hoc re-codesign every Mach-O (install_name_tool invalidates signature)"
while IFS= read -r -d '' macho; do
  file "$macho" 2>/dev/null | grep -q 'Mach-O' && codesign --force --sign - "$macho" 2>/dev/null || true
done < <(find "$RUNTIME_DIR/bin" "$RUNTIME_DIR/lib" -type f -print0)

# ---------------------------------------------------------------------------
# Self-contained smoke — full PG lifecycle
# ---------------------------------------------------------------------------
echo "==> Self-contained smoke test (initdb + CREATE EXTENSION vector + distance query)"
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_LIBRARY_PATH
SMOKE_DATA="$BUILD_DIR/smoke-pgdata"
SMOKE_LOG="$BUILD_DIR/smoke-pg.log"
SMOKE_PORT=55899
rm -rf "$SMOKE_DATA"
"$RUNTIME_DIR/bin/postgres" --version || { echo "FAIL: postgres --version"; exit 1; }
BAD="$(otool -L "$RUNTIME_DIR/bin/postgres" | grep -E '(/opt/homebrew|/usr/local/Cellar|/opt/local|'"$STAGE_DIR"')' || true)"
if [[ -n "$BAD" ]]; then echo "FAIL: stray paths in postgres:"; echo "$BAD"; exit 1; fi

VECTOR_DYLIB="$RUNTIME_DIR/lib/postgresql/vector.dylib"
if [[ -f "$VECTOR_DYLIB" ]]; then
  VBAD="$(otool -L "$VECTOR_DYLIB" | grep -E '(/opt/homebrew|/usr/local/Cellar|/opt/local|'"$STAGE_DIR"')' || true)"
  if [[ -n "$VBAD" ]]; then echo "FAIL: stray paths in vector.dylib:"; echo "$VBAD"; exit 1; fi
fi

"$RUNTIME_DIR/bin/initdb" -D "$SMOKE_DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -o "-p $SMOKE_PORT -h 127.0.0.1" -l "$SMOKE_LOG" -w start
trap '"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m fast stop > /dev/null 2>&1 || true' EXIT

"$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
EXTV="$("$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
DIST="$("$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;")"
echo "  vector extension version: $EXTV"
echo "  distance query result:    $DIST"
[[ "$EXTV" == "$PGVECTOR_VERSION" ]] || { echo "FAIL: extversion=$EXTV expected=$PGVECTOR_VERSION"; exit 1; }
"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m fast stop > /dev/null
trap - EXIT
rm -rf "$SMOKE_DATA"
echo "  PASS smoke (extension load + vector distance)"

# Licenses
curl -fsSL "https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/COPYRIGHT" \
  -o "$RUNTIME_DIR/LICENSE.postgresql"
cp "$BUILD_DIR/pgvector/LICENSE" "$RUNTIME_DIR/LICENSE.pgvector"

echo "==> Creating tarball: $OUTPUT_NAME"
cd "$BUILD_DIR"
tar czf "$DIST_DIR/$OUTPUT_NAME" -C "$RUNTIME_DIR" .

echo "==> Generating sha256 sidecar"
cd "$DIST_DIR"
shasum -a 256 "$OUTPUT_NAME" > "${OUTPUT_NAME}.sha256"

echo "==> Done: $DIST_DIR/$OUTPUT_NAME"
ls -lh "$DIST_DIR/$OUTPUT_NAME"
