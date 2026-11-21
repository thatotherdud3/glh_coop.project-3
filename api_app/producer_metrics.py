"""Producer dashboard, private session tokens and order-line fulfilment."""
import hashlib
import hmac
import os
import secrets
import stat
import time
from pathlib import Path
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def _load_token_signing_key():
    """Use an environment secret or a private key persisted on this machine."""
    configured = os.environ.get("GLH_SESSION_SECRET_HEX")
    if configured is not None:
        try:
            key = bytes.fromhex(configured.strip())
        except ValueError as error:
            raise RuntimeError("GLH_SESSION_SECRET_HEX must be 64 hexadecimal characters.") from error
        if len(key) != 32:
            raise RuntimeError("GLH_SESSION_SECRET_HEX must contain exactly 32 bytes.")
        return key

    filename = Path(
        os.environ.get("GLH_SESSION_KEY_FILE")
        or Path(__file__).resolve().parent.parent / ".glh_session_key"
    )
    if filename.is_symlink():
        raise RuntimeError("The session signing key must be a regular private file, not a symlink.")
    try:
        fd = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass  # Reuse this key after restarts: previously issued sessions still verify.
    else:
        with os.fdopen(fd, "w", encoding="ascii") as secret_file:
            secret_file.write(secrets.token_hex(32) + "\n")
            secret_file.flush()
            os.fsync(secret_file.fileno())

    if filename.is_symlink() or not filename.is_file():
        raise RuntimeError("The session signing key must be stored in a regular file.")
    if stat.S_IMODE(filename.stat().st_mode) & 0o077:
        raise RuntimeError("Session key permissions are too open; use chmod 600.")
    try:
        key = bytes.fromhex(filename.read_text(encoding="ascii").strip())
    except ValueError as error:
        raise RuntimeError("The session signing key file is invalid.") from error
    if len(key) != 32:
        raise RuntimeError("The session signing key file must contain 32 bytes.")
    return key


_TOKEN_KEY = _load_token_signing_key()
_TOKEN_TTL = 24 * 60 * 60


def issue_producer_token(user_id):
    payload = f"{int(user_id)}:{int(time.time()) + _TOKEN_TTL}"
    signature = hmac.new(_TOKEN_KEY, payload.encode(), hashlib.sha256).hexdigest()
    return payload + "." + signature


def producer_from_token(connection, header):
    if not header or not header.startswith("Bearer "):
        return None
    try:
        payload, signature = header[7:].strip().rsplit(".", 1)
        producer_id, expires = map(int, payload.split(":"))
    except (TypeError, ValueError):
        return None
    expected = hmac.new(_TOKEN_KEY, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    if producer_id <= 0 or int(time.time()) >= expires:
        return None
    found = connection.execute(
        "SELECT 1 FROM users WHERE user_id = ? AND role = 'producer'",
        (producer_id,),
    ).fetchone()
    return producer_id if found else None


def producer_from_request(connection, headers):
    """Use the signed HttpOnly cookie, falling back to the existing bearer token."""
    raw_cookie = headers.get("Cookie", "")
    if raw_cookie:
        cookies = SimpleCookie()
        try:
            cookies.load(raw_cookie)
            ticket = cookies.get("glh_producer_session")
            if ticket:
                authenticated = producer_from_token(
                    connection, "Bearer " + ticket.value
                )
                if authenticated is not None:
                    return authenticated
        except Exception:
            # Malformed cookie values never authenticate a request.
            pass
    return producer_from_token(connection, headers.get("Authorization"))



def customer_from_request(connection, headers):
    """Authorise shopping for customers and signed-in producers alike.

    Shopping always requires a signed, HttpOnly browser cookie. Reuse the
    producer validator for producer shopping so dashboard and checkout cannot
    disagree about whether the same producer session is valid.
    """
    raw_cookie = headers.get("Cookie", "")
    if not raw_cookie:
        return None
    try:
        cookies = SimpleCookie()
        cookies.load(raw_cookie)
    except (TypeError, ValueError):
        return None

    customer_cookie = cookies.get("glh_customer_session")
    if customer_cookie:
        try:
            payload, signature = customer_cookie.value.rsplit(".", 1)
            user_id, expires = map(int, payload.split(":"))
            expected = hmac.new(_TOKEN_KEY, payload.encode(), hashlib.sha256).hexdigest()
            if (
                user_id > 0
                and time.time() < expires
                and hmac.compare_digest(signature, expected)
                and connection.execute(
                    "SELECT 1 FROM users WHERE user_id = ? AND role = 'customer'",
                    (user_id,),
                ).fetchone()
            ):
                return user_id
        except (TypeError, ValueError):
            # A stale customer cookie must not shadow a valid producer cookie.
            pass

    producer_cookie = cookies.get("glh_producer_session")
    if producer_cookie:
        return producer_from_token(connection, "Bearer " + producer_cookie.value)
    return None


def ensure_producer_metrics_schema(connection):
    tables = {r["name"] for r in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if "order_items" not in tables:
        return
    columns = {r["name"] for r in connection.execute("PRAGMA table_info(order_items)")}
    for name, definition in (
        ("producer_id", "INTEGER"),
        ("unit_price", "REAL"),
        ("product_name", "TEXT"),
        ("fulfilled_at", "TEXT"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE order_items ADD COLUMN {name} {definition}")
    if "products" in tables:
        # Backfill producer and product identity, without inventing sale prices.
        connection.execute("""
            UPDATE order_items SET producer_id = (
                SELECT producer_id FROM products p
                WHERE p.product_id = order_items.product_id
            ) WHERE producer_id IS NULL
        """)
        connection.execute("""
            UPDATE order_items SET product_name = (
                SELECT product_name FROM products p
                WHERE p.product_id = order_items.product_id
            ) WHERE product_name IS NULL
        """)


def _month_bounds():
    now = datetime.now(ZoneInfo("Europe/London"))
    first = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    next_month = (
        first.replace(year=first.year + 1, month=1)
        if first.month == 12 else first.replace(month=first.month + 1)
    )
    fmt = "%Y-%m-%d %H:%M:%S"
    return (
        first.astimezone(timezone.utc).strftime(fmt),
        next_month.astimezone(timezone.utc).strftime(fmt),
    )


def get_producer_dashboard(connection, producer_id):
    stock = connection.execute("""
        SELECT COALESCE(SUM(CASE WHEN stock_level > 0
            THEN stock_level ELSE 0 END), 0)
        FROM products WHERE producer_id = ?
    """, (producer_id,)).fetchone()[0]
    revenue = connection.execute("""
        SELECT COALESCE(SUM(oi.quantity * COALESCE(
                   oi.unit_price, p.price, 0)), 0) AS amount,
               COALESCE(SUM(CASE WHEN oi.unit_price IS NULL
                   THEN 1 ELSE 0 END), 0) AS estimated_lines,
               COALESCE(SUM(CASE WHEN oi.unit_price IS NULL
                   AND p.price IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_lines
        FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id
        LEFT JOIN products p ON p.product_id = oi.product_id
        WHERE COALESCE(oi.producer_id, p.producer_id) = ?
          AND o.order_time >= ? AND o.order_time < ?
    """, (producer_id, *_month_bounds())).fetchone()
    pending = connection.execute("""
        SELECT oi.item_id, oi.order_id, oi.quantity,
               COALESCE(oi.product_name, p.product_name, 'Product unavailable')
                   AS product_name, o.order_time
        FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id
        LEFT JOIN products p ON p.product_id = oi.product_id
        WHERE COALESCE(oi.producer_id, p.producer_id) = ?
          AND oi.fulfilled_at IS NULL
        ORDER BY o.order_time, oi.item_id
    """, (producer_id,)).fetchall()
    return {
        "revenue_mtd": round(revenue["amount"], 2),
        "active_stock_units": int(stock),
        "pending_orders": len({row["order_id"] for row in pending}),
        "historical_prices_estimated": revenue["estimated_lines"] > 0,
        "missing_historical_prices": revenue["unpriced_lines"] > 0,
        "pending_items": [dict(row) for row in pending],
    }


def fulfil_order_item(connection, producer_id, item_id):
    change = connection.execute("""
        UPDATE order_items SET fulfilled_at = CURRENT_TIMESTAMP
        WHERE item_id = ? AND fulfilled_at IS NULL
          AND COALESCE(producer_id, (
              SELECT producer_id FROM products p
              WHERE p.product_id = order_items.product_id
          )) = ?
    """, (item_id, producer_id))
    return change.rowcount == 1
