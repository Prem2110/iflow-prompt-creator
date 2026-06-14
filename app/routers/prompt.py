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

_ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls", ".csv", ".txt", ".json", ".yaml", ".yml", ".xml", ".wsdl", ".png", ".jpg", ".jpeg", ".webp", ".gif"}

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

Exception Subprocess (CONDITIONAL):
- ONLY include this section if the source documents explicitly describe error handling,
  exception flows, failure notifications, retry logic, dead-letter handling, or fault responses.
- If no such content exists in the documents, omit this section entirely — do NOT invent it.
- If it is present, append it after the "Important:" section using this structure:

Exception Subprocess:

<Topology paragraph for the subprocess — plain English, every connection named with its adapter>

Component Configuration:

1. <Component Name> — <Type/Adapter>
<config fields only>

...

Important (Exception Subprocess):
- <hard constraint specific to the exception handling>
(max 3 bullets)

Rules:
- Opening line with iFlow name and package is REQUIRED.
- Topology paragraph is REQUIRED.
- "Component Configuration:" section with at least one numbered entry is REQUIRED.
- "Important:" section is REQUIRED (max 5 bullets).
- "Exception Subprocess:" section is OPTIONAL — include ONLY when the documents describe error/exception handling.
"""

_RETRY_SYSTEM = """You are an expert SAP CPI architect fixing an incomplete iFlow prompt.

The previous attempt was missing required sections. Produce a corrected, complete prompt.
Output ONLY the prompt text — no preamble, no explanation, no markdown code fences.

The prompt MUST contain ALL of these sections:
1. An opening line matching: Create a new iFlow called "<name>" in the package "<package>".
2. A topology paragraph describing every connection and adapter in plain English.
3. A "Component Configuration:" section with numbered entries (at least one starting with "1.").
4. An "Important:" section with AT MOST 5 iFlow-specific constraint bullets.

If the original source documents described error handling, exception flows, or fault responses,
also include an "Exception Subprocess:" section after "Important:" — otherwise omit it.

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
        extracted = [item for f, data in file_data_list for item in await extract(f, data)]
        n_text = sum(1 for e in extracted if e["kind"] == "text")
        n_img = sum(1 for e in extracted if e["kind"] == "image")
        logger.info("Extracted %d text and %d image item(s)", n_text, n_img)
        msg = f"Extracted {n_text} text" + (f" and {n_img} image page(s)" if n_img else "") + " from uploaded file(s)"
        yield _event("step_done", key="extract", message=msg)
    except Exception as exc:
        logger.error("File extraction failed: %s", exc, exc_info=True)
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)

    # Step 2 — generate (streaming)
    yield _event("step", key="generate", message="Claude is generating the iFlow prompt…")
    try:
        gen = await _chat_complete(_SYSTEM, user_content, stream=True, max_tokens=8192, max_continuations=6)
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
        gen = await _chat_complete(_RETRY_SYSTEM, retry_content, stream=True, max_tokens=8192, max_continuations=6)
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
Produce a thorough step-by-step guide covering three areas:
  1. How to build the iFlow manually inside the SAP CPI web UI (exact clicks, field names).
  2. Any scripts required by the iFlow (Groovy, XSLT, XPath expressions, etc.).
  3. How to test the running iFlow using Postman AND cURL.

Output ONLY the guide text — no preamble, no explanation, no markdown code fences.

FORMATTING RULES:
- Use ## for top-level sections and ### for sub-sections.
- Number every action within a step (1. 2. 3. …).
- Reference exact SAP CPI UI element names as they appear on screen
  (e.g. "Integration Flow", "Sender", "Content Modifier", tab labels, field names).
- Never skip a click. Every navigation path must be complete.
- SCRIPTS RULE: Wherever the iFlow requires a Script step, XSLT mapping, Groovy expression,
  or XPath/JSONPath value — provide the COMPLETE, RUNNABLE code inline in the relevant step.
  Do not say "write a script here" — write the actual script.
  Examples: full Groovy .gsh body for Script steps, complete XSLT template for XSLT mappings,
  exact XPath/JSONPath strings for Content Modifier expressions, complete JSONata expressions.
- POSTMAN RULE: Include method, full URL, auth, all headers, a realistic sample body,
  expected response, and at least 2 test cases. Also include the cURL equivalent for every
  Postman request so developers can test from the terminal too.
- CSRF RULE: If the iFlow involves S/4HANA OData or any CSRF-protected endpoint, include a
  dedicated CSRF token pre-fetch step with its own Postman request AND cURL command.

Required output structure (use these exact section headings):

## [iFlow Name] — Step-by-Step Build Guide
Package: [package-name]

## Prerequisites
- [SAP CPI tenant access with Developer role or equivalent]
- [Any system/credential/certificate requirements derived from the scenario]

## Step 1: [Action]
1. [Exact UI action]
2. [Exact UI action]
...

## Step N: [Action]
...

(one ## Step N per major component — Sender channel, each middleware step, Script steps with
full code, XSLT steps with full template, Receiver channel, error handling, etc.)

## Scripts Reference

### [Script/Mapping Name] — [Type: Groovy / XSLT / JSONata / XPath]
[Complete runnable code]

### [Next script if applicable]
[Complete runnable code]

## Testing with Postman

### Step 1: Fetch CSRF Token (if applicable)
#### Postman
- Method: GET
- URL: ...
- Headers: X-CSRF-Token: Fetch, ...

#### cURL
```
curl -X GET "..." -H "X-CSRF-Token: Fetch" -u "user:password" -v
```

### Step 2: [Main Request Name]
#### Postman
- Method: [POST/GET/…]
- URL: https://<your-tenant-host>/http/<path>
- Authentication: [type]
- Headers: [list]
- Body: [realistic JSON/XML sample]

#### cURL
```
curl -X POST "..." -H "Content-Type: application/json" -d '{"field":"value"}' -u "user:password"
```

### Expected Response
- Status: [code]
- Body: [structure or sample]

### Test Case 1 — Happy Path
1. [action]
2. [verify]

### Test Case 2 — [Error/Edge Case]
1. [action]
2. [verify]

Rules:
- ALL section headings listed above are REQUIRED.
- The "## Scripts Reference" section is REQUIRED — if no scripts exist, state "No standalone
  scripts required for this iFlow" under the heading.
- Every Script or XSLT step in the iFlow MUST include the complete working code.
- Both Postman AND cURL examples are REQUIRED in the testing section.
- Derive iFlow name, package, endpoints, and field names from the uploaded content.
  Use clearly labelled placeholders (e.g. <your-tenant-host>) for values that cannot be determined.
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
        extracted = [item for f, data in file_data_list for item in await extract(f, data)]
        n_text = sum(1 for e in extracted if e["kind"] == "text")
        n_img = sum(1 for e in extracted if e["kind"] == "image")
        logger.info("Instructions — extracted %d text and %d image item(s)", n_text, n_img)
        msg = f"Extracted {n_text} text" + (f" and {n_img} image page(s)" if n_img else "") + " from uploaded file(s)"
        yield _event("step_done", key="extract", message=msg)
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
        gen = await _chat_complete(_INSTRUCTIONS_SYSTEM, user_content, stream=True, max_tokens=8192, max_continuations=6)
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


# ── Summary endpoint ──────────────────────────────────────────────────────────

_SUMMARY_SYSTEM = """You are an expert SAP CPI (Cloud Platform Integration) architect.

The user will provide technical documentation, business requirements, screenshots, or notes
describing an integration scenario. Produce a concise, scannable summary that gives a developer
or stakeholder an instant understanding of what this iFlow does and how it is built.

Output ONLY the summary — no preamble, no explanation, no markdown code fences.

FORMATTING RULES:
- Use ## for top-level sections and ### for sub-sections.
- Keep the entire summary under 500 words.
- Be specific: name adapters, endpoints, and data objects. Avoid vague phrases like "processes data".

Required output structure (use these exact headings):

## [iFlow Name]
**Package:** [package-name]
**Purpose:** [One sentence: what business problem this integration solves.]

## What It Does
[2–3 sentences in plain English describing the end-to-end data flow — what comes in, what
transformations happen, and where the data ends up.]

## Integration Topology
[List every connection as a bullet: Sender → Step → … → Receiver, naming the adapter on each channel.]
- Sender → [adapter] → [Step]
- [Step] → [adapter/type] → [Step]
- …

## Adapters & Protocols
| Component | Adapter / Type | Notes |
|---|---|---|
| [name] | [adapter] | [brief note] |
…

## Key Configuration
- [Most important config detail — URL, auth method, namespace, XPath, etc.]
- [Next detail]
(up to 5 bullets — only hard facts, no general advice)

## Gotchas
- [Any non-obvious constraint, CSRF requirement, cert needed, transformation quirk, etc.]
(omit this section entirely if there are no notable gotchas)

Rules:
- All sections above except "## Gotchas" are REQUIRED.
- Derive iFlow name and package from context; invent appropriate names if not stated.
- Use placeholders like <your-tenant-host> for values that cannot be determined.
"""

_SUMMARY_SUFFIX = "\n\nGenerate the concise iFlow summary from the content above."


async def _stream_summary(files: List[UploadFile]) -> AsyncGenerator[str, None]:
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
        extracted = [item for f, data in file_data_list for item in await extract(f, data)]
        n_text = sum(1 for e in extracted if e["kind"] == "text")
        n_img = sum(1 for e in extracted if e["kind"] == "image")
        logger.info("Summary — extracted %d text and %d image item(s)", n_text, n_img)
        msg = f"Extracted {n_text} text" + (f" and {n_img} image page(s)" if n_img else "") + " from uploaded file(s)"
        yield _event("step_done", key="extract", message=msg)
    except Exception as exc:
        logger.error("Summary extraction failed: %s", exc, exc_info=True)
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)
    if isinstance(user_content, str):
        user_content = user_content.replace(SUFFIX.strip(), _SUMMARY_SUFFIX.strip())
    else:
        for part in reversed(user_content):
            if part.get("type") == "text" and SUFFIX.strip() in part["text"]:
                part["text"] = part["text"].replace(SUFFIX.strip(), _SUMMARY_SUFFIX.strip())
                break

    yield _event("step", key="generate", message="Claude is summarising the iFlow…")
    try:
        gen = await _chat_complete(_SUMMARY_SYSTEM, user_content, stream=True, max_tokens=2048)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        logger.info("Summary complete: %d chars", len(result))
        yield _event("step_done", key="generate", message="Summary ready")
    except Exception as exc:
        logger.error("Summary LLM call failed: %s", exc, exc_info=True)
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    yield _event("done", prompt=result)


@router.post("/summarize")
async def summarize(files: List[UploadFile] = File(...)):
    logger.info("Summary request — %d file(s): %s", len(files), [f.filename for f in files])
    return StreamingResponse(
        _stream_summary(files),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
