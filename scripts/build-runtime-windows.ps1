# build-runtime-windows.ps1 — Build PostgreSQL 16 + pgvector runtime on Windows.
# Uses EnterpriseDB Windows binary zip (community license) as the PG base.
# Builds pgvector from source via MSVC/nmake. Bulk-copies bin/* (.exe + .dll) so
# all runtime DLLs ship next to postgres.exe — no PATH gymnastics for fresh users.
# Final smoke: initdb + pg_ctl start + CREATE EXTENSION vector + distance query.
# Produces: dist\mixdog-runtime-win32-x64-pg{pgver}-pgvector{vecver}.tar.gz

$ErrorActionPreference = 'Stop'

$PG_VERSION       = '16.4'
$PGVECTOR_VERSION = '0.8.2'
$EDB_ZIP_URL      = "https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip"
$TARGET_OS        = $env:TARGET_OS   ?? 'win32'
$TARGET_ARCH      = $env:TARGET_ARCH ?? 'x64'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir    = (Resolve-Path "$ScriptDir\..").Path
$BuildDir   = "$RootDir\build\runtime-win32-$TARGET_ARCH"
$StageDir   = "$BuildDir\pgsql"          # EDB zip extracts to a 'pgsql' subdirectory
$DistDir    = "$RootDir\dist"
$RuntimeDir = "$BuildDir\runtime"

$OutputName = "mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
New-Item -ItemType Directory -Force -Path $BuildDir, $DistDir,
  "$RuntimeDir\bin", "$RuntimeDir\lib", "$RuntimeDir\share" | Out-Null

$PgBin    = "$StageDir\bin"
$PgConfig = "$PgBin\pg_config.exe"

if (Test-Path "$PgBin\postgres.exe") {
    Write-Host "==> Cache hit: EDB PG already extracted at $StageDir — skipping download/extract"
} else {
    Write-Host "==> Downloading EnterpriseDB PostgreSQL $PG_VERSION Windows zip"
    $ZipPath = "$BuildDir\pgsql.zip"
    if (-not (Test-Path $ZipPath)) {
        Invoke-WebRequest -Uri $EDB_ZIP_URL -OutFile $ZipPath -UseBasicParsing
    }
    Write-Host "==> Extracting PostgreSQL zip"
    Expand-Archive -Path $ZipPath -DestinationPath $BuildDir -Force
}

if (-not (Test-Path $PgConfig)) {
    Write-Error "pg_config.exe not found at $PgConfig — check EDB zip structure."
    exit 1
}

$PgVectorDir = "$BuildDir\pgvector"
$VectorDllStageBin = "$StageDir\bin\vector.dll"
$VectorDllStageLib = "$StageDir\lib\vector.dll"

if ((Test-Path $VectorDllStageBin) -or (Test-Path $VectorDllStageLib)) {
    Write-Host "==> Cache hit: pgvector already installed in $StageDir — skipping clone/build"
} else {
    Write-Host "==> Cloning pgvector $PGVECTOR_VERSION"
    if (Test-Path $PgVectorDir) { Remove-Item -Recurse -Force $PgVectorDir }
    git clone --branch "v$PGVECTOR_VERSION" --depth 1 `
        https://github.com/pgvector/pgvector.git $PgVectorDir

    Write-Host "==> Building pgvector (MSVC/nmake — build only, install is manual)"
    # We skip `nmake install` because EDB's pg_config returns baked-in paths
    # like C:\Program Files\PostgreSQL\14\... which don't exist on a clean
    # runner and don't match our $StageDir. Build only, then copy artifacts
    # directly from $PgVectorDir to $StageDir below.
    Push-Location $PgVectorDir
    try {
        $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        $VcVarsAll = & $VsWhere -latest -find 'VC\Auxiliary\Build\vcvarsall.bat' 2>$null | Select-Object -First 1
        if (-not $VcVarsAll) {
            Write-Error "vswhere could not locate vcvarsall.bat — Visual Studio Build Tools required."
            exit 1
        }
        $BuildCmd = "`"$VcVarsAll`" amd64 && nmake /F Makefile.win PG_CONFIG=`"$PgConfig`""
        cmd /c $BuildCmd
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pgvector nmake build failed (exit $LASTEXITCODE)"
            exit 1
        }
    } finally {
        Pop-Location
    }

    Write-Host "==> Manually staging pgvector artifacts → $StageDir"
    # Build artifacts produced in $PgVectorDir; copy to staging deterministically.
    $StageExtDir = "$StageDir\share\extension"
    New-Item -ItemType Directory -Force -Path $StageExtDir | Out-Null
    Copy-Item "$PgVectorDir\vector.dll"     "$StageDir\lib\"   -Force
    Copy-Item "$PgVectorDir\vector.control" $StageExtDir       -Force
    Copy-Item "$PgVectorDir\sql\vector--*.sql" $StageExtDir    -Force
    Copy-Item "$PgVectorDir\sql\vector.sql"    "$StageExtDir\vector--$PGVECTOR_VERSION.sql" -Force -ErrorAction SilentlyContinue
}

Write-Host "==> Verifying pgvector stage outputs"
$VectorControlStage = "$StageDir\share\extension\vector.control"
$VectorSqlStage     = "$StageDir\share\extension\vector--$PGVECTOR_VERSION.sql"
$VectorDllStageLib  = "$StageDir\lib\vector.dll"
$VectorDllStageBin  = "$StageDir\bin\vector.dll"
if (-not (Test-Path $VectorControlStage)) {
    Write-Error "ASSERT FAILED: vector.control not found at $VectorControlStage"
    exit 1
}
if (-not (Test-Path $VectorSqlStage)) {
    Write-Error "ASSERT FAILED: vector--$PGVECTOR_VERSION.sql not found at $VectorSqlStage"
    exit 1
}
if (-not ((Test-Path $VectorDllStageLib) -or (Test-Path $VectorDllStageBin))) {
    Write-Error "ASSERT FAILED: vector.dll not found in $StageDir\lib\ or $StageDir\bin\"
    exit 1
}
Write-Host "  pgvector stage outputs verified"

Write-Host "==> Assembling runtime layout — bulk copy ALL .exe + .dll from EDB bin"
# EDB ships runtime DLLs in pgsql\bin\: libcrypto-3-x64, libssl-3-x64, libpq,
# libintl-9, libiconv-2, libxml2, libxslt, icu67*, libwinpthread-1, libecpg,
# libecpg_compat, libpgtypes, liblz4, libzstd, etc. They MUST land next to
# postgres.exe so the Windows loader resolves them without PATH manipulation.
Copy-Item "$PgBin\*.exe","$PgBin\*.dll" "$RuntimeDir\bin\" -Force

Write-Host "==> Copying lib/ and share/"
Copy-Item -Recurse -Force "$StageDir\lib\*"   "$RuntimeDir\lib\"   -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force "$StageDir\share\*" "$RuntimeDir\share\" -ErrorAction SilentlyContinue

Write-Host "==> Ensuring vector.dll is on the loader's DLL search path"
# pgvector Makefile.win installs vector.dll into pgsql\lib by default. Move it
# to bin\ so postgres.exe finds it without LD_LIBRARY_PATH equivalent.
$VectorDllLib = "$RuntimeDir\lib\vector.dll"
$VectorDllBin = "$RuntimeDir\bin\vector.dll"
if ((Test-Path $VectorDllLib) -and -not (Test-Path $VectorDllBin)) {
    Move-Item $VectorDllLib $VectorDllBin
}

Write-Host "==> Asserting runtime layout"
$VectorControl = "$RuntimeDir\share\extension\vector.control"
if (-not (Test-Path $VectorControl)) { Write-Error "ASSERT FAILED: $VectorControl not found"; exit 1 }
$VectorSql = "$RuntimeDir\share\extension\vector--$PGVECTOR_VERSION.sql"
if (-not (Test-Path $VectorSql))     { Write-Error "ASSERT FAILED: $VectorSql not found"; exit 1 }
if (-not ((Test-Path "$RuntimeDir\bin\vector.dll") -or (Test-Path "$RuntimeDir\lib\vector.dll"))) {
    Write-Error "ASSERT FAILED: vector.dll not found in bin\ or lib\"
    exit 1
}
Write-Host "  PASS runtime layout"

# Licenses
Copy-Item "$StageDir\doc\postgresql\COPYRIGHT" "$RuntimeDir\LICENSE.postgresql" -ErrorAction SilentlyContinue
if (Test-Path "$PgVectorDir\LICENSE") {
    Copy-Item "$PgVectorDir\LICENSE" "$RuntimeDir\LICENSE.pgvector"
}

Write-Host "==> Self-contained smoke test (initdb + CREATE EXTENSION vector + distance query)"
& "$RuntimeDir\bin\postgres.exe" --version
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: postgres.exe --version exit $LASTEXITCODE"; exit 1 }

$SmokeData = "$BuildDir\smoke-pgdata"
$SmokeLog  = "$BuildDir\smoke-pg.log"
$SmokePort = 55899
if (Test-Path $SmokeData) { Remove-Item -Recurse -Force $SmokeData }

& "$RuntimeDir\bin\initdb.exe" -D $SmokeData --username=postgres --auth-local=trust --no-locale -E UTF8 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: initdb"; exit 1 }

& "$RuntimeDir\bin\pg_ctl.exe" -D $SmokeData -o "-p $SmokePort -h 127.0.0.1" -l $SmokeLog -w start
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: pg_ctl start (see $SmokeLog)"; Get-Content $SmokeLog | Select-Object -Last 30; exit 1 }

try {
    & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -c "CREATE EXTENSION vector;" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CREATE EXTENSION vector failed" }
    $ExtV = & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"
    $Dist = & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -tAc "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;"
    Write-Host "  vector extension version: $ExtV"
    Write-Host "  distance query result:    $Dist"
    if ($ExtV.Trim() -ne $PGVECTOR_VERSION) {
        Write-Error "FAIL: extversion='$ExtV' expected='$PGVECTOR_VERSION'"
        exit 1
    }
    Write-Host "  PASS smoke (extension load + vector distance)"
}
finally {
    & "$RuntimeDir\bin\pg_ctl.exe" -D $SmokeData -m fast stop 2>$null | Out-Null
    Remove-Item -Recurse -Force $SmokeData -ErrorAction SilentlyContinue
}

Write-Host "==> Creating tarball: $OutputName"
# bsdtar (Windows tar.exe) requires forward slashes for -C target on Windows
# paths; backslashes cause "Couldn't visit directory". Layout: bin/lib/share at
# root (no runtime/ prefix), matching Linux/macOS scripts and fetcher contract.
$DistDirFwd    = $DistDir.Replace('\', '/')
$RuntimeDirFwd = $RuntimeDir.Replace('\', '/')
& tar -czf "$DistDirFwd/$OutputName" -C "$RuntimeDirFwd" .
if ($LASTEXITCODE -ne 0) { Write-Error "tar failed (exit $LASTEXITCODE)"; exit 1 }

Write-Host "==> Generating sha256 sidecar"
Push-Location $DistDir
$Hash = (Get-FileHash -Algorithm SHA256 $OutputName).Hash.ToLower()
"$Hash  $OutputName" | Out-File -Encoding ascii "${OutputName}.sha256"
Pop-Location

Write-Host "==> Done: $DistDir\$OutputName"
Get-Item "$DistDir\$OutputName" | Select-Object Name, Length
