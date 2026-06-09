# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Accepts uploaded files (PDF, DOCX, TXT, images) and produces a ready-to-use SAP CPI iFlow configuration prompt. An LLM hosted on SAP AI Core (Claude model) reads the extracted content and generates the structured prompt, which the user copies into a separate SAP CPI iFlow builder app.

## Running the project

### Backend (FastAPI)

```bash
# Install dependencies (use uv or pip)
pip install -e .

# Copy env and fill in values
cp .env.example .env

# Start the dev server
uvicorn main:app --reload --port 8000
```

### Frontend (Vite + React)

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

The Vite dev server proxies `/api/*` to `http://localhost:8000`, so no CORS configuration is needed during development.

## Architecture

```
main.py                  FastAPI app entry — loads .env, registers router, CORS
app/
  routers/prompt.py      POST /api/generate-prompt — orchestrates extraction + LLM call
  services/
    extractor.py         Reads uploaded files → returns text or base64 image payloads
    aicore.py            SAP AI Core OAuth2 token fetch (cached) + chat completions call

frontend/src/
  App.jsx                Top-level state: files, loading, prompt, error
  components/
    FileUpload.jsx       Drag-and-drop + click upload, multi-file, remove individual files
    PromptOutput.jsx     Displays generated prompt in a code block with a Copy button
```

### Key flow

1. User uploads 1–N files via `FileUpload`
2. `POST /api/generate-prompt` receives them as `multipart/form-data`
3. `extractor.py` converts each file to either a text string (PDF/DOCX/TXT) or a base64 image
4. `aicore.py` fetches a cached OAuth2 token from SAP AI Core, then calls the chat completions endpoint with the extracted content + a system prompt that instructs the model to output a structured SAP CPI iFlow prompt
5. The generated prompt is returned to the UI and displayed with a copy button

### SAP AI Core integration

Authentication is OAuth2 client credentials. The token is cached in memory until 30 seconds before expiry. The chat completions endpoint follows the OpenAI-compatible format that SAP AI Core exposes:

```
POST {AICORE_BASE_URL}/inference/deployments/{LLM_DEPLOYMENT_ID}/invoke
Headers: Authorization: Bearer <token>, AI-Resource-Group: <group>
Body: {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 4096, "system": "...", "messages": [...]}
```

## Environment variables

| Variable | Purpose |
|---|---|
| `AICORE_CLIENT_ID` | OAuth2 client ID |
| `AICORE_CLIENT_SECRET` | OAuth2 client secret |
| `AICORE_AUTH_URL` | Token endpoint base (appends `/oauth/token`) |
| `AICORE_BASE_URL` | AI Core API base URL (includes `/v2`) |
| `AICORE_RESOURCE_GROUP` | Resource group (default: `default`) |
| `LLM_DEPLOYMENT_ID` | Deployment ID for the Claude model |

## Adding file types

Add a new branch in `app/services/extractor.py` — match on the file suffix and return `{"kind": "text", ...}` or `{"kind": "image", ...}`. No other files need to change.
