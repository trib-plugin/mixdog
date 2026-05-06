# build-runtime-windows.ps1 — Build PostgreSQL 16 + pgvector runtime on Windows.
# Uses EnterpriseDB Windows binary zip (community license) for the PG base.
# Attempts to build pgvector from source using MSVC/nmake.
# Produces: dist\mixdog-runtime-win32-x64-pg{pgver}-pgvector{vecver}.tar.gz
# NOTE: This script has not been run end-to-end. Sections marked TODO may need
#       manual adjustment on first live run.

$ErrorActionPreference = 'Stop'

$PG_VERSION     = '16.4'
$PGVECTOR_VERSION = '0.8.2'
# EDB installer version string (major.minor.patch-build)
# TODO: Verify the current EDB Windows zip URL at https://www.enterprisedb.com/download-postgresql-binaries
# and update $EDB_ZIP_URL if the build number suffix changes.
$EDB_ZIP_URL    = "https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip"
$TARGET_OS      = $env:TARGET_OS   ?? 'win32'
$TARGET_ARCH    = $env:TARGET_ARCH ?? 'x64'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir    = (Resolve-Path "$ScriptDir\..").Path
$BuildDir   = "$RootDir\build\runtime-win32-$TARGET_ARCH"
$StageDir   = "$BuildDir\pgsql"          # EDB zip extracts to a 'pgsql' subdirectory
$DistDir    = "$RootDir\dist"
$RuntimeDir = "$BuildDir\runtime"

$OutputName = "mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

New-Item -ItemType Directory -Force -Path $BuildDir, $DistDir,
  "$RuntimeDir\bin", "$RuntimeDir\lib", "$RuntimeDir\share" | Out-Null

Write-Host "==> Downloading EnterpriseDB PostgreSQL $PG_VERSION Windows zip"
$ZipPath = "$BuildDir\pgsql.zip"
if (-not (Test-Path $ZipPath)) {
    Invoke-WebRequest -Uri $EDB_ZIP_URL -OutFile $ZipPath -UseBasicParsing
}

Write-Host "==> Extracting PostgreSQL zip"
Expand-Archive -Path $ZipPath -DestinationPath $BuildDir -Force
# EDB zip contains a top-level 'pgsql' folder
$PgBin     = "$StageDir\bin"
$PgConfig  = "$PgBin\pg_config.exe"

if (-not (Test-Path $PgConfig)) {
    Write-Error "pg_config.exe not found at $PgConfig — check EDB zip structure."
    exit 1
}

Write-Host "==> Cloning pgvector $PGVECTOR_VERSION"
$PgVectorDir = "$BuildDir\pgvector"
if (-not (Test-Path $PgVectorDir)) {
    git clone --branch "v$PGVECTOR_VERSION" --depth 1 `
        https://github.com/pgvector/pgvector.git $PgVectorDir
}

# TODO: Building pgvector on Windows requires MSVC (cl.exe) and nmake.
# The steps below are derived from pgvector's README for Windows.
# Ensure Visual Studio 2022 Build Tools are available on the runner (windows-2022 includes them).
# If the build fails, the precompiled DLL can be sourced from the pgvector GitHub Releases.
Write-Host "==> Building pgvector (MSVC/nmake)"
Push-Location $PgVectorDir
try {
    # Locate the VS vcvarsall environment initialiser
    $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $VcVarsAll = & $VsWhere -latest -find 'VC\Auxiliary\Build\vcvarsall.bat' 2>$null | Select-Object -First 1
    if (-not $VcVarsAll) {
        Write-Warning "vswhere could not locate vcvarsall.bat. Skipping pgvector build."
        Write-Warning "TODO: Manually run from a Developer Command Prompt:"
        Write-Warning "  cd $PgVectorDir && nmake /F Makefile.win PG_CONFIG=\"$PgConfig\""
    } else {
        # Build inside a cmd shell that has VS env loaded
        $BuildCmd = "`"$VcVarsAll`" amd64 && nmake /F Makefile.win PG_CONFIG=`"$PgConfig`" && nmake /F Makefile.win install PG_CONFIG=`"$PgConfig`""
        cmd /c $BuildCmd
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pgvector nmake build failed (exit $LASTEXITCODE)"
        }
    }
} finally {
    Pop-Location
}

Write-Host "==> Assembling runtime layout"
$Bins = @('postgres.exe','pg_ctl.exe','pg_dump.exe','pg_restore.exe','psql.exe','initdb.exe')
foreach ($b in $Bins) {
    $Src = "$PgBin\$b"
    if (Test-Path $Src) { Copy-Item $Src "$RuntimeDir\bin\" } else { Write-Warning "Missing: $b" }
}
Copy-Item -Recurse -Force "$StageDir\lib\*"   "$RuntimeDir\lib\"   -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force "$StageDir\share\*" "$RuntimeDir\share\" -ErrorAction SilentlyContinue

# pgvector extension files (if build succeeded)
$PgVectorControl = "$StageDir\share\extension\vector.control"
if (Test-Path $PgVectorControl) {
    Write-Host "pgvector extension files present — copying"
} else {
    Write-Warning "pgvector extension files not found — manual install may be required"
}

# Licenses
Copy-Item "$StageDir\doc\postgresql\COPYRIGHT" "$RuntimeDir\LICENSE.postgresql" -ErrorAction SilentlyContinue
if (Test-Path "$PgVectorDir\LICENSE") {
    Copy-Item "$PgVectorDir\LICENSE" "$RuntimeDir\LICENSE.pgvector"
}

Write-Host "==> Creating tarball: $OutputName"
# bsdtar (Windows tar.exe) requires forward slashes for -C target on Windows
# paths; backslashes cause "Couldn't visit directory". Layout: bin/lib/share at
# root (no runtime/ prefix), matching Linux/macOS scripts and fetcher contract.
$DistDirFwd    = $DistDir.Replace('\', '/')
$RuntimeDirFwd = $RuntimeDir.Replace('\', '/')
& tar -czf "$DistDirFwd/$OutputName" -C "$RuntimeDirFwd" .
if ($LASTEXITCODE -ne 0) { Write-Error "tar failed" }

Write-Host "==> Generating sha256 sidecar"
Push-Location $DistDir
$Hash = (Get-FileHash -Algorithm SHA256 $OutputName).Hash.ToLower()
"$Hash  $OutputName" | Out-File -Encoding ascii "${OutputName}.sha256"
Pop-Location

Write-Host "==> Done: $DistDir\$OutputName"
Get-Item "$DistDir\$OutputName" | Select-Object Name, Length
