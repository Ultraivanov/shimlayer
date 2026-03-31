import httpx

from app.config import get_settings


def send_telegram_message(chat_id: str, text: str) -> bool:
    settings = get_settings()
    token = (settings.shimlayer_telegram_bot_token or "").strip()
    if not token:
        return False
    api_base = settings.shimlayer_telegram_api_base.rstrip("/")
    url = f"{api_base}/bot{token}/sendMessage"
    try:
        resp = httpx.post(url, json={"chat_id": chat_id, "text": text}, timeout=5.0)
        return 200 <= resp.status_code < 300
    except Exception:
        return False
