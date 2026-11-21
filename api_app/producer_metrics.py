"""Producer dashboard, private session tokens and order-line fulfilment."""
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

_TOKEN_KEY = secrets.token_bytes(32)  # Login again after server restarts.
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
