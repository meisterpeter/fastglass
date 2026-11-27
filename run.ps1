param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 8765,
    [switch]$RebuildFrontend
)

$ErrorActionPreference = "Stop"

$DistIndex = Join-Path $PSScriptRoot "frontend\dist\index.html"
if ($RebuildFrontend -or -not (Test-Path $DistIndex)) {
    & (Join-Path $PSScriptRoot "build_frontend.ps1")
}

$BackendDir = Join-Path $PSScriptRoot "backend"
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating Python 3.12 virtual environment with uv..." -ForegroundColor Cyan
    Push-Location $BackendDir
    try {
        uv venv --python 3.12
        uv pip install fastapi "uvicorn[standard]" h5py numpy pydantic python-multipart pybigtools
    } finally {
        Pop-Location
    }
}

$env:FASTGLASS_ROOT = $Root
Write-Host "Starting FastGlass at http://127.0.0.1:$Port  (root: $Root)" -ForegroundColor Green

Push-Location $BackendDir
try {
    & $VenvPython -m uvicorn fastglass.main:app --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
}
