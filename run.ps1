# Inicia o math2big em http://localhost:8765
if (-not (Test-Path .venv)) { python -m venv .venv; .venv\Scripts\pip install -r requirements.txt }
if (-not (Test-Path .env) -and -not $env:GEMINI_API_KEY -and -not $env:ANTHROPIC_API_KEY) {
  Write-Warning "Crie um arquivo .env com GEMINI_API_KEY=... antes de converter imagens."
}
Start-Process "http://localhost:8765"
.venv\Scripts\python -m uvicorn server:app --port 8765
