import json
import logging
import os
from pathlib import Path
from typing import AsyncGenerator, List

from fastapi import APIRouter, File, Form as FastAPIForm, UploadFile
from fastapi.responses import StreamingResponse

from app.services.aicore import chat_complete as _chat_complete
from app.services.extractor import extract
from app.services.hubsearch import enrich_from_hub
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
- CONTENT MODIFIER RULE: For Content Modifier entries list ONLY the SAP CPI fields a developer
  fills in: "Message Body" (the expression or XPath only — not an explanation of what it does),
  "Exchange Properties" (name = simple-expression pairs), "Headers" (name = value pairs).
  Never explain what the payload is for or describe business logic — just the field values.
  Never set an Exchange Property to the value it already holds (e.g. PRNumber = ${property.PRNumber}
  is a no-op; omit it if a previous step already wrote that property).
- DEDUPLICATION RULE: If the Exception Subprocess uses an adapter whose connection fields
  (Proxy Type, Authentication, Credential Name, Timeout, Content-Type) are the same as a
  main-flow adapter, do NOT repeat those shared fields. Instead write ONLY the fields that
  differ (Address, Method, Body) followed by one line:
  "(Proxy Type / Authentication / Timeout / Content-Type — same as <Main Flow Step Name> above.)"
  Apply this even when the Address or Method differs — shared connection fields must never
  be copy-pasted.
- IMPORTANT DEDUP RULE: The "Important (Exception Subprocess):" section must contain ONLY
  constraints that are specific to the exception handling path and are NOT already stated in the
  main "Important:" section. Never repeat a bullet that was already made above.
- ODATA RULE: For every OData V2 or OData V4 Receiver Adapter entry you MUST include ALL of
  these fields (use a clearly-labelled placeholder if the value is not in the source documents):
    Address: <full service-root URL, e.g. https://<host>/sap/opu/odata/sap/<SERVICE_NAME>>
    Resource Path: <entity-set path, e.g. /A_EnterpriseProject or /ProjectCollection>
    Operation: <Create | Read | Update | Delete | Query | Merge | Patch>
    Query Options: <$filter / $select / $expand — omit only if truly not applicable>
  Never list just the service name without the entity set and operation type.
- PLACEHOLDER RULE: When a value (URL, entity name, auth credential, etc.) cannot be determined
  from the source documents, use a clearly labelled placeholder in angle brackets, e.g.
  <your-host>, <service-root-url>, <entity-set-name>. Never silently omit a required field.
- HTTPS SENDER RULE: For every HTTPS Sender Adapter entry include:
    Address: <relative path, e.g. /http/receive-po>
    Authorization: <User Role | Client Certificate>
    User Role: <ESBMessaging.send or custom role>
    CSRF Protected: <true | false>
    Message Exchange Pattern: <Request-Reply | One-Way>
- HTTP RECEIVER RULE: For every HTTP Receiver Adapter entry include (note: in SAP CPI the
  receiver-side adapter is called "HTTP Receiver Adapter", not "HTTPS Receiver Adapter"):
    Address: <full URL including path>
    Proxy Type: <Internet | On-Premise>
    Method: <GET | POST | PUT | PATCH | DELETE>
    Authentication: <None | Basic | OAuth2 Client Credentials | Client Certificate | Principal Propagation>
    Timeout: <value in ms, e.g. 60000>
    Content-Type: <application/json | application/xml | etc.>
- SOAP RULE: For every SOAP Sender or Receiver Adapter entry include:
    Address: <endpoint URL or relative path>
    WSDL URL: <URL or local path — use <wsdl-url> placeholder if unknown>
    Service: <service name from WSDL>
    Port: <port name from WSDL>
    Operation Name: <operation name>
    Authentication: <None | Basic | WS-Security | Client Certificate>
- SFTP RULE: For every SFTP Sender or Receiver Adapter entry include:
    Host: <sftp-host>
    Port: <22 or custom>
    Directory: </path/to/directory>
    File Name: <static name or pattern, e.g. *.xml>
    Authentication: <User Name/Password | Public Key>
    Post Processing (Sender only): <Delete File | Keep File and Mark | Archive>
    Duplicate Handling (Sender only): <Skip Duplicates | Overwrite>
- MAIL RULE: For every Mail Receiver Adapter entry include:
    Host: <smtp-host>
    Port: <25 | 465 | 587>
    Encryption: <STARTTLS | SSL | Plain>
    From: <sender address or <from-address>>
    To: <recipient address or <to-address>>
    Subject: <subject line>
    Authentication: <None | Encrypted User/Password>
- IDOC RULE: For every IDoc Receiver Adapter entry include:
    Receiver: <SAP System ID / client>
    Receiver Port: <RFC destination or port name>
    IDoc Type: <basic type, e.g. ORDERS05>
    Message Type: <e.g. ORDERS>
    Communication Channel: <channel name or <idoc-channel>>
- JDBC RULE: For every JDBC Receiver Adapter entry include:
    Data Source: <JDBC data source alias configured in CPI>
    SQL Query / Stored Procedure: <full SQL statement or procedure name>
    Operation: <SELECT | INSERT | UPDATE | DELETE | Stored Procedure>
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

_DISCOVER_SYSTEM = """You are an SAP CPI integration architect analysing a process flow document.

Your task: identify every distinct integration interface (iFlow) in the document.

An integration interface is any AUTOMATIC data exchange that crosses a system boundary
(e.g. IFS Cloud to SAP S/4HANA, or SAP S/4HANA to IFS Cloud).
Manual steps, human approvals, and internal-system-only steps are NOT interfaces.

For each interface return a JSON object with these exact fields:
  "id": short snake_case identifier (e.g. "wo_to_wbs_creation")
  "name": human-readable name (e.g. "Work Order to WBS Creation")
  "direction": one of "IFS → SAP" | "SAP → IFS" | "SAP → SAP" | "IFS → IFS" | "Other"
  "source_system": name of the originating system (e.g. "IFS Cloud")
  "source_entity": IFS entity or SAP object that triggers this (e.g. "WorkOrderEntity")
  "target_system": name of the receiving system (e.g. "SAP S/4HANA")
  "target_api": the API or service used on the target (e.g. "API_ENTERPRISE_PROJECT_SRV v0002")
  "trigger": one sentence describing the business event that triggers this flow
  "description": one sentence describing what this integration does end-to-end

Return ONLY a valid JSON array. No preamble, no explanation, no markdown fences.
"""

_DISCOVER_SUFFIX = "\n\nIdentify all integration interfaces in the document above and return the JSON array."

_FLOW_FOCUS_PREFIX = """\
IMPORTANT — This document describes MULTIPLE integration interfaces.
Generate a prompt for THIS specific interface ONLY:

  Name:      {name}
  Direction: {direction}
  Source:    {source_system} / {source_entity}
  Target:    {target_system} / {target_api}
  Trigger:   {trigger}
  Details:   {description}

Ignore every other interface in the document.

"""


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


async def _stream(files: List[UploadFile], flow=None) -> AsyncGenerator[str, None]:
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

    # SAP Business Hub enrichment
    if os.environ.get("SAP_HUB_API_KEY", "").strip():
        _plain = " ".join(e.get("content", "") for e in extracted if e["kind"] == "text")
        if _plain.strip():
            yield _event("step", key="hub", message="Searching SAP Business Hub for relevant packages…")
            try:
                _hub_ref = await enrich_from_hub(_plain)
                if _hub_ref:
                    yield _event("step_done", key="hub", message="SAP Hub packages found — enriching context")
                    user_content = ([{"type": "text", "text": _hub_ref}] + list(user_content)
                                    if isinstance(user_content, list)
                                    else _hub_ref + "\n\n" + user_content)
                else:
                    yield _event("step_done", key="hub", message="No matching Hub packages for this scenario")
            except Exception as _hub_exc:
                logger.warning("Hub enrichment failed: %s", _hub_exc)
                yield _event("step_done", key="hub", message="Hub search skipped")

    if flow:
        keys = ["name", "direction", "source_system", "source_entity", "target_system", "target_api", "trigger", "description"]
        focus = _FLOW_FOCUS_PREFIX.format(**{k: flow.get(k, "") for k in keys})
        if isinstance(user_content, str):
            user_content = focus + user_content
        else:
            user_content = [{"type": "text", "text": focus}] + list(user_content)

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

Output ONLY the guide text — no preamble, no explanation. Do NOT wrap the entire output in a code fence.

FORMATTING RULES:
- Use ## for top-level sections and ### for sub-sections.
- Number every action within a step (1. 2. 3. …).
- Reference exact SAP CPI UI element names as they appear on screen
  (e.g. "Integration Flow", "Sender", "Content Modifier", tab labels, field names).
- Never skip a click. Every navigation path must be complete.
- CODE FENCE RULE: Every piece of code MUST be wrapped in a fenced code block with the correct
  language identifier. Use ```groovy for Groovy scripts, ```xml for XML/XSLT/XSD payloads,
  ```json for JSON bodies, ```jsonata for JSONata expressions, ```bash for cURL commands,
  ```xpath for XPath expressions, ```sql for SQL. Never output raw code as plain text.
  NEVER use a bare ``` fence with no language tag — always include the language identifier.
- HEADING-BEFORE-CODE RULE: A heading (####, ###, ##) must always come BEFORE its code block,
  never after it. The order must be: heading → bullet description → code block. Do not place a
  code block above the heading that labels it.
- SCRIPTS RULE: Wherever the iFlow requires a Script step, XSLT mapping, Groovy expression,
  or XPath/JSONPath value — provide the COMPLETE, RUNNABLE code inline in the relevant step
  inside a properly fenced code block. Do not say "write a script here" — write the actual script.
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
```bash
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
```bash
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


async def _stream_instructions(files: List[UploadFile], flow=None) -> AsyncGenerator[str, None]:
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

    # SAP Business Hub enrichment
    if os.environ.get("SAP_HUB_API_KEY", "").strip():
        _plain = " ".join(e.get("content", "") for e in extracted if e["kind"] == "text")
        if _plain.strip():
            yield _event("step", key="hub", message="Searching SAP Business Hub for relevant packages…")
            try:
                _hub_ref = await enrich_from_hub(_plain)
                if _hub_ref:
                    yield _event("step_done", key="hub", message="SAP Hub packages found — enriching context")
                    user_content = ([{"type": "text", "text": _hub_ref}] + list(user_content)
                                    if isinstance(user_content, list)
                                    else _hub_ref + "\n\n" + user_content)
                else:
                    yield _event("step_done", key="hub", message="No matching Hub packages for this scenario")
            except Exception as _hub_exc:
                logger.warning("Hub enrichment failed: %s", _hub_exc)
                yield _event("step_done", key="hub", message="Hub search skipped")

    # Inject flow focus when targeting a specific iFlow
    if flow:
        keys = ["name", "direction", "source_system", "source_entity", "target_system", "target_api", "trigger", "description"]
        focus = _FLOW_FOCUS_PREFIX.format(**{k: flow.get(k, "") for k in keys})
        if isinstance(user_content, str):
            user_content = focus + user_content
        else:
            user_content = [{"type": "text", "text": focus}] + list(user_content)

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


@router.post("/generate-flow-instructions")
async def generate_flow_instructions(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    logger.info("Flow instructions request — flow: %s", flow.get("name"))
    return StreamingResponse(
        _stream_instructions(files, flow=flow),
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


async def _stream_summary(files: List[UploadFile], flow=None) -> AsyncGenerator[str, None]:
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

    # SAP Business Hub enrichment
    if os.environ.get("SAP_HUB_API_KEY", "").strip():
        _plain = " ".join(e.get("content", "") for e in extracted if e["kind"] == "text")
        if _plain.strip():
            yield _event("step", key="hub", message="Searching SAP Business Hub for relevant packages…")
            try:
                _hub_ref = await enrich_from_hub(_plain)
                if _hub_ref:
                    yield _event("step_done", key="hub", message="SAP Hub packages found — enriching context")
                    user_content = ([{"type": "text", "text": _hub_ref}] + list(user_content)
                                    if isinstance(user_content, list)
                                    else _hub_ref + "\n\n" + user_content)
                else:
                    yield _event("step_done", key="hub", message="No matching Hub packages for this scenario")
            except Exception as _hub_exc:
                logger.warning("Hub enrichment failed: %s", _hub_exc)
                yield _event("step_done", key="hub", message="Hub search skipped")

    # Inject flow focus when targeting a specific iFlow
    if flow:
        keys = ["name", "direction", "source_system", "source_entity", "target_system", "target_api", "trigger", "description"]
        focus = _FLOW_FOCUS_PREFIX.format(**{k: flow.get(k, "") for k in keys})
        if isinstance(user_content, str):
            user_content = focus + user_content
        else:
            user_content = [{"type": "text", "text": focus}] + list(user_content)

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


@router.post("/generate-flow-summary")
async def generate_flow_summary(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    logger.info("Flow summary request — flow: %s", flow.get("name"))
    return StreamingResponse(
        _stream_summary(files, flow=flow),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Discover flows endpoint ───────────────────────────────────────────────────

async def _stream_discover(files: List[UploadFile]) -> AsyncGenerator[str, None]:
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS:
            yield _event("error", message=f"Unsupported file type '{ext}' for '{f.filename}'")
            return

    file_data_list: list[tuple[UploadFile, bytes]] = []
    for f in files:
        data = await f.read()
        if len(data) > _MAX_FILE_SIZE:
            yield _event("error", message=f"File '{f.filename}' exceeds {_MAX_FILE_SIZE // (1024*1024)} MB limit")
            return
        file_data_list.append((f, data))

    yield _event("step", key="extract", message=f"Extracting content from {len(files)} file(s)…")
    try:
        extracted = [item for f, data in file_data_list for item in await extract(f, data)]
        yield _event("step_done", key="extract", message=f"Extracted content from {len(files)} file(s)")
    except Exception as exc:
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)
    if isinstance(user_content, str):
        user_content = user_content.replace(SUFFIX.strip(), _DISCOVER_SUFFIX.strip())
    else:
        for part in reversed(user_content):
            if part.get("type") == "text" and SUFFIX.strip() in part["text"]:
                part["text"] = part["text"].replace(SUFFIX.strip(), _DISCOVER_SUFFIX.strip())
                break

    # SAP Business Hub enrichment
    if os.environ.get("SAP_HUB_API_KEY", "").strip():
        _plain = " ".join(e.get("content", "") for e in extracted if e["kind"] == "text")
        if _plain.strip():
            yield _event("step", key="hub", message="Searching SAP Business Hub for relevant packages…")
            try:
                _hub_ref = await enrich_from_hub(_plain)
                if _hub_ref:
                    yield _event("step_done", key="hub", message="SAP Hub packages found — enriching context")
                    user_content = ([{"type": "text", "text": _hub_ref}] + list(user_content)
                                    if isinstance(user_content, list)
                                    else _hub_ref + "\n\n" + user_content)
                else:
                    yield _event("step_done", key="hub", message="No matching Hub packages for this scenario")
            except Exception as _hub_exc:
                logger.warning("Hub enrichment failed: %s", _hub_exc)
                yield _event("step_done", key="hub", message="Hub search skipped")

    yield _event("step", key="discover", message="Analysing document for integration interfaces…")
    try:
        gen = await _chat_complete(_DISCOVER_SYSTEM, user_content, stream=True, max_tokens=8192)
        result = ""
        async for text in gen:
            result += text
        yield _event("step_done", key="discover", message="Analysis complete")
    except Exception as exc:
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    cleaned = result.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        cleaned = "\n".join(lines[1:])
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()

    try:
        flows = json.loads(cleaned)
        if not isinstance(flows, list):
            raise ValueError("Expected a JSON array")
    except Exception as exc:
        yield _event("error", message=f"Failed to parse interface list: {exc}")
        return

    yield _event("done", flows=flows)


@router.post("/discover-flows")
async def discover_flows(files: List[UploadFile] = File(...)):
    logger.info("Discover-flows request — %d file(s): %s", len(files), [f.filename for f in files])
    return StreamingResponse(
        _stream_discover(files),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Generate single flow prompt endpoint ─────────────────────────────────────


# ── Diagram endpoint ──────────────────────────────────────────────────────────

_DIAGRAM_SYSTEM = """You are an SAP CPI integration architect generating a BPMN 2.0 XML diagram.

Analyse the provided integration documentation and output a complete, valid BPMN 2.0 XML document
representing the SAP CPI iFlow as a single BPMN process. Use descriptive event names to make
Sender and Receiver systems visible in the diagram.

Output ONLY valid BPMN 2.0 XML starting with <?xml version="1.0".
No preamble, no explanation, no markdown fences.
Do NOT include any <bpmndi:*> elements — layout coordinates are computed automatically.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED SKELETON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             targetNamespace="http://sap.com/cpi/iflow"
             id="Definitions_1">

  <process id="Proc_CPI" name="SAP CPI Integration Process" isExecutable="true">

    <!-- START EVENT: name must identify the Sender system and trigger type -->
    <!-- e.g.  name="[IFS Cloud] Timer Start"  or  name="[IFS Cloud] HTTPS Trigger" -->
    <startEvent id="Start_1" name="[Source System + trigger]">
      <outgoing>F_1</outgoing>
      <!-- For a timer trigger add: <timerEventDefinition id="TimerDef_1"/> -->
    </startEvent>

    <!-- ONE element per SAP CPI processing step, in execution order -->
    <task id="Step_1" name="[Step name]">
      <incoming>F_1</incoming>
      <outgoing>F_2</outgoing>
    </task>
    <!-- ... more steps ... -->

    <!-- END EVENT: name must identify the Receiver system -->
    <!-- e.g.  name="Send to SAP S/4HANA"  or  name="POST to SAP ERP" -->
    <endEvent id="End_1" name="Send to [Target System]">
      <incoming>F_N</incoming>
    </endEvent>

    <!-- Sequence flows — one per directed connection -->
    <sequenceFlow id="F_1" sourceRef="Start_1" targetRef="Step_1"/>
    <!-- ... -->

    <!-- Exception Subprocess — ALWAYS include; SAP CPI requires it -->
    <subProcess id="Exc_Sub" name="Exception Subprocess" triggeredByEvent="true">
      <startEvent id="Exc_Start" name="Error Start">
        <errorEventDefinition id="ErrDef_1"/>
        <outgoing>EF_1</outgoing>
      </startEvent>
      <task id="Exc_Log" name="Log Error">
        <incoming>EF_1</incoming>
        <outgoing>EF_2</outgoing>
      </task>
      <task id="Exc_Alert" name="Send Alert">
        <incoming>EF_2</incoming>
        <outgoing>EF_3</outgoing>
      </task>
      <endEvent id="Exc_End" name="Error End">
        <errorEventDefinition id="ErrEndDef_1"/>
        <incoming>EF_3</incoming>
      </endEvent>
      <sequenceFlow id="EF_1" sourceRef="Exc_Start" targetRef="Exc_Log"/>
      <sequenceFlow id="EF_2" sourceRef="Exc_Log"   targetRef="Exc_Alert"/>
      <sequenceFlow id="EF_3" sourceRef="Exc_Alert"  targetRef="Exc_End"/>
    </subProcess>

    <!-- Boundary error event — attach to the main serviceTask most likely to fail -->
    <boundaryEvent id="Bound_Err" attachedToRef="Step_1" cancelActivity="true">
      <errorEventDefinition id="BoundErrDef_1"/>
      <outgoing>BF_1</outgoing>
    </boundaryEvent>
    <sequenceFlow id="BF_1" sourceRef="Bound_Err" targetRef="Exc_Sub"/>

  </process>
</definitions>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SAP CPI COMPONENT → BPMN ELEMENT MAPPING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SAP CPI Component          BPMN Element
────────────────────────────────────────────────────────────────────
Timer Start                <startEvent> + <timerEventDefinition/>
HTTPS Sender               <startEvent>           name="[Sender] HTTPS Trigger"
Generic Start              <startEvent>
Content Modifier           <task>
Filter                     <task>                 name="Filter: [condition]"
Write Variables            <task>                 name="Write Variables"
Groovy Script              <scriptTask>
JavaScript Script          <scriptTask>
Message Mapping            <task>                 name="Map: [source→target]"
XSLT Mapping               <task>                 name="XSLT: [name]"
XML/JSON Converter         <task>                 name="Convert: XML to JSON" (or reverse)
Request-Reply + OData      <serviceTask>          name="Call [System]: [operation]"
HTTP / SOAP / RFC Receiver <serviceTask>
SFTP Adapter               <serviceTask>          name="SFTP: [read/write]"
Router (XOR)               <exclusiveGateway>
Router (AND/Parallel)      <parallelGateway>
Splitter                   <task>                 name="Splitter: [type]"
Gather / Aggregator        <task>                 name="Aggregator"
Data Store op              <task>                 name="Data Store: [Write/Read]"
CSRF Token Handler         <task>                 name="CSRF Token Handler"
Process Call (LIP)         <callActivity calledElement="Proc_LIP_[name]"/>
Exception Subprocess       <subProcess triggeredByEvent="true">
Error Start Event          <startEvent> + <errorEventDefinition/>
Error End Event            <endEvent>   + <errorEventDefinition/>
Error Boundary Event       <boundaryEvent attachedToRef="[id]"> + <errorEventDefinition/>
End                        <endEvent>             name="Send to [Target System]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Use a SINGLE <process> — do NOT add <collaboration> or multiple <process> elements.
2. The startEvent name MUST include the source system in square brackets, e.g. "[IFS Cloud] Timer Start".
3. The final endEvent name MUST identify the target system, e.g. "Send to SAP S/4HANA".
4. ALL element ids must be unique. Use descriptive snake_case (Task_SetHeaders, GW_Check, Srv_CallSAP).
5. Every task/gateway/subprocess needs ≥1 <incoming> AND ≥1 <outgoing> — EXCEPT:
   - <startEvent>: only <outgoing>   |  <endEvent>: only <incoming>   |  <boundaryEvent>: only <outgoing>
6. Every <sequenceFlow> must reference element ids that exist in the same <process>.
7. The exception subprocess MUST connect to the main flow via a <boundaryEvent> on a task.
8. For Router (exclusiveGateway): emit one <sequenceFlow> per branch, each with a name attribute.
   All branches must eventually reach an <endEvent>.
9. For Local Integration Processes: add a separate <process id="Proc_LIP_[name]"> element and
   reference it from a <callActivity calledElement="Proc_LIP_[name]"> in the main process.
10. Do NOT output any <bpmndi:*> elements.
11. Output ONLY the XML — start directly with <?xml version="1.0"
"""

_DIAGRAM_SUFFIX = "\n\nGenerate the BPMN 2.0 XML diagram for the SAP CPI iFlow described in the content above. Output ONLY the XML starting with <?xml — no preamble, no fences."


async def _stream_diagram(files: List[UploadFile], flow=None) -> AsyncGenerator[str, None]:
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
        logger.info("Diagram — extracted %d text and %d image item(s)", n_text, n_img)
        msg = f"Extracted {n_text} text" + (f" and {n_img} image page(s)" if n_img else "") + " from uploaded file(s)"
        yield _event("step_done", key="extract", message=msg)
    except Exception as exc:
        logger.error("Diagram extraction failed: %s", exc, exc_info=True)
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)
    if isinstance(user_content, str):
        user_content = user_content.replace(SUFFIX.strip(), _DIAGRAM_SUFFIX.strip())
    else:
        for part in reversed(user_content):
            if part.get("type") == "text" and SUFFIX.strip() in part["text"]:
                part["text"] = part["text"].replace(SUFFIX.strip(), _DIAGRAM_SUFFIX.strip())
                break

    if flow:
        keys = ["name", "direction", "source_system", "source_entity", "target_system", "target_api", "trigger", "description"]
        focus = _FLOW_FOCUS_PREFIX.format(**{k: flow.get(k, "") for k in keys})
        if isinstance(user_content, str):
            user_content = focus + user_content
        else:
            user_content = [{"type": "text", "text": focus}] + list(user_content)

    yield _event("step", key="generate", message="Claude is generating the iFlow diagram…")
    try:
        gen = await _chat_complete(_DIAGRAM_SYSTEM, user_content, stream=True, max_tokens=4096)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        logger.info("Diagram complete: %d chars", len(result))
        yield _event("step_done", key="generate", message="Diagram ready")
    except Exception as exc:
        logger.error("Diagram LLM call failed: %s", exc, exc_info=True)
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    yield _event("done", prompt=result)


@router.post("/generate-flow-diagram")
async def generate_flow_diagram(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    logger.info("Flow diagram request — flow: %s", flow.get("name"))
    return StreamingResponse(
        _stream_diagram(files, flow=flow),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Generate single flow prompt endpoint ─────────────────────────────────────


@router.post("/generate-flow-prompt")
async def generate_flow_prompt(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    logger.info("Flow prompt request — flow: %s, files: %s", flow.get("name"), [f.filename for f in files])
    return StreamingResponse(
        _stream(files, flow=flow),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Shared analysis helper ────────────────────────────────────────────────────

async def _stream_analysis(
    files: List[UploadFile],
    flow: dict,
    system_prompt: str,
    task_suffix: str,
    extra_prefix: str = "",
    max_tokens: int = 2048,
) -> AsyncGenerator[str, None]:
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS:
            yield _event("error", message=f"Unsupported file type '{ext}' for '{f.filename}'")
            return

    file_data_list: list[tuple[UploadFile, bytes]] = []
    for f in files:
        data = await f.read()
        if len(data) > _MAX_FILE_SIZE:
            yield _event("error", message=f"File '{f.filename}' exceeds {_MAX_FILE_SIZE // (1024*1024)} MB limit")
            return
        file_data_list.append((f, data))

    try:
        extracted = [item for f, data in file_data_list for item in await extract(f, data)]
    except Exception as exc:
        yield _event("error", message=f"File extraction failed: {exc}")
        return

    user_content = _build_user_content(extracted)
    if isinstance(user_content, str):
        user_content = user_content.replace(SUFFIX.strip(), task_suffix)
    else:
        for part in reversed(user_content):
            if part.get("type") == "text" and SUFFIX.strip() in part["text"]:
                part["text"] = part["text"].replace(SUFFIX.strip(), task_suffix)
                break

    if flow:
        keys = ["name", "direction", "source_system", "source_entity", "target_system", "target_api", "trigger", "description"]
        focus = _FLOW_FOCUS_PREFIX.format(**{k: flow.get(k, "") for k in keys})
        if isinstance(user_content, str):
            user_content = focus + user_content
        else:
            user_content = [{"type": "text", "text": focus}] + list(user_content)

    if extra_prefix:
        if isinstance(user_content, str):
            user_content = extra_prefix + user_content
        else:
            user_content = [{"type": "text", "text": extra_prefix}] + list(user_content)

    try:
        gen = await _chat_complete(system_prompt, user_content, stream=True, max_tokens=max_tokens)
        result = ""
        async for text in gen:
            result += text
            yield _event("chunk", text=text)
        yield _event("done", prompt=result)
    except Exception as exc:
        yield _event("error", message=f"LLM call failed: {exc}")


# ── Visualise: Overview ───────────────────────────────────────────────────────

_OVERVIEW_SYSTEM = """You are an SAP CPI integration architect. Analyse the provided integration
specification and produce a structured overview in clean markdown.

Output sections in this exact order:

## Summary
2-3 sentences describing what this integration does end-to-end.

## Integration Patterns
List each SAP CPI pattern used as a badge-style bullet:
- **Request-Reply** — brief reason why
- **Content Enricher** — brief reason why
(use only patterns actually present: Request-Reply, Content Enricher, Exception Subprocess,
CSRF Token Handling, Message Routing, Splitter, Aggregator, Polling Consumer, Event-Driven)

## Systems & Interfaces
| Direction | Source | Target | Protocol |
|---|---|---|---|
| → | System A | System B | OData V2 |

## Adapters Used
| Adapter | Role | Notes |
|---|---|---|
| HTTPS Sender | Inbound trigger | Receives webhook from IFS |

## Complexity
**Rating:** Low / Medium / High
**Reason:** One sentence.

## Key Considerations
- Bullet per important non-obvious constraint (max 5)

Output ONLY the markdown — no preamble, no fences."""

_OVERVIEW_SUFFIX = "\n\nGenerate the structured iFlow overview for the integration described above."


@router.post("/generate-visualise-overview")
async def generate_visualise_overview(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    return StreamingResponse(
        _stream_analysis(files, flow, _OVERVIEW_SYSTEM, _OVERVIEW_SUFFIX, max_tokens=1500),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Visualise: Field Mappings ─────────────────────────────────────────────────

_MAPPINGS_SYSTEM = """You are an SAP CPI integration developer. Extract ALL field-level mappings
from the integration specification and present them as a structured markdown document.

## Field Mappings

For each mapping interface, create a subsection:

### [Interface Name] — [Source System] → [Target System]

| Source Field | Source Type | Transformation | Target Field | Target Type | Notes |
|---|---|---|---|---|---|
| WorkOrderNo | String | Direct | ProjectID | String | — |
| PlannedStartDate | Date | Format: YYYY-MM-DD | PlannedStartDate | Date | SAP format |

After the table, add any mapping notes as bullets if relevant.

If no explicit field mappings are described, list what CAN be inferred from context.
Output ONLY the markdown — no preamble, no fences."""

_MAPPINGS_SUFFIX = "\n\nExtract and list all field mappings from the integration described above."


@router.post("/generate-field-mappings")
async def generate_field_mappings(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    return StreamingResponse(
        _stream_analysis(files, flow, _MAPPINGS_SYSTEM, _MAPPINGS_SUFFIX, max_tokens=2000),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Visualise: Config Checklist ───────────────────────────────────────────────

_CHECKLIST_SYSTEM = """You are an SAP CPI developer preparing a deployment checklist.
Generate a complete, actionable SAP CPI configuration checklist for this iFlow.

## SAP CPI Configuration Checklist

Group items under these headings (include only relevant groups):

### Security & Credentials
- [ ] Configure [Credential Name] in SAP CPI Security Material (type: OAuth2 / Basic / Cert)
- [ ] ...

### Sender Adapters
- [ ] [Step Name] — HTTPS Sender: set Address to /http/<path>, enable CSRF if required
- [ ] ...

### Receiver Adapters
- [ ] [Step Name] — OData V2: set Address to <url>, Resource Path to <path>, Operation to POST
- [ ] ...

### Mappings & Scripts
- [ ] Upload XSLT file [filename] to Resources
- [ ] ...

### Parameters & Properties
- [ ] Set externalized parameter [name] to [value/description]
- [ ] ...

### Testing Prerequisites
- [ ] [What must exist before the iFlow can be tested]
- [ ] ...

Be specific: include adapter names, field values, and credential names from the specification.
Use <placeholder> for values that cannot be determined.
Output ONLY the markdown checklist — no preamble, no fences."""

_CHECKLIST_SUFFIX = "\n\nGenerate the complete SAP CPI deployment checklist for the integration described above."


@router.post("/generate-config-checklist")
async def generate_config_checklist(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    return StreamingResponse(
        _stream_analysis(files, flow, _CHECKLIST_SYSTEM, _CHECKLIST_SUFFIX, max_tokens=2000),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Visualise: Failure Modes ──────────────────────────────────────────────────

_FAILURES_SYSTEM = """You are an SAP CPI integration architect performing failure mode analysis.
Analyse every processing step and identify realistic failure scenarios.

## Failure Mode Analysis

For each step that could fail, write:

### [Step Name] — [Adapter/Type]

**Risk Level:** Low / Medium / High

| Failure Mode | Cause | Impact | Mitigation |
|---|---|---|---|
| Connection timeout | Network issue or host down | Flow fails, sender gets 500 | Add retry policy; set timeout to 60s |
| Auth failure | Expired credentials | 401/403; flow stops | Monitor cert/token expiry; use CPI alerts |

---

Cover: all adapter steps, script steps, mapping steps, and the exception subprocess.
Be specific to this iFlow — do not give generic SAP advice unrelated to the described steps.
Output ONLY the markdown — no preamble, no fences."""

_FAILURES_SUFFIX = "\n\nAnalyse failure modes for every step in the integration described above."


@router.post("/generate-failure-modes")
async def generate_failure_modes(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
):
    flow = json.loads(flow_json)
    return StreamingResponse(
        _stream_analysis(files, flow, _FAILURES_SYSTEM, _FAILURES_SUFFIX, max_tokens=2500),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Visualise: Step Detail ────────────────────────────────────────────────────

_STEP_DETAIL_SYSTEM = """You are an SAP CPI integration architect explaining a specific step
in an iFlow. A developer has clicked on a node in the iFlow diagram and wants to understand it.

Produce a focused explanation in clean markdown using exactly these sections:

## [Step Name]

**What It Does**
1–2 sentences: the specific function of this step in the flow.

**Why It's Here**
1–2 sentences: the business or technical reason this step exists at this point in the flow.

**Key Configuration**
- Field name: value or description
- Field name: value or description
(list only the important config fields specific to this step type)

**What Can Fail**
- Failure mode → impact (one line each, max 3)

**Best Practice**
1 concrete tip for this step type in SAP CPI.

Be specific to the step described — do not give generic SAP CPI advice.
Output ONLY the markdown — no preamble, no fences."""

_STEP_DETAIL_SUFFIX = "\n\nExplain the specific iFlow step described in the prefix above."


@router.post("/generate-step-detail")
async def generate_step_detail(
    files: List[UploadFile] = File(...),
    flow_json: str = FastAPIForm(...),
    node_label: str = FastAPIForm(...),
    diagram_syntax: str = FastAPIForm(default=""),
):
    flow = json.loads(flow_json)
    ctx = f"NODE TO EXPLAIN: {node_label}\n"
    if diagram_syntax.strip():
        ctx += f"\nFULL DIAGRAM CONTEXT (BPMN 2.0 XML):\n{diagram_syntax}\n"
    ctx += "\n"
    return StreamingResponse(
        _stream_analysis(files, flow, _STEP_DETAIL_SYSTEM, _STEP_DETAIL_SUFFIX,
                         extra_prefix=ctx, max_tokens=1000),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
