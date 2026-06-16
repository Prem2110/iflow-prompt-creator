# dev.ps1 — Kill any stale servers on :8000 and :5173, then start backend + frontend.

Write-Host "Clearing ports 8000 and 5173..."

foreach ($port in @(8000, 5173)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "  Killed PID $($conn.OwningProcess) on :$port"
    }
}

Start-Sleep -Seconds 1

# Verify ports are free
foreach ($port in @(8000, 5173)) {
    $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($still) { Write-Warning "Port $port still in use by PID $($still.OwningProcess)" }
}

Write-Host "Starting backend (http://localhost:8000)..."
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot'; py -3 -m uvicorn main:app --reload --port 8000" `
    -WorkingDirectory $PSScriptRoot

Start-Sleep -Seconds 2

Write-Host "Starting frontend (http://localhost:5173)..."
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\frontend'; npm run dev" `
    -WorkingDirectory "$PSScriptRoot\frontend"

Write-Host ""
Write-Host "Both servers started."
Write-Host "  Backend:  http://localhost:8000"
Write-Host "  Frontend: http://localhost:5173"
