# Orbit Prompt Generator

Upload documents or screenshots describing an integration scenario and get instant, AI-generated SAP CPI iFlow outputs — a ready-to-use configuration prompt, a complete step-by-step build guide with scripts, or a concise summary. Powered by Claude on SAP AI Core.

## Features

| Button | What it produces |
|---|---|
| **Generate Prompt** | Structured iFlow configuration prompt — topology paragraph, component config, adapter settings — ready to paste into the iFlow builder |
| **Instructions** | Full manual build guide: exact UI steps, complete Groovy/XSLT/JSONata scripts, Postman + cURL testing instructions. Auto-continues if response hits token limits |
| **Summarize** | Concise overview — iFlow name/purpose, topology, adapters & protocols table, key config, gotchas |

All outputs can be exported as **TXT**, **Word (.docx)**, or **PDF** directly from the toolbar.

## Quick Start

### Recommended (Windows)

```powershell
.\dev.ps1
```

Kills any stale processes on ports 8000 and 5173, then starts both servers in separate windows.

### Manual

```bash
# Copy env and fill in SAP AI Core credentials
cp .env.example .env

# Install Python dependencies
pip install -e .

# Backend
uvicorn main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

- Backend API: `http://localhost:8000`
- Frontend UI: `http://localhost:5173`
- Swagger docs: `http://localhost:8000/docs`

## How it works

1. User uploads one or more files via drag-and-drop or file picker
2. Backend extracts text from documents or encodes images as base64
3. Content is sent to Claude on SAP AI Core with a mode-specific system prompt
4. Claude streams the response token-by-token to the UI
5. For Instructions, up to 3 automatic continuation calls handle large iFlows that exceed the token limit
6. Output is displayed in a tabbed card with Copy and Export options

## API Endpoints

### `POST /api/generate-prompt`
Returns a structured SAP CPI iFlow configuration prompt.

### `POST /api/generate-instructions`
Returns a complete step-by-step manual build guide with scripts and Postman/cURL tests.

### `POST /api/summarize`
Returns a concise iFlow overview (purpose, topology, adapters, key config).

All three endpoints accept `multipart/form-data` with one or more `files` and respond with a Server-Sent Events (SSE) stream:

| Event | Payload |
|---|---|
| `step` | `{ key, message }` — progress update (extract, generate, validate, retry) |
| `step_done` | `{ key, message }` — step completed |
| `chunk` | `{ text }` — streaming token from Claude |
| `done` | `{ prompt, valid?, warning? }` — final output |
| `error` | `{ message }` — error description |

## Supported file types

| Format | Extensions |
|---|---|
| PDF | `.pdf` |
| Word | `.docx`, `.doc` |
| PowerPoint | `.pptx` |
| Excel | `.xlsx`, `.xls` |
| CSV | `.csv` |
| Plain text | `.txt` |
| API specs | `.json`, `.yaml`, `.yml` |
| Service definitions | `.xml`, `.wsdl` |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` |

## Environment variables

| Variable | Description |
|---|---|
| `AICORE_CLIENT_ID` | OAuth2 client ID from SAP AI Core service key |
| `AICORE_CLIENT_SECRET` | OAuth2 client secret |
| `AICORE_AUTH_URL` | Token endpoint base URL |
| `AICORE_BASE_URL` | AI Core API base URL (includes `/v2`) |
| `AICORE_RESOURCE_GROUP` | Resource group (default: `default`) |
| `LLM_DEPLOYMENT_ID` | Claude deployment ID in SAP AI Core |
| `LLM_TIMEOUT` | LLM request timeout in seconds (default: `120`) |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins (default: `http://localhost:5173`) |
| `LLM_USAGE_MONITOR_BASE_URL` | Usage monitor service URL (omit to disable) |
| `LLM_USAGE_MONITOR_APP_ID` | App ID for the usage monitor |
| `LLM_USAGE_MONITOR_MODEL_NAME` | Model name reported to the monitor |
| `LLM_USAGE_MONITOR_API_KEY` | Bearer token for the usage monitor |

## Cloud Foundry Deployment

```bash
# Build frontend first
cd frontend && npm run build && cd ..

# Set secrets (do this before cf push)
cf set-env orbit-prompt-creator AICORE_CLIENT_ID     <value>
cf set-env orbit-prompt-creator AICORE_CLIENT_SECRET <value>
cf set-env orbit-prompt-creator AICORE_AUTH_URL      <value>
cf set-env orbit-prompt-creator AICORE_BASE_URL      <value>
cf set-env orbit-prompt-creator LLM_DEPLOYMENT_ID    <value>

# Deploy
cf push
```

The `manifest.yml` targets the `orbit-prompt-creator` app with 512 MB memory, `python_buildpack`, and a health check at `/health`.

## Project structure

```
main.py                      FastAPI entry point — CORS, router, health check, static SPA serving
app/
  routers/prompt.py          POST /api/generate-prompt, /generate-instructions, /summarize
  services/
    extractor.py             File → text or base64 image
    aicore.py                SAP AI Core OAuth2 + streaming chat with auto-continuation
    validator.py             Validates prompt structure before returning
  monitoring/
    llm_monitor.py           Fire-and-forget usage monitor POST after every LLM call

frontend/src/
  App.jsx                    Top-level state, streaming logic, tab management
  components/
    FileUpload.jsx           Drag-and-drop multi-file upload with type chips
    PromptOutput.jsx         Code block display with Copy and Export
    InstructionsOutput.jsx   Formatted renderer (headings, bullets, tables) with Copy and Export
    ExportMenu.jsx           TXT / DOCX / PDF export dropdown
    ProgressSteps.jsx        Animated step timeline during generation
  utils/
    exportUtils.js           TXT, DOCX (docx), and PDF (jsPDF) export logic
```
