import json
import logging
from pathlib import Path
from typing import AsyncGenerator, List

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import StreamingResponse

from app.services.aicore import chat_complete as _chat_complete
from app.services.extractor import extract
from app.services.validator import validate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

# Maximum file size: 20 MB
_MAX_FILE_SIZE = 20 * 1024 * 1024

_ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif"}

_SYSTEM = """You are an expert SAP CPI (Cloud Platform Integration) architect.

The user will provide technical documentation, business requirements, screenshots, or notes
describing an integration scenario. Produce a concise, ready-to-use SAP CPI iFlow building prompt
that a developer will follow to build the iFlow in SAP CPI.

Output ONLY the prompt text — no preamble, no explanation, no markdown code fences.

STRICT FORMATTING RULES:
- The opening line MUST use this exact pattern:
    Create a new iFlow called "<iflow-name>" in the package "<package-name>".
  Derive both names from context; if not stated, invent appropriate technical names.
- After the opening line, write a topology paragraph in plain English describing every connection
  and the adapter used on each channel. Name every component. Example style:
    "Sender is connected to Start via HTTPS Sender Adapter. Start is connected to Content Modifier
     called "Normalize Payload". "Normalize Payload" is connected to Request Reply called
     "Call Backend" via OData V2 Receiver Adapter. "Call Backend" is connected to End.
     End is connected to Receiver "ERP System" via Mail Adapter."
- After the topology paragraph, write a "Component Configuration:" section with one numbered
  entry per component/channel. Each entry heading: "<Name> — <Type/Adapter>". Body: ONLY the
  configuration fields a developer sets in SAP CPI (URL, method, headers, XPath, namespace, etc.).
  No prose explanations, no general SAP advice, no full JSON bodies.
- End with an "Important:" section of AT MOST 5 bullets covering ONLY hard technical constraints
  specific to this iFlow (e.g. CSRF token handling, specific XPath expressions, auth method).
  Do NOT include general development advice or deployment guidance.

Output structure:

Create a new iFlow called "<iflow-name>" in the package "<package-name>".

<Topology paragraph — plain English, every connection named with its adapter>

Component Configuration:

1. <Component Name> — <Type/Adapter>
<config fields only>

2. <Component Name> — <Type/Adapter>
<config fields only>

...

Important:
- <hard iFlow-specific constraint>
(max 5 bullets)

Rules:
- Opening line with iFlow name and package is REQUIRED.
- Topology paragraph is REQUIRED.
- "Component Configuration:" section with at least one numbered entry is REQUIRED.
- "Important:" section is REQUIRED (max 5 bullets).
"""

_RETRY_SYSTEM = """You are an expert SAP CPI architect fixing an incomplete iFlow prompt.

The previous attempt was missing required sections. Produce a corrected, complete prompt.
Output ONLY the prompt text — no preamble, no explanation, no markdown code fences.

The prompt MUST contain ALL of these sections:
1. An opening line matching: Create a new iFlow called "<name>" in the package "<package>".
2. A topology paragraph describing every connection and adapter in plain English.
3. A "Component Configuration:" section with numbered entries (at least one starting with "1.").
4. An "Important:" section with AT MOST 5 iFlow-specific constraint bullets.

Keep component config entries concise — only the fields a developer sets in SAP CPI.
Do NOT include full JSON bodies, general SAP advice, or deployment guidance.
If a value cannot be determined from the source, use a clearly labelled placeholder.
"""

SUFFIX = "\n\nGenerate the SAP CPI iFlow building prompt from the content above."


def _event(status: str, **kwargs) -> str:
    return f"data: {json.dumps({'status': status, **kwargs})}\n\n"


def _build_user_content(extracted: list[dict]):
    has_images = any(item["kind"] == "image" for item in extracted)

    if not has_images:
        text_blocks = [
            f"=== {item['name']} ===\n{item['content']}"
            for item in extracted
            if item["kind"] == "text"
        ]
        return "\n\n".join(text_blocks) + SUFFIX

    parts: list = []
    text_blocks: list[str] = []

    for item in extracted:
        if item["kind"] == "text":
            text_blocks.append(f"=== {item['name']} ===\n{item['content']}")
        elif item["kind"] == "image":
            if text_blocks:
                parts.append({"type": "text", "text": "\n\n".join(text_blocks)})
                text_blocks = []
            parts.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": item["mime"],
                    "data": item["b64"],
                },
            })

    if text_blocks:
        parts.append({"type": "text", "text": "\n\n".join(text_blocks)})

    parts.append({"type": "text", "text": SUFFIX.strip()})
    return parts


def _retry_content(original_output: str, missing: list[str], source_content) -> str | list:
    # For plain text content, return a simple text string
    if isinstance(source_content, str):
        return (
            f"The previous attempt was missing these required sections: {', '.join(missing)}\n\n"
            f"Previous (incomplete) output:\n{original_output}\n\n"
            f"Original source document:\n{source_content}\n\n"
            "Fix and return the complete prompt with ALL required sections."
        )

    # For mixed content (text + images), preserve all parts including images
    parts: list = []
    parts.append({
        "type": "text",
        "text": f"The previous attempt was missing these required sections: {', '.join(missing)}\n\n"
                f"Previous (incomplete) output:\n{original_output}\n\n"
                "Here is the original source content again. Fix and return the complete prompt with ALL required sections."
    })
    # Append the original source content parts (preserving images)
    parts.extend(source_content)
    return parts


async def _stream(files: List[UploadFile]) -> AsyncGenerator[str, None]:
    # --- Validate files before processing ---
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS:
            yield _event("error", message=f"Unsupported file type '{ext}' for '{f.filename}'")
            return

    # Read file data and check sizes
    file_data_list: list[tuple[UploadFile, bytes]] = []
    for f in files:
        data = await f.read()
        if len(data) > _MAX_FILE_SIZE:
            yield _event("error",
                         message=f"File '{f.filename}' exceeds {_MAX_FILE_SIZE // (1024*1024)} MB limit")
            return
        file_data_list.append((f, data))

    # Step 1 — extract files
    yield _event("step", key="extract", message=f"Extracting content from {len(files)} file(s)…")
    try:
        extracted = [await extract(f, data) for f, data in file_data_list]
        kinds = [e["kind"] for e in extracted]
        logger.info("Extracted %d text and %d image file(s)", kinds.count("text"), kinds.count("image"))
        yield _event("step_done", key="extract",
                     message=f"Extracted {kinds.count('text')} text and {kinds.count('image')} image file(s)")
    except Exception as exc:
        logger.error("File extraction failed: %s", exc, exc_info=True)
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)

    # Step 2 — generate (streaming)
    yield _event("step", key="generate", message="Claude is generating the iFlow prompt…")
    try:
        gen = await _chat_complete(_SYSTEM, user_content, stream=True)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        logger.info("Generation complete: %d chars", len(result))
        yield _event("step_done", key="generate", message="Response received from Claude")
    except Exception as exc:
        logger.error("LLM generation failed: %s", exc, exc_info=True)
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    # Step 3 — validate
    yield _event("step", key="validate", message="Validating prompt structure…")
    validation = validate(result)

    if validation.is_valid:
        logger.info("Validation passed")
        yield _event("step_done", key="validate", message="All required sections present")
        yield _event("done", prompt=result, valid=True, warning=None)
        return

    # Step 4 — retry (if validation failed, streaming)
    logger.warning("Validation failed — missing: %s. Triggering retry.", validation.missing)
    yield _event("step_done", key="validate",
                 message=f"Incomplete — missing: {', '.join(validation.missing)}")
    yield _event("step", key="retry",
                 message=f"Retrying with stricter prompt (missing: {', '.join(validation.missing)})…")
    try:
        retry_content = _retry_content(result, validation.missing, user_content)
        gen = await _chat_complete(_RETRY_SYSTEM, retry_content, stream=True)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        validation = validate(result)
        if validation.is_valid:
            logger.info("Retry successful")
            yield _event("step_done", key="retry", message="Retry successful — all sections present")
        else:
            logger.warning("Retry still missing: %s", validation.missing)
            yield _event("step_done", key="retry",
                         message=f"Still missing after retry: {', '.join(validation.missing)}")
    except Exception as exc:
        logger.error("Retry LLM call failed: %s", exc, exc_info=True)
        yield _event("step_done", key="retry", message=f"Retry failed: {exc}")

    yield _event("done", prompt=result, valid=validation.is_valid, warning=validation.warning)


@router.post("/generate-prompt")
async def generate_prompt(files: List[UploadFile] = File(...)):
    logger.info("Received %d file(s): %s", len(files), [f.filename for f in files])
    return StreamingResponse(
        _stream(files),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Instructions endpoint ─────────────────────────────────────────────────────

_INSTRUCTIONS_SYSTEM = """You are a senior SAP CPI (Cloud Platform Integration) developer writing
a complete, human-readable manual for a developer who will build and test an iFlow by hand.

The user will provide technical documentation, business requirements, screenshots, or notes.
Produce a step-by-step guide covering two areas:
  1. How to build the iFlow manually inside the SAP CPI web UI.
  2. How to test the running iFlow using Postman.

Output ONLY the guide text — no preamble, no explanation, no markdown code fences.

FORMATTING RULES:
- Use ## for top-level sections and ### for sub-sections.
- Number every action within a step (1. 2. 3. …).
- Reference exact SAP CPI UI element names as they appear on screen
  (e.g. "Integration Flow", "Sender", "Content Modifier", tab labels, field names).
- Never skip a click. Every navigation path must be complete.
- For the Postman section: include method, full URL pattern, authentication type,
  all required headers, a realistic sample request body (JSON or XML as appropriate),
  expected response status and shape, and at least two test cases.

Required output structure (use these exact section headings):

## [iFlow Name] — Step-by-Step Build Guide
Package: [package-name]

## Prerequisites
- [SAP CPI tenant access with Developer role or equivalent]
- [Any specific system/credential requirements derived from the scenario]

## Step 1: [Action — e.g. "Create the Integration Package or Open Existing"]
1. [Exact UI action]
2. [Exact UI action]
...

## Step 2: [Next major action]
1. ...
...

(one ## Step N section per major component or configuration area — Sender, each middleware
component, Receiver, message mappings, error handling, etc.)

## Testing with Postman

### Endpoint Details
- Method: [GET / POST / …]
- URL: https://<your-tenant-host>/http/<path>
- Authentication: [Basic Auth / OAuth2 Client Credentials / …]

### Request Headers
- [Header-Name]: [value or description]

### Sample Request Body
[Realistic JSON or XML sample — derive field names from the scenario]

### Expected Response
- Status: [HTTP code]
- Body: [structure or sample]

### Test Case 1 — Happy Path
1. [Send request with …]
2. [Verify status …]
3. [Verify response body contains …]

### Test Case 2 — [Error / Edge Case Name]
1. [Send request with …]
2. [Verify …]

Rules:
- ALL section headings listed above are REQUIRED.
- Step sections must reference exact SAP CPI UI element names.
- The Postman section must include method, URL, auth, headers, sample body, expected response,
  and at least two test cases.
- Derive iFlow name, package, endpoints, and field names from the uploaded content.
  If something cannot be determined, use a clearly labelled placeholder like <your-endpoint>.
"""

_INSTRUCTIONS_SUFFIX = "\n\nGenerate the complete SAP CPI manual build guide and Postman testing instructions from the content above."


async def _stream_instructions(files: List[UploadFile]) -> AsyncGenerator[str, None]:
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS:
            yield _event("error", message=f"Unsupported file type '{ext}' for '{f.filename}'")
            return

    file_data_list: list[tuple[UploadFile, bytes]] = []
    for f in files:
        data = await f.read()
        if len(data) > _MAX_FILE_SIZE:
            yield _event("error",
                         message=f"File '{f.filename}' exceeds {_MAX_FILE_SIZE // (1024*1024)} MB limit")
            return
        file_data_list.append((f, data))

    yield _event("step", key="extract", message=f"Extracting content from {len(files)} file(s)…")
    try:
        extracted = [await extract(f, data) for f, data in file_data_list]
        kinds = [e["kind"] for e in extracted]
        logger.info("Instructions — extracted %d text and %d image file(s)",
                    kinds.count("text"), kinds.count("image"))
        yield _event("step_done", key="extract",
                     message=f"Extracted {kinds.count('text')} text and {kinds.count('image')} image file(s)")
    except Exception as exc:
        logger.error("Instructions extraction failed: %s", exc, exc_info=True)
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    # Build user content with instructions suffix
    extracted_with_suffix = [dict(e) for e in extracted]
    user_content = _build_user_content(extracted_with_suffix)
    if isinstance(user_content, str):
        user_content = user_content.replace(SUFFIX.strip(), _INSTRUCTIONS_SUFFIX.strip())
    else:
        for part in reversed(user_content):
            if part.get("type") == "text" and SUFFIX.strip() in part["text"]:
                part["text"] = part["text"].replace(SUFFIX.strip(), _INSTRUCTIONS_SUFFIX.strip())
                break

    yield _event("step", key="generate", message="Claude is writing the step-by-step instructions…")
    try:
        gen = await _chat_complete(_INSTRUCTIONS_SYSTEM, user_content, stream=True, max_tokens=8192)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        logger.info("Instructions complete: %d chars", len(result))
        yield _event("step_done", key="generate", message="Instructions ready")
    except Exception as exc:
        logger.error("Instructions LLM call failed: %s", exc, exc_info=True)
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    yield _event("done", prompt=result)


@router.post("/generate-instructions")
async def generate_instructions(files: List[UploadFile] = File(...)):
    logger.info("Instructions request — %d file(s): %s", len(files), [f.filename for f in files])
    return StreamingResponse(
        _stream_instructions(files),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
