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

## Deploying to SAP BTP (Business Application Studio)

### Prerequisites

- SAP BAS workspace open and running
- CF CLI logged in: `cf login -a <api-endpoint> -o <org> -s <space>`
- Git access to this repository

---

### Step 1 — Clone or pull the repository

**First time:**
```bash
git clone https://github.com/Prem2110/iflow-prompt-creator.git
cd iflow-prompt-creator
```

**Subsequent deployments (pull latest changes):**
```bash
cd iflow-prompt-creator
git stash                  # stash any local changes if needed
git pull origin master
```

---

### Step 2 — Build the frontend

```bash
cd frontend
npm install
npm run build
cd ..
```

> The `frontend/.npmrc` file already sets `legacy-peer-deps=true` so plain `npm install` works without any extra flags.

This produces the `frontend/dist/` folder that FastAPI serves as the SPA in production.

---

### Step 3 — Set environment variables on CF

Run these once (or whenever credentials change). Values persist on the app between deployments.

```bash
# SAP AI Core credentials
cf set-env orbit-prompt-creator AICORE_CLIENT_ID     <your-client-id>
cf set-env orbit-prompt-creator AICORE_CLIENT_SECRET <your-client-secret>
cf set-env orbit-prompt-creator AICORE_AUTH_URL      <your-auth-url>
cf set-env orbit-prompt-creator AICORE_BASE_URL      <your-base-url>
cf set-env orbit-prompt-creator LLM_DEPLOYMENT_ID    <your-deployment-id>

# Optional: LLM usage monitor (skip if not using)
cf set-env orbit-prompt-creator LLM_USAGE_MONITOR_BASE_URL   <value>
cf set-env orbit-prompt-creator LLM_USAGE_MONITOR_APP_ID     <value>
cf set-env orbit-prompt-creator LLM_USAGE_MONITOR_MODEL_NAME <value>
cf set-env orbit-prompt-creator LLM_USAGE_MONITOR_API_KEY    <value>
```

---

### Step 4 — Deploy

```bash
cf push
```

CF uses `manifest.yml` at the repo root. It will:
- Install Python dependencies from `requirements.txt` via `python_buildpack`
- Start the app with `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Serve the React SPA from `frontend/dist/` at the root URL
- Health-check the app at `/health`

---

### Step 5 — Verify

```bash
cf apps                          # check app is running
cf logs orbit-prompt-creator --recent   # check startup logs
```

Open the app URL shown in `cf apps` output — the UI should load immediately.

---

### Re-deploying after code changes

```bash
cd iflow-prompt-creator
git pull origin master
cd frontend && npm install && npm run build && cd ..
cf push
```

---

### Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` peer dependency error | Already handled by `frontend/.npmrc` — run plain `npm install` |
| `frontend/dist/` not found after push | Run `npm run build` inside `frontend/` before `cf push` |
| App starts but returns 500 | Check `cf logs orbit-prompt-creator --recent` for missing env vars |
| CF push fails with memory error | Increase memory in `manifest.yml`: `memory: 768M` |
| Token/auth errors in app | Re-run `cf set-env` for `AICORE_CLIENT_ID` / `AICORE_CLIENT_SECRET` and `cf restage orbit-prompt-creator` |

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
