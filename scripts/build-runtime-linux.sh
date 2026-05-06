#!/usr/bin/env bash
# build-runtime-linux.sh — Build PostgreSQL 16 + pgvector from source on Linux.
# Targets the runner's native arch (x64 or arm64).
# Produces: dist/mixdog-runtime-linux-{arch}-pg{pgver}-pgvector{vecver}.tar.gz
# NOTE: This script has not been run end-to-end; command sequences are reasonable
#       but may need minor adjustment on first live run.

set -euo pipefail

PG_VERSION="16.4"
PGVECTOR_VERSION="0.7.4"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-x64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/runtime-linux-$TARGET_ARCH"
STAGE_DIR="$BUILD_DIR/stage"
DIST_DIR="$ROOT_DIR/dist"
RUNTIME_DIR="$BUILD_DIR/runtime"

OUTPUT_NAME="mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

mkdir -p "$BUILD_DIR" "$STAGE_DIR" "$DIST_DIR" "$RUNTIME_DIR"/{bin,lib,share}

echo "==> Installing build dependencies"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  build-essential libreadline-dev zlib1g-dev libssl-dev \
  libicu-dev pkg-config curl git ca-certificates

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
  --with-libxml \
  --enable-thread-safety \
  CFLAGS="-O2"

echo "==> Building PostgreSQL (this takes a while)"
# PG Makefile.global has its own TARGET_ARCH var (used in *.so install paths);
# our env-passed TARGET_ARCH=x64 collides as a make-variable override and
# leaks into compile commands. Unset before make.
unset TARGET_OS TARGET_ARCH
make -j"$(nproc)"
make install
make -C contrib/pgcrypto install

PG_CONFIG="$STAGE_DIR/bin/pg_config"
export PATH="$STAGE_DIR/bin:$PATH"

echo "==> Stripping PostgreSQL binaries"
find "$STAGE_DIR" -name '*.so*' -type f -exec strip --strip-debug {} \; 2>/dev/null || true
find "$STAGE_DIR/bin" -type f -exec strip --strip-all {} \; 2>/dev/null || true

echo "==> Cloning pgvector $PGVECTOR_VERSION"
cd "$BUILD_DIR"
git clone --branch "v${PGVECTOR_VERSION}" --depth 1 \
  https://github.com/pgvector/pgvector.git pgvector

echo "==> Building pgvector"
cd pgvector
make PG_CONFIG="$PG_CONFIG" -j"$(nproc)"
make PG_CONFIG="$PG_CONFIG" install

echo "==> Assembling runtime layout"
# Copy essential binaries
cp -a "$STAGE_DIR/bin/postgres" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_ctl" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_dump" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_restore" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/psql" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/initdb" "$RUNTIME_DIR/bin/"

# Shared libraries
cp -a "$STAGE_DIR/lib"/* "$RUNTIME_DIR/lib/" 2>/dev/null || true

# Share/data
cp -a "$STAGE_DIR/share"/* "$RUNTIME_DIR/share/" 2>/dev/null || true

# Include PostgreSQL LICENSE
curl -fsSL "https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/COPYRIGHT" \
  -o "$RUNTIME_DIR/LICENSE.postgresql"

# Include pgvector LICENSE
cp "$BUILD_DIR/pgvector/LICENSE" "$RUNTIME_DIR/LICENSE.pgvector"

echo "==> Creating tarball: $OUTPUT_NAME"
cd "$BUILD_DIR"
tar czf "$DIST_DIR/$OUTPUT_NAME" -C "$BUILD_DIR" runtime/

echo "==> Generating sha256 sidecar"
cd "$DIST_DIR"
sha256sum "$OUTPUT_NAME" > "${OUTPUT_NAME}.sha256"

echo "==> Done: $DIST_DIR/$OUTPUT_NAME"
ls -lh "$DIST_DIR/$OUTPUT_NAME"
