$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

New-Item -ItemType Directory -Force -Path "engine" | Out-Null
$gcc = Get-Command gcc -ErrorAction SilentlyContinue
if ($gcc) {
    & $gcc.Source -O2 -Wall -Wextra -o engine/benchmark.exe engine/benchmark.c
    if ($LASTEXITCODE -ne 0) { throw "GCC compilation failed." }
} else {
    $cl = Get-Command cl -ErrorAction SilentlyContinue
    if (-not $cl) {
        throw "No supported C compiler found. Install MinGW-w64 GCC or use a Developer PowerShell for MSVC."
    }
    & $cl.Source /nologo /O2 /W4 /Fe:engine/benchmark.exe engine/benchmark.c
    if ($LASTEXITCODE -ne 0) { throw "MSVC compilation failed." }
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw "Python 3 is required. Install it and rerun run.ps1." }
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    & $python.Source -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create Python virtual environment." }
}

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
& $venvPython -m pip install -r backend/requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Installing Python dependencies failed." }

$server = Start-Process -FilePath $venvPython `
    -ArgumentList "-m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload" `
    -WorkingDirectory $root -PassThru
Start-Sleep -Seconds 2
try {
    Start-Process "http://localhost:8000"
} catch {
    Write-Warning "Open http://localhost:8000 in your browser."
}
Write-Host "CacheSense server started (PID $($server.Id)) at http://localhost:8000"
Write-Host "Stop it by closing its process or running: Stop-Process -Id $($server.Id)"
