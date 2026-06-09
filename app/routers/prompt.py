import json
import logging
from typing import AsyncGenerator, List

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import StreamingResponse

from app.services.aicore import chat_complete
from app.services.extractor import extract
from app.services.validator import validate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

_SYSTEM = """You are an expert SAP CPI (Cloud Platform Integration) architect.

The user will provide technical documentation, business requirements, screenshots, or notes
describing an integration scenario. Produce a concise, ready-to-use SAP CPI iFlow configuration
prompt that a developer will follow step-by-step to build the iFlow in SAP CPI.

Output ONLY the prompt text - no preamble, no explanation, no markdown code fences.

STRICT FORMATTING RULES:
- Every section below is mandatory.
- Each numbered step lists ONLY the configuration fields a developer sets in SAP CPI (adapter type, method, URL, headers, XPath, etc.). No background explanations, no general SAP advice.
- The Important section must contain AT MOST 5 bullet points covering ONLY hard technical constraints specific to this iFlow (e.g. CSRF handling, XPath expressions, adapter choice). Do NOT include general development advice, deployment instructions, timeout recommendations, or credential management guidance.
- Do NOT include full request/response JSON bodies in the steps — reference field names only when needed for mapping.
- Keep each step description tight. If a field value is obvious from context (e.g. Content-Type: application/json), list it once and move on.

Output structure:

Create an SAP CPI iFlow with the following configuration exactly as per given flow.

Package ID: <value>

iFlow ID: <value>

Integration Flow Structure:

<Step> -> <Step> -> ... -> End

1. <Step Name>

<concise configuration — adapter, method, URL, headers, XPath, etc.>

2. <Step Name>

<concise configuration>

...

Important:
- <hard constraint 1>
- <hard constraint 2>
(max 5 bullets, iFlow-specific only)

Rules:
- Package ID and iFlow ID are REQUIRED — derive from context if not stated explicitly.
- Integration Flow Structure (the step sequence line) is REQUIRED.
- At least one numbered step is REQUIRED.
- The Important section is REQUIRED (max 5 bullets).
"""

_RETRY_SYSTEM = """You are an expert SAP CPI architect fixing an incomplete iFlow prompt.

The previous attempt was missing required sections. Produce a corrected, complete prompt.
Output ONLY the prompt text - no preamble, no explanation, no markdown code fences.

Keep the output concise — each step lists only the configuration fields a developer sets in SAP CPI.
The Important section must have AT MOST 5 bullets covering only hard iFlow-specific constraints.
Do NOT include full JSON bodies, general SAP advice, or deployment guidance.

The prompt MUST contain all of these sections:
1. "Package ID:" line
2. "iFlow ID:" line
3. "Integration Flow Structure:" section with a step sequence
4. Numbered steps starting from "1."
5. "Important:" section (max 5 bullets)

If a value cannot be determined from the source, use a clearly labelled placeholder.
"""

SUFFIX = "\n\nGenerate the SAP CPI iFlow configuration prompt from the content above."


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


def _retry_content(original_output: str, missing: list[str], source_content) -> str:
    source_text = (
        source_content
        if isinstance(source_content, str)
        else next((p["text"] for p in source_content if p.get("type") == "text"), "")
    )
    return (
        f"The previous attempt was missing these required sections: {', '.join(missing)}\n\n"
        f"Previous (incomplete) output:\n{original_output}\n\n"
        f"Original source document:\n{source_text}\n\n"
        "Fix and return the complete prompt with ALL required sections."
    )


async def _stream(files: List[UploadFile]) -> AsyncGenerator[str, None]:
    # Step 1 — extract files
    yield _event("step", key="extract", message=f"Extracting content from {len(files)} file(s)…")
    try:
        extracted = [await extract(f) for f in files]
        kinds = [e["kind"] for e in extracted]
        yield _event("step_done", key="extract",
                     message=f"Extracted {kinds.count('text')} text and {kinds.count('image')} image file(s)")
    except Exception as exc:
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)

    # Step 2 — generate
    yield _event("step", key="generate", message="Claude is generating the iFlow prompt…")
    try:
        result = await chat_complete(_SYSTEM, user_content)
        yield _event("step_done", key="generate", message="Response received from Claude")
    except Exception as exc:
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    # Step 4 — validate
    yield _event("step", key="validate", message="Validating prompt structure…")
    validation = validate(result)

    if validation.is_valid:
        yield _event("step_done", key="validate", message="All required sections present")
        yield _event("done", prompt=result, valid=True, warning=None)
        return

    # Step 5 — retry
    yield _event("step_done", key="validate",
                 message=f"Incomplete — missing: {', '.join(validation.missing)}")
    yield _event("step", key="retry",
                 message=f"Retrying with stricter prompt (missing: {', '.join(validation.missing)})…")
    try:
        retry_content = _retry_content(result, validation.missing, user_content)
        result = await chat_complete(_RETRY_SYSTEM, retry_content)
        validation = validate(result)
        if validation.is_valid:
            yield _event("step_done", key="retry", message="Retry successful — all sections present")
        else:
            yield _event("step_done", key="retry",
                         message=f"Still missing after retry: {', '.join(validation.missing)}")
    except Exception as exc:
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
