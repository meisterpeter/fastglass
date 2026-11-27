$ErrorActionPreference = "Stop"

$FrontendSrc = Join-Path $PSScriptRoot "frontend"
$BuildDir = Join-Path $env:LOCALAPPDATA "fastglass-frontend-build"

Write-Host "Syncing frontend sources to local build dir: $BuildDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

# Copy config + source files without touching local node_modules
Copy-Item -Path (Join-Path $FrontendSrc "package.json") -Destination $BuildDir -Force
Copy-Item -Path (Join-Path $FrontendSrc "tsconfig.json") -Destination $BuildDir -Force
Copy-Item -Path (Join-Path $FrontendSrc "vite.config.ts") -Destination $BuildDir -Force
Copy-Item -Path (Join-Path $FrontendSrc "index.html") -Destination $BuildDir -Force

$DstSrc = Join-Path $BuildDir "src"
if (Test-Path $DstSrc) {
    Remove-Item -Path $DstSrc -Recurse -Force
}
Copy-Item -Path (Join-Path $FrontendSrc "src") -Destination $DstSrc -Recurse -Force

Push-Location $BuildDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "Installing npm dependencies on local disk..." -ForegroundColor Cyan
        npm install
    }
    Write-Host "Type-checking and building production bundle..." -ForegroundColor Cyan
    npm run build
} finally {
    Pop-Location
}

$OutDist = Join-Path $FrontendSrc "dist"
if (Test-Path $OutDist) {
    Remove-Item -Path $OutDist -Recurse -Force
}
Copy-Item -Path (Join-Path $BuildDir "dist") -Destination $OutDist -Recurse -Force
Write-Host "Frontend built successfully -> $OutDist" -ForegroundColor Green
