from __future__ import annotations

import re
from typing import Any


EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
URL_RE = re.compile(r"\bhttps?://[^\s\"')<>\]]+\b", re.IGNORECASE)
IPV4_RE = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
PHONE_RE = re.compile(r"(?:(?<=^)|(?<=[\s(]))(?:\+?\d[\d\s().-]{7,}\d)(?:(?=$)|(?=[\s).,;]))")

# Common key/token shapes (best-effort).
OPENAI_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")
AWS_ACCESS_KEY_RE = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b")
HEX_TOKEN_RE = re.compile(r"\b[a-f0-9]{32,}\b", re.IGNORECASE)


def _redact_string(value: str) -> str:
    out = value
    out = EMAIL_RE.sub("[REDACTED_EMAIL]", out)
    out = URL_RE.sub("[REDACTED_URL]", out)
    out = IPV4_RE.sub("[REDACTED_IP]", out)
    out = OPENAI_KEY_RE.sub("[REDACTED_OPENAI_KEY]", out)
    out = AWS_ACCESS_KEY_RE.sub("[REDACTED_AWS_KEY]", out)
    out = JWT_RE.sub("[REDACTED_JWT]", out)
    out = HEX_TOKEN_RE.sub("[REDACTED_TOKEN]", out)
    out = PHONE_RE.sub("[REDACTED_PHONE]", out)
    return out


def redact_pii(value: Any, *, max_string_length: int = 4000) -> Any:
    """
    Best-effort PII redaction for sending payloads to third-party LLMs.
    - Recursively traverses dict/list/tuple.
    - Redacts common PII/secrets inside strings.
    - Truncates very long strings.
    """
    if value is None:
        return None

    if isinstance(value, str):
        redacted = _redact_string(value)
        if max_string_length > 0 and len(redacted) > max_string_length:
            return redacted[:max_string_length] + "…[TRUNCATED]"
        return redacted

    if isinstance(value, (int, float, bool)):
        return value

    if isinstance(value, dict):
        # Keep keys as-is; sanitize values.
        return {str(k): redact_pii(v, max_string_length=max_string_length) for k, v in value.items()}

    if isinstance(value, list):
        return [redact_pii(v, max_string_length=max_string_length) for v in value]

    if isinstance(value, tuple):
        return tuple(redact_pii(v, max_string_length=max_string_length) for v in value)

    # Fallback: stringify unknown objects.
    return redact_pii(str(value), max_string_length=max_string_length)
