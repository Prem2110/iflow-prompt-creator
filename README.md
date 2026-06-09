# IFS Prompt Generator

Uploads documents (PDF, DOCX, TXT) or screenshots and generates a ready-to-use **SAP CPI iFlow configuration prompt** using Claude on SAP AI Core. The prompt is designed to be pasted into a separate SAP CPI iFlow builder.

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
# Fill in your SAP AI Core credentials
```

### 2. Backend

```bash
# Install dependencies (use the venv's python)
.venv\Scripts\python.exe -m pip install -e .

# Start the API server
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

API available at `http://localhost:8000`  
Swagger UI at `http://localhost:8000/docs`

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

UI available at `http://localhost:5173`

## How it works

1. User uploads one or more files (PDF / DOCX / TXT / PNG / JPG)
2. Backend extracts text (or encodes images as base64)
3. All content is sent to Claude on SAP AI Core as a single prompt
4. Claude returns a structured SAP CPI iFlow configuration prompt
5. User copies the prompt and pastes it into the iFlow builder

## API

### `POST /api/generate-prompt`

Accepts `multipart/form-data` with one or more `files`.

**Response**
```json
{ "prompt": "Create an SAP CPI iFlow with the following configuration..." }
```

## Supported file types

| Type | Extension |
|---|---|
| PDF | `.pdf` |
| Word | `.docx`, `.doc` |
| Plain text | `.txt` |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp` |

## Environment variables

| Variable | Description |
|---|---|
| `AICORE_CLIENT_ID` | OAuth2 client ID from SAP AI Core service key |
| `AICORE_CLIENT_SECRET` | OAuth2 client secret |
| `AICORE_AUTH_URL` | Token endpoint base URL |
| `AICORE_BASE_URL` | AI Core API base URL (includes `/v2`) |
| `AICORE_RESOURCE_GROUP` | Resource group (default: `default`) |
| `LLM_DEPLOYMENT_ID` | Claude deployment ID in SAP AI Core |
