from app.services.pii_redaction import redact_pii


def test_redact_pii_redacts_common_patterns_and_truncates() -> None:
    payload = {
        "email": "alice@example.com",
        "url": "https://example.com/path?token=sk-abcdefghijklmnopqrstuvwxyz123456",
        "ip": "10.20.30.40",
        "phone": "+1 (555) 123-4567",
        "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "nested": ["AKIA1234567890ABCDEF", "deadbeef" * 10],
        "long": "x" * 50,
    }
    out = redact_pii(payload, max_string_length=20)
    assert out["email"] == "[REDACTED_EMAIL]"
    assert out["url"].startswith("[REDACTED_URL]")
    assert out["ip"] == "[REDACTED_IP]"
    assert out["phone"] == "[REDACTED_PHONE]"
    assert out["jwt"] == "[REDACTED_JWT]"
    assert out["nested"][0] == "[REDACTED_AWS_KEY]"
    assert out["nested"][1] in ("[REDACTED_TOKEN]",) or out["nested"][1].endswith("…[TRUNCATED]")
    assert out["long"].endswith("…[TRUNCATED]")
