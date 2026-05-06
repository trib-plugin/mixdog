#!/usr/bin/env bash
# build-runtime-macos.sh — Build PostgreSQL 16 + pgvector from source on macOS.
# Runs natively on both macos-13 (x64) and macos-14 (arm64) hosted runners.
# Produces: dist/mixdog-runtime-darwin-{arch}-pg{pgver}-pgvector{vecver}.tar.gz
# NOTE: This script has not been run end-to-end; command sequences are reasonable
#       but may need minor adjustment on first live run.

set -euo pipefail

PG_VERSION="16.4"
PGVECTOR_VERSION="0.7.4"
TARGET_OS="${TARGET_OS:-darwin}"
# Detect arch from uname if not explicitly set
TARGET_ARCH="${TARGET_ARCH:-$(uname -m | sed 's/x86_64/x64/' | sed 's/arm64/arm64/')}"

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

# Ensure Homebrew-installed headers are on the path
BREW_PREFIX="$(brew --prefix)"
export CPPFLAGS="-I${BREW_PREFIX}/opt/readline/include -I${BREW_PREFIX}/opt/openssl@3/include -I${BREW_PREFIX}/opt/icu4c/include"
export LDFLAGS="-L${BREW_PREFIX}/opt/readline/lib -L${BREW_PREFIX}/opt/openssl@3/lib -L${BREW_PREFIX}/opt/icu4c/lib"
export PKG_CONFIG_PATH="${BREW_PREFIX}/opt/openssl@3/lib/pkgconfig:${BREW_PREFIX}/opt/icu4c/lib/pkgconfig"

echo "==> Downloading PostgreSQL $PG_VERSION source"
cd "$BUILD_DIR"
curl -fsSL "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.gz" \
  -o "postgresql-${PG_VERSION}.tar.gz"
tar xzf "postgresql-${PG_VERSION}.tar.gz"

echo "==> Configuring PostgreSQL"
cd "postgresql-${PG_VERSION}"
./configure \
  --prefix="$STAGE_DIR" \
  --without-perl \
  --without-python \
  --without-tcl \
  --with-openssl \
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
# strip on macOS: -x strips local symbols (safe for dylibs); -S strips debug
find "$STAGE_DIR/bin" -type f -exec strip -S -x {} \; 2>/dev/null || true
find "$STAGE_DIR/lib" -name '*.dylib' -type f -exec strip -S -x {} \; 2>/dev/null || true

echo "==> Cloning pgvector $PGVECTOR_VERSION"
cd "$BUILD_DIR"
git clone --branch "v${PGVECTOR_VERSION}" --depth 1 \
  https://github.com/pgvector/pgvector.git pgvector

echo "==> Building pgvector"
cd pgvector
make PG_CONFIG="$PG_CONFIG" -j"$(sysctl -n hw.logicalcpu)"
make PG_CONFIG="$PG_CONFIG" install

echo "==> Assembling runtime layout"
for BIN in postgres pg_ctl pg_dump pg_restore psql initdb; do
  cp -a "$STAGE_DIR/bin/$BIN" "$RUNTIME_DIR/bin/" 2>/dev/null || echo "WARN: $BIN not found"
done

cp -a "$STAGE_DIR/lib"/* "$RUNTIME_DIR/lib/" 2>/dev/null || true
cp -a "$STAGE_DIR/share"/* "$RUNTIME_DIR/share/" 2>/dev/null || true

# Licenses
curl -fsSL "https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/COPYRIGHT" \
  -o "$RUNTIME_DIR/LICENSE.postgresql"
cp "$BUILD_DIR/pgvector/LICENSE" "$RUNTIME_DIR/LICENSE.pgvector"

echo "==> Creating tarball: $OUTPUT_NAME"
cd "$BUILD_DIR"
tar czf "$DIST_DIR/$OUTPUT_NAME" -C "$BUILD_DIR" runtime/

echo "==> Generating sha256 sidecar"
cd "$DIST_DIR"
shasum -a 256 "$OUTPUT_NAME" > "${OUTPUT_NAME}.sha256"

echo "==> Done: $DIST_DIR/$OUTPUT_NAME"
ls -lh "$DIST_DIR/$OUTPUT_NAME"
