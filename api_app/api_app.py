import json
import math
import sqlite3
import hashlib
import os
import re
import secrets
from password_security import hash_password, verify_password, needs_upgrade
from datetime import date
from urllib.parse import unquote, urlsplit, parse_qs
from http.server import SimpleHTTPRequestHandler, HTTPServer
from email.parser import BytesParser
from producer_metrics import (
    ensure_producer_metrics_schema, fulfil_order_item,
    get_producer_dashboard, issue_producer_token, producer_from_request,
    customer_from_request,
)

PORT = 8000
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
ASSET_DIR = os.path.join(FRONTEND_DIR, "assets")

# Earlier database seeds stored PNG names for files uploaded as JPG/JPEG.
# Only fix these exact old references; do not overwrite newer product images.
LEGACY_PRODUCT_IMAGES = (
    ("ER-26-B3", "basil.png", "basil.jpg"),
    ("ER-26-B4", "tarragon.png", "tarragon.jpeg"),
    ("DM-26-C2", "hen ow.png", "hen ow.jpeg"),
    ("AP-26-E4", "amber honey.png", "amber honey.jpg"),
)

# creates the assets folder if it doesnt already exist
if not os.path.exists(ASSET_DIR):
    os.makedirs(ASSET_DIR)


def get_db_connection():
    # builds the path to the database file
    current_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(current_dir, "..", "glh_coop.db")

    # fallback path if running from a different working directory
    if not os.path.exists(db_path):
        db_path = "glh_coop.db"

    conn = sqlite3.connect(db_path)
    # returns rows as dictionaries so we can access columns by name
    conn.row_factory = sqlite3.Row

    # creates the cookie consent table on first connection if it isnt there yet
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cookie_consent (
            consent_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            consent_token TEXT NOT NULL UNIQUE,
            strictly_necessary INTEGER DEFAULT 1,
            analytics    INTEGER DEFAULT 0,
            marketing    INTEGER DEFAULT 0,
            consented_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Add new nullable trace fields to databases created before this feature.
    # Historical records must not receive fabricated dates or approvals.
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(products)")}
    if columns:
        if "harvest_date" not in columns:
            conn.execute("ALTER TABLE products ADD COLUMN harvest_date TEXT")
        if "safety_clearance" not in columns:
            conn.execute("ALTER TABLE products ADD COLUMN safety_clearance TEXT")

    # Safe, idempotent image data migration. No reseeding or deleted records.
    if "product_image" in columns:
        for batch, old_name, new_name in LEGACY_PRODUCT_IMAGES:
            if os.path.isfile(os.path.join(ASSET_DIR, new_name)):
                conn.execute(
                    "UPDATE products SET product_image = ? "
                    "WHERE batch_number = ? AND product_image = ?",
                    (new_name, batch, old_name),
                )

    # Preserve existing orders while enabling a selected pickup node or
    # delivery address to be stored with newly created orders.
    order_columns = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
    if order_columns:
        for name in ("delivery_method", "collection_node_code", "delivery_address_json"):
            if name not in order_columns:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {name} TEXT")

    # Add fields without replacing or reseeding existing producer inventory.
    if columns and "product_description" not in columns:
        conn.execute("ALTER TABLE products ADD COLUMN product_description TEXT")

    # A retry of one checkout request must not create another order.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS checkout_requests (
            customer_id INTEGER NOT NULL,
            checkout_key TEXT NOT NULL,
            order_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (customer_id, checkout_key)
        )
    """)

    ensure_producer_metrics_schema(conn)
    conn.commit()
    return conn


def retrieve_inventory():
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL query joins the products table to the users table to get the producer name
    cursor.execute("""
        SELECT 
            p.*, 
            u.full_name as producer_name 
        FROM products p
        JOIN users u ON p.producer_id = u.user_id
    """)

    inventory = cursor.fetchall()
    connection.close()
    # converts the sqlite rows into plain dictionaries for JSON serialisation
    return [dict(row) for row in inventory]


def insert_inventory(data):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL insert statement for a new product record
    cursor.execute("""
        INSERT INTO products (producer_id, product_name, price, stock_level, allergen_info, batch_number, product_image, harvest_date, product_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        # binds each value to its paramterised placeholder
        data.get("producer_id"),
        data.get("product_name"),
        data.get("price"),
        data.get("stock_level"),
        data.get("allergen_info"),
        data.get("batch_number"),
        data.get("product_image"),
        data.get("harvest_date"),
        data.get("product_description", "")
    ))
    connection.commit()
    connection.close()
    print(f"CORE LOG: Asset {data.get('product_name')} successfully committed to ledger.")


class NativeAPIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # tells the server to serve files from the frontend folder
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def _origin_allowed(self):
        origin = self.headers.get('Origin')
        return not origin or origin == 'http://' + self.headers.get('Host', '')

    def authenticated_user(self, connection):
        return (
            producer_from_request(connection, self.headers)
            or customer_from_request(connection, self.headers)
        )

    def do_OPTIONS(self):
        # handles the CORS pre-flight request so the browser allows cross-origin calls
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def send_json_result(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # A closed browser tab must not cause a second 500 response attempt.
            self.close_connection = True

    def do_GET(self):
        if urlsplit(self.path).path == "/checkout/status":
            connection = None
            try:
                params = parse_qs(urlsplit(self.path).query)
                key = params.get("key", [None])[0]
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._-]{8,128}", key):
                    self.send_json_result(400, {"message": "Invalid checkout reference."})
                    return
                connection = get_db_connection()
                customer_id = customer_from_request(connection, self.headers)
                if customer_id is None:
                    self.send_json_result(401, {"message": "Sign in to check the last order."})
                    return
                recorded = connection.execute(
                    "SELECT order_id FROM checkout_requests WHERE customer_id = ? AND checkout_key = ?",
                    (customer_id, key)
                ).fetchone()
                if recorded is None:
                    self.send_json_result(404, {"message": "No order recorded for this checkout attempt."})
                else:
                    self.send_json_result(200, {"status": "success", "order_id": recorded["order_id"]})
            except sqlite3.Error as error:
                print(f"CHECKOUT STATUS ERROR: {error}")
                self.send_json_result(500, {"message": "Unable to verify the previous order."})
            finally:
                if connection is not None:
                    connection.close()
            return

        if urlsplit(self.path).path == "/session":
            connection = None
            try:
                connection = get_db_connection()
                user_id = customer_from_request(connection, self.headers)
                if user_id is None:
                    user_id = producer_from_request(connection, self.headers)
                if user_id is None:
                    self.send_json_result(401, {"message": "Sign in to continue."})
                    return
                user = connection.execute(
                    "SELECT user_id, full_name, role FROM users WHERE user_id = ?",
                    (user_id,)
                ).fetchone()
                if user is None:
                    self.send_json_result(401, {"message": "Session has expired."})
                    return
                self.send_json_result(200, dict(user))
            except sqlite3.Error as error:
                print(f"SESSION ERROR: {error}")
                self.send_json_result(500, {"message": "Could not verify session."})
            finally:
                if connection is not None:
                    connection.close()
            return

        # Compatibility redirect: older cached navigation used /home.html.
        # The actual homepage is frontend/index.html.
        if urlsplit(self.path).path == "/home.html":
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path == "/producer/dashboard":
            connection = None
            try:
                connection = get_db_connection()
                producer_id = producer_from_request(connection, self.headers)
                if producer_id is None:
                    self.send_json_result(401, {
                        "message": "Producer session expired. Sign in again."
                    })
                    return
                self.send_json_result(
                    200, get_producer_dashboard(connection, producer_id)
                )
            except Exception as error:
                print(f"PRODUCER DASHBOARD ERROR: {error}")
                self.send_json_result(500, {
                    "message": "Unable to retrieve producer figures."
                })
            finally:
                if connection is not None:
                    connection.close()

        elif self.path.startswith("/batch-trace/"):
            code = unquote(urlsplit(self.path).path[len("/batch-trace/"):]).strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", code):
                self.send_json_result(400, {"message": "Enter a valid batch number."})
                return

            connection = None
            try:
                connection = get_db_connection()
                has_farms = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'farms'"
                ).fetchone() is not None
                farm_select = (
                    "(SELECT f.farm_name FROM farms f "
                    "WHERE f.user_id = p.producer_id ORDER BY f.farm_id LIMIT 1)"
                    if has_farms else "NULL"
                )
                rows = connection.execute(f"""
                    SELECT p.batch_number, p.product_name, p.harvest_date,
                           p.safety_clearance, u.full_name AS producer_name,
                           {farm_select} AS farm_name
                    FROM products p
                    INNER JOIN users u ON u.user_id = p.producer_id
                    WHERE p.batch_number = ? COLLATE NOCASE
                    ORDER BY p.product_id ASC
                    LIMIT 2
                """, (code,)).fetchall()

                if not rows:
                    self.send_json_result(404, {"message": "No batch found with that reference."})
                    return
                if len(rows) > 1:
                    self.send_json_result(409, {"message": "Multiple products share this batch number. Contact the cooperative."})
                    return

                row = rows[0]
                clearance = (row["safety_clearance"] or "").strip().upper()
                if clearance not in ("PENDING", "VERIFIED", "REJECTED"):
                    clearance = "NOT_RECORDED"
                origin_from_farm = bool(row["farm_name"])
                self.send_json_result(200, {
                    "batch_number": row["batch_number"],
                    "product_name": row["product_name"],
                    "origin": row["farm_name"] if origin_from_farm else row["producer_name"],
                    "origin_type": "farm" if origin_from_farm else "producer",
                    "harvest_date": row["harvest_date"],
                    "safety_clearance": clearance,
                })
            except sqlite3.Error as error:
                print(f"BATCH TRACE ERROR: {error}")
                self.send_json_result(500, {"message": "Trace records are currently unavailable."})
            finally:
                if connection is not None:
                    connection.close()

        elif self.path == '/products' or self.path.startswith('/products?'):
            # returns the full product inventory as a JSON array
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            data = retrieve_inventory()
            self.wfile.write(json.dumps(data).encode('utf-8'))

        elif self.path.startswith('/users/'):
            try:
                # pulls the user id from the URL path
                user_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()

                # Profiles are private; clients may access only their own account.
                if self.authenticated_user(connection) != user_id:
                    connection.close()
                    self.send_json_result(403, {"message": "Not authorised to view this account."})
                    return
                cursor.execute("SELECT user_id, full_name, email, role FROM users WHERE user_id = ?", (user_id,))
                user = cursor.fetchone()
                connection.close()
                if user:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps(dict(user)).encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
            except Exception as e:
                print(f"USER GET ERROR: {e}")
                self.send_response(500)
                self.end_headers()

        elif re.fullmatch(r"/orders/[0-9]+/confirmation", urlsplit(self.path).path):
            # A private receipt for one order, restricted to the customer
            # authenticated by their signed HttpOnly session.
            connection = None
            try:
                order_id = int(urlsplit(self.path).path.split("/")[2])
                connection = get_db_connection()
                customer_id = customer_from_request(connection, self.headers)
                if customer_id is None:
                    self.send_json_result(401, {
                        "message": "Please sign in as a customer to view your order."
                    })
                    return
                order = connection.execute("""
                    SELECT order_id, order_time, total_price,
                           delivery_method, collection_node_code,
                           delivery_address_json
                    FROM orders
                    WHERE order_id = ? AND customer_id = ?
                """, (order_id, customer_id)).fetchone()
                if order is None:
                    self.send_json_result(404, {"message": "Order not found."})
                    return
                lines = connection.execute("""
                    SELECT oi.item_id, oi.quantity,
                           COALESCE(oi.product_name, p.product_name, 'Product unavailable')
                               AS product_name,
                           COALESCE(oi.unit_price, p.price, 0) AS unit_price,
                           COALESCE(p.product_image, 'placeholder.png') AS product_image,
                           COALESCE(u.full_name, 'GLH CO-OP') AS producer_name,
                           oi.fulfilled_at
                    FROM order_items oi
                    LEFT JOIN products p ON p.product_id = oi.product_id
                    LEFT JOIN users u ON u.user_id = COALESCE(oi.producer_id, p.producer_id)
                    WHERE oi.order_id = ?
                    ORDER BY oi.item_id
                """, (order_id,)).fetchall()
                product_lines = [{
                    "product_name": item["product_name"],
                    "quantity": item["quantity"],
                    "unit_price": round(item["unit_price"], 2),
                    "line_total": round(item["unit_price"] * item["quantity"], 2),
                    "product_image": item["product_image"],
                    "producer_name": item["producer_name"],
                    "fulfilled": bool(item["fulfilled_at"]),
                } for item in lines]
                delivery_fee = 15.00 if order["delivery_method"] == "direct" else 0.00
                address = (json.loads(order["delivery_address_json"])
                           if order["delivery_address_json"] else None)
                self.send_json_result(200, {
                    "order_id": order["order_id"],
                    "order_time": order["order_time"],
                    "total_price": round(order["total_price"], 2),
                    "delivery_fee": delivery_fee,
                    "delivery_method": order["delivery_method"],
                    "collection_node_code": order["collection_node_code"],
                    "delivery_address": address,
                    "payment_status": "NOT_PROCESSED",
                    "fulfilment_status": (
                        "Fulfilled" if product_lines and all(
                            line["fulfilled"] for line in product_lines
                        ) else "Pending"
                    ),
                    "items": product_lines
                })
            except (sqlite3.Error, ValueError, TypeError) as error:
                print(f"ORDER CONFIRMATION ERROR: {error}")
                self.send_json_result(500, {"message": "Unable to retrieve order details."})
            finally:
                if connection is not None:
                    connection.close()

        elif self.path.startswith('/orders/'):
            try:
                # pulls the customer id from the URL to filter their orders
                customer_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()

                # A customer can only view their own order history.
                if customer_from_request(connection, self.headers) != customer_id:
                    connection.close()
                    self.send_json_result(403, {"message": "Not authorised to view these orders."})
                    return
                cursor.execute("""
                    SELECT o.order_id, o.order_time, o.total_price,
                           COUNT(oi.item_id) as item_count,
                           CASE
                             WHEN COUNT(oi.item_id) = 0 THEN 'Unknown'
                             WHEN SUM(CASE WHEN oi.fulfilled_at IS NULL THEN 1 ELSE 0 END) = 0
                                  THEN 'Fulfilled'
                             ELSE 'Pending'
                           END AS fulfilment_status
                    FROM orders o
                    LEFT JOIN order_items oi ON o.order_id = oi.order_id
                    WHERE o.customer_id = ?
                    GROUP BY o.order_id
                    ORDER BY o.order_time DESC
                """, (customer_id,))
                orders = [dict(row) for row in cursor.fetchall()]
                connection.close()
                print(f"ORDER HISTORY LOG: {len(orders)} order(s) retrieved for Customer {customer_id}.")
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(orders).encode('utf-8'))
            except Exception as e:
                print(f"ORDER HISTORY ERROR: {e}")
                self.send_response(500)
                self.end_headers()

        else:
            # falls back to the default file server for html css and js files
            super().do_GET()

    def do_POST(self):
        if not self._origin_allowed():
            self.send_json_result(403, {"message": "Cross-site requests are not permitted."})
            return

        if self.path == "/producer/logout":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            for cookie_name in ("glh_producer_session", "glh_customer_session"):
                self.send_header("Set-Cookie", cookie_name + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
            body = b'{"status":"success"}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # registration endpoint
        if self.path == '/register':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                # parses the incoming JSON payload
                payload = json.loads(post_data.decode('utf-8'))

                full_name = payload.get("full_name")
                email = payload.get("email")
                raw_password = payload.get("password")
                if payload.get("role", "customer") != "customer":
                    self.send_json_result(403, {"message": "Only customer accounts can be registered publicly."})
                    return
                role = "customer"

                if not isinstance(raw_password, str) or len(raw_password) < 8:
                    self.send_json_result(400, {"message": "Password must be at least 8 characters."})
                    return
                hashed_pw = hash_password(raw_password)

                connection = get_db_connection()
                cursor = connection.cursor()

                # SQL insert statement to create the new user account
                cursor.execute("""
                    INSERT INTO users (full_name, email, password_hash, role)
                    VALUES (?, ?, ?, ?)
                """, (full_name, email, hashed_pw, role))

                connection.commit()
                connection.close()

                print(f"SECURITY LOG: New identity [{email}] committed to ledger.")

                self.send_response(201)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "Identity verified and stored."}).encode('utf-8'))

            except sqlite3.IntegrityError:
                # the UNIQUE constraint on email throws this if the address is alredy registered
                print(f"SECURITY ALERT: Registration collision. Identity [{email}] already exists.")
                self.send_response(409)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": "Email already registered."}).encode('utf-8'))

            except Exception as e:
                print(f"SYSTEM ERROR: Ingestion failure on /register. {e}")
                self.send_response(500)
                self.end_headers()

        # login and role based routing endpoint
        elif self.path == '/login':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                payload = json.loads(post_data.decode('utf-8'))

                email = payload.get("email")
                raw_password = payload.get("password")
                # the frontend sends which terminal the user is trying to access
                requested_node = payload.get("requested_node", "customer")

                if not isinstance(email, str) or not isinstance(raw_password, str):
                    self.send_json_result(400, {"message": "Email and password are required."})
                    return
                connection = get_db_connection()
                try:
                    user = connection.execute(
                        "SELECT user_id, full_name, role, password_hash FROM users WHERE email = ?",
                        (email,)
                    ).fetchone()
                    if user and verify_password(raw_password, user["password_hash"]):
                        if needs_upgrade(user["password_hash"]):
                            connection.execute(
                                "UPDATE users SET password_hash = ? WHERE user_id = ?",
                                (hash_password(raw_password), user["user_id"])
                            )
                            connection.commit()
                    else:
                        user = None
                finally:
                    connection.close()

                if user:
                    role = user["role"]

                    # Producer accounts can also use the customer shopping node.
                    # Customer accounts still cannot access producer-only actions.
                    if requested_node not in ("customer", "producer") or (
                        requested_node == "producer" and role != "producer"
                    ):
                        print(f"SECURITY ALERT: Access denied for [{email}] at node [{requested_node}].")
                        self.send_json_result(403, {
                            "status": "error",
                            "message": "This account cannot access the selected node."
                        })
                        return

                    # sends the user to the correct portal based on which terminal they logged in through
                    if requested_node == "customer":
                        target_node = "customer-portal.html"
                    else:
                        target_node = "producer-portal.html" if role == "producer" else "customer-portal.html"

                    print(f"SECURITY LOG: Authentication successful for [{email}]. Node assignment: {role.upper()}.")
                    session_token = issue_producer_token(user["user_id"])
                    self.send_response(200)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-type', 'application/json')
                    session_cookie = (
                        "glh_producer_session" if role == "producer"
                        else "glh_customer_session"
                    )
                    other_cookie = (
                        "glh_customer_session" if role == "producer"
                        else "glh_producer_session"
                    )
                    self.send_header(
                        "Set-Cookie",
                        session_cookie + "=" + session_token
                        + "; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict"
                    )
                    self.send_header(
                        "Set-Cookie",
                        other_cookie + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
                    )
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "status": "success",
                        "role": role,
                        "user_id": user["user_id"],
                        "full_name": user["full_name"],
                        "redirect_url": target_node,
                        "session_token": None
                    }).encode('utf-8'))
                else:
                    # if the SQL statement returned nothing the credentials were wrong
                    print(f"SECURITY ALERT: Unauthorized access attempt for [{email}].")
                    self.send_response(401)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": "Invalid credentials."}).encode('utf-8'))

            except Exception as e:
                print(f"SYSTEM ERROR: Authentication failure. {e}")
                self.send_response(500)
                self.end_headers()

        # product upload endpoint (multipart form data with an image file)
        elif self.path == '/products':
            session_connection = get_db_connection()
            try:
                authenticated_producer_id = producer_from_request(
                    session_connection, self.headers
                )
            finally:
                session_connection.close()
            if authenticated_producer_id is None:
                self.send_json_result(401, {"message": "Producer sign-in required."})
                return
            try:
                content_type = self.headers.get('Content-Type')
                content_length = int(self.headers.get('Content-Length'))
                if content_length <= 0 or content_length > 6 * 1024 * 1024:
                    self.send_json_result(413, {"message": "Upload exceeds 6 MB."})
                    return
                raw_body = self.rfile.read(content_length)

                # parses the multipart form to separate text fields from the image
                headers_string = f"Content-Type: {content_type}\r\n\r\n"
                msg = BytesParser().parsebytes(headers_string.encode() + raw_body)

                data = {}
                image_filename = "placeholder.png"

                for part in msg.get_payload():
                    field_name = part.get_param('name', header='content-disposition')

                    if field_name == "product_image":
                        # saves the uploaded image file to the assets folder
                        filename = part.get_filename()
                        if filename:
                            extension = os.path.splitext(filename)[1].lower()
                            image_content = part.get_payload(decode=True) or b""
                            valid_jpeg = extension in (".jpg", ".jpeg") and image_content.startswith(bytes.fromhex("ffd8ff"))
                            valid_png = extension == ".png" and image_content.startswith(bytes.fromhex("89504e470d0a1a0a"))
                            valid_webp = extension == ".webp" and image_content[:4] == b"RIFF" and image_content[8:12] == b"WEBP"
                            if not (valid_jpeg or valid_png or valid_webp) or len(image_content) > 5 * 1024 * 1024:
                                raise ValueError("Provide a PNG, JPG or WebP image no larger than 5 MB.")
                            image_filename = secrets.token_hex(16) + extension
                            save_path = os.path.join(ASSET_DIR, image_filename)
                            with open(save_path, "xb") as target:
                                target.write(image_content)
                    else:
                        # decodes all other text fields into the data dict
                        data[field_name] = part.get_payload(decode=True).decode('utf-8')

                producer_id_raw = authenticated_producer_id

                # casts each field to the correct type before inserting
                # Producers can supply harvest dates, but cannot mark their
                # own stock as safety-verified via the intake form.
                harvest_date = (data.get("harvest_date") or "").strip() or None
                if harvest_date:
                    parsed_harvest_date = date.fromisoformat(harvest_date)
                    if parsed_harvest_date > date.today():
                        raise ValueError("Harvest date cannot be in the future.")

                stock_level = int(data.get("stock_level", 0))
                price = float(data.get("price", 0.0))
                if stock_level < 0 or stock_level > 1000000 or not math.isfinite(price) or not (0 <= price <= 100000) or round(price, 2) != price:
                    raise ValueError("Enter a valid quantity and a unit price with up to two decimals.")
                if not (data.get("product_name") or "").strip():
                    raise ValueError("Product name is required.")
                if len(data["product_name"].strip()) > 255:
                    raise ValueError("Product name is too long.")
                if not (data.get("batch_number") or "").strip():
                    raise ValueError("Batch reference is required.")
                if len(data["batch_number"].strip()) > 100:
                    raise ValueError("Batch reference is too long.")
                description = (data.get("product_description") or "").strip()
                if len(description) > 1500:
                    raise ValueError("Description cannot exceed 1500 characters.")

                final_payload = {
                    "harvest_date": harvest_date,
                    "producer_id": int(producer_id_raw),
                    "batch_number": data.get("batch_number"),
                    "product_name": data.get("product_name"),
                    "stock_level": stock_level,
                    "price": price,
                    "allergen_info": data.get("allergen_info"),
                    "product_image": image_filename,
                    "product_description": description
                }

                insert_inventory(final_payload)

                self.send_response(201)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

            except ValueError as error:
                self.send_json_result(400, {"message": str(error)})
            except Exception as e:
                print(f"PRODUCT UPLOAD ERROR: {e}")
                self.send_json_result(500, {
                    "message": "Unable to save the product. Check the uploaded image and try again."
                })

        # atomic checkout endpoint
        elif self.path == '/checkout':
            connection = get_db_connection()
            cursor = connection.cursor()
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))

                customer_id = customer_from_request(connection, self.headers)
                if customer_id is None:
                    self.send_json_result(401, {"message": "Sign in as a customer to place an order."})
                    return
                cart_items = payload.get("cart", [])
                checkout_key = payload.get("checkout_key")
                if checkout_key is not None and (
                    not isinstance(checkout_key, str)
                    or not re.fullmatch(r"[A-Za-z0-9._-]{8,128}", checkout_key)
                ):
                    self.send_json_result(400, {"message": "Invalid checkout request ID."})
                    return
                submitted_total = payload.get("total_price", 0.0)
                delivery_method = payload.get("delivery_method", "hub")

                # BEGIN IMMEDIATE serialises stock changes and order writes.
                # Retries with the same key return the original order.
                connection.execute("BEGIN IMMEDIATE")
                if checkout_key:
                    recorded = connection.execute(
                        "SELECT order_id FROM checkout_requests WHERE customer_id = ? AND checkout_key = ?",
                        (customer_id, checkout_key)
                    ).fetchone()
                    if recorded:
                        connection.rollback()
                        self.send_json_result(200, {
                            "status": "success",
                            "order_id": recorded["order_id"],
                            "duplicate": True
                        })
                        return
                if delivery_method not in ("hub", "direct"):
                    connection.rollback()
                    self.send_json_result(400, {"message": "Invalid delivery method."})
                    return

                # The same six illustrative node IDs used on drop-nodes.html.
                valid_nodes = {
                    "ND-01": "Liverpool Hub", "ND-02": "Manchester Hub",
                    "ND-03": "Cardiff Hub", "ND-04": "Glasgow Hub",
                    "ND-05": "Belfast Hub", "ND-06": "Dublin Hub",
                }
                node_code = None
                address_json = None
                if delivery_method == "hub":
                    node_code = payload.get("collection_node_code")
                    if not isinstance(node_code, str) or node_code not in valid_nodes:
                        connection.rollback()
                        self.send_json_result(400, {
                            "message": "Select a valid collection node before checkout."
                        })
                        return
                else:
                    address = payload.get("delivery_address")
                    if not isinstance(address, dict):
                        connection.rollback()
                        self.send_json_result(400, {
                            "message": "Enter your delivery address before checkout."
                        })
                        return
                    fields = ("line1", "line2", "town", "postcode", "country")
                    if any(not isinstance(address.get(field, ""), str) for field in fields):
                        connection.rollback()
                        self.send_json_result(400, {
                            "message": "Delivery address fields must be text."
                        })
                        return
                    address = {
                        key: " ".join(address.get(key, "").strip().split())
                        for key in fields
                    }
                    if (
                        any(not address[key] for key in ("line1", "town", "postcode", "country"))
                        or len(address["line1"]) > 120
                        or len(address["line2"]) > 120
                        or len(address["town"]) > 80
                        or len(address["postcode"]) > 16
                        or address["country"] not in ("United Kingdom", "Ireland")
                    ):
                        connection.rollback()
                        self.send_json_result(400, {
                            "message": "Enter a valid street address, town, postcode and country."
                        })
                        return
                    address_json = json.dumps(address, ensure_ascii=False)

                # Validate stock using DB values and snapshot prices for reporting.
                if not isinstance(cart_items, list) or not cart_items:
                    connection.rollback()
                    self.send_json_result(400, {"message": "Cart must contain products."})
                    return
                validated_items = []
                seen_products = set()
                for item in cart_items:
                    if not isinstance(item, dict):
                        connection.rollback()
                        self.send_json_result(400, {"message": "Invalid cart item."})
                        return
                    try:
                        product_id = int(item["product_id"])
                        quantity = int(item["quantity"])
                    except (ValueError, TypeError, KeyError):
                        connection.rollback()
                        self.send_json_result(400, {"message": "Invalid product ID or quantity."})
                        return
                    if product_id <= 0 or quantity <= 0 or product_id in seen_products:
                        connection.rollback()
                        self.send_json_result(400, {
                            "message": "Products must have a positive quantity and appear only once in the cart."
                        })
                        return
                    seen_products.add(product_id)
                    cursor.execute(
                        "SELECT product_id, stock_level, price, producer_id, product_name "
                        "FROM products WHERE product_id = ?", (product_id,)
                    )
                    product = cursor.fetchone()
                    if not product or product["stock_level"] < quantity:
                        connection.rollback()
                        self.send_json_result(409, {
                            "code": "INSUFFICIENT_STOCK",
                            "product_id": product_id,
                            "available_stock": product["stock_level"] if product else 0,
                            "message": f"Some produce has sold out or changed quantity (product #{product_id}). Your cart was not submitted."
                        })
                        return
                    validated_items.append((product, quantity))

                # Server-authoritative price calculation: £0 hub / £15 direct delivery.
                # Compute from current database prices, not client-supplied totals.
                subtotal_pence = sum(
                    round(float(product["price"]) * 100) * quantity
                    for product, quantity in validated_items
                )
                delivery_pence = 1500 if delivery_method == "direct" else 0
                expected_total = (subtotal_pence + delivery_pence) / 100
                try:
                    provided_total = round(float(submitted_total), 2)
                except (TypeError, ValueError):
                    provided_total = None
                if provided_total != expected_total:
                    connection.rollback()
                    self.send_json_result(409, {
                        "code": "PRICE_CHANGED",
                        "message": "Prices have changed since you added these products. Review the updated cart before trying again."
                    })
                    return

                # step 2: SQL insert to create the master order record
                cursor.execute(
                    "INSERT INTO orders "
                    "(customer_id, total_price, delivery_method, collection_node_code, delivery_address_json) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (customer_id, expected_total, delivery_method, node_code, address_json)
                )
                # captures the new order id to use as the foreign key in order_items
                order_id = cursor.lastrowid

                # step 3: loops through the cart and inserts a line item row for each product
                for product, quantity in validated_items:
                    cursor.execute(
                        "INSERT INTO order_items "
                        "(order_id, product_id, quantity, producer_id, unit_price, product_name) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            order_id, product["product_id"], quantity,
                            product["producer_id"], product["price"],
                            product["product_name"],
                        ),
                    )
                    cursor.execute(
                        "UPDATE products SET stock_level = stock_level - ? "
                        "WHERE product_id = ? AND stock_level >= ?",
                        (quantity, product["product_id"], quantity),
                    )
                    if cursor.rowcount != 1:
                        connection.rollback()
                        self.send_json_result(409, {
                            "code": "INSUFFICIENT_STOCK",
                            "message": "Stock changed during checkout. Please review your cart."
                        })
                        return

                if checkout_key:
                    connection.execute(
                        "INSERT INTO checkout_requests (customer_id, checkout_key, order_id) "
                        "VALUES (?, ?, ?)", (customer_id, checkout_key, order_id)
                    )

                # commits all three operations at once
                connection.commit()
                print(f"TRANSACTION LOG: Order {order_id} successfully processed for Customer {customer_id}.")

                self.send_json_result(201, {"status": "success", "order_id": order_id})

            except (ValueError, json.JSONDecodeError, TypeError) as error:
                connection.rollback()
                self.send_json_result(400, {"message": "Invalid checkout request. Review the cart and try again."})
            except (sqlite3.Error, KeyError) as error:
                connection.rollback()
                print(f"CHECKOUT ERROR: {error}")
                self.send_json_result(500, {"message": "The order could not be recorded. Your cart is unchanged; please retry."})
            finally:
                # always closes the connection even if an exception was raised
                connection.close()

        # GDPR consent logging endpoint
        elif self.path == '/consent':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))

                token     = payload.get("token")
                # converts the boolean flags from the frontend to 1 or 0 for SQLite
                analytics = 1 if payload.get("analytics") else 0
                marketing = 1 if payload.get("marketing") else 0

                connection = get_db_connection()
                cursor = connection.cursor()

                # INSERT OR REPLACE updates an existing record if the token already exists
                cursor.execute("""
                    INSERT OR REPLACE INTO cookie_consent
                        (consent_token, strictly_necessary, analytics, marketing)
                    VALUES (?, 1, ?, ?)
                """, (token, analytics, marketing))
                connection.commit()
                connection.close()

                print(f"GDPR LOG: Consent token [{token}] recorded — analytics={analytics}, marketing={marketing}.")
                self.send_response(201)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

            except Exception as e:
                print(f"CONSENT ERROR: {e}")
                self.send_response(500)
                self.end_headers()

        else:
            print(f"SYSTEM ROUTING ERROR: Unhandled POST request directed to {self.path}")
            self.send_response(404)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

    def do_PUT(self):
        if not self._origin_allowed():
            self.send_json_result(403, {"message": "Cross-site requests are not permitted."})
            return
        if self.path.startswith("/producer/fulfil/"):
            connection = None
            try:
                item_id = int(self.path.split("/")[-1])
                if item_id <= 0:
                    self.send_json_result(400, {"message": "Invalid item ID."})
                    return
                connection = get_db_connection()
                producer_id = producer_from_request(connection, self.headers)
                if producer_id is None:
                    self.send_json_result(401, {
                        "message": "Producer session expired. Sign in again."
                    })
                    return
                if not fulfil_order_item(connection, producer_id, item_id):
                    self.send_json_result(404, {
                        "message": "Pending item not found for this producer."
                    })
                    return
                connection.commit()
                self.send_json_result(200, {"status": "success", "item_id": item_id})
            except ValueError:
                self.send_json_result(400, {"message": "Invalid item ID."})
            except Exception as error:
                print(f"FULFILMENT ERROR: {error}")
                if connection is not None:
                    connection.rollback()
                self.send_json_result(500, {"message": "Unable to update fulfilment."})
            finally:
                if connection is not None:
                    connection.close()
        elif re.fullmatch(r"/products/[0-9]+", urlsplit(self.path).path):
            connection = None
            try:
                product_id = int(urlsplit(self.path).path.split("/")[-1])
                if int(self.headers.get("Content-Length", 0)) > 16384:
                    self.send_json_result(413, {"message": "Product details are too large."})
                    return
                content_length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Enter valid product details.")
                name = payload.get("product_name")
                batch = payload.get("batch_number")
                allergen = payload.get("allergen_info")
                description = payload.get("product_description", "")
                harvest = payload.get("harvest_date") or None
                if any(not isinstance(x, str) for x in (name, batch, allergen, description)):
                    raise ValueError("Product details must contain text.")
                name, batch, allergen, description = (
                    name.strip(), batch.strip(), allergen.strip(), description.strip()
                )
                if not name or len(name) > 255:
                    raise ValueError("Enter a product name (maximum 255 characters).")
                if not batch or len(batch) > 100:
                    raise ValueError("Enter a batch reference (maximum 100 characters).")
                if not allergen or len(allergen) > 500:
                    raise ValueError("Declare allergens or select 'No Allergens Present'.")
                if len(description) > 1500:
                    raise ValueError("Description cannot exceed 1500 characters.")
                if harvest is not None:
                    if not isinstance(harvest, str):
                        raise ValueError("Harvest date is invalid.")
                    harvested = date.fromisoformat(harvest)
                    if harvested > date.today():
                        raise ValueError("Harvest date cannot be in the future.")
                raw_stock = payload.get("stock_level")
                if isinstance(raw_stock, bool) or not isinstance(raw_stock, int) or not 0 <= raw_stock <= 1000000:
                    raise ValueError("Stock must be a whole number from 0 to 1,000,000.")
                raw_price = payload.get("price")
                if isinstance(raw_price, bool):
                    raise ValueError("Price must be a valid GBP amount.")
                price = float(raw_price)
                if not math.isfinite(price) or price < 0 or price > 100000 or round(price, 2) != price:
                    raise ValueError("Price must be between £0 and £100,000 with at most two decimal places.")

                connection = get_db_connection()
                producer_id = producer_from_request(connection, self.headers)
                if producer_id is None:
                    self.send_json_result(401, {"message": "Producer session expired. Please sign in again."})
                    return
                connection.execute("BEGIN IMMEDIATE")
                owned = connection.execute(
                    "SELECT product_id FROM products WHERE product_id = ? AND producer_id = ?",
                    (product_id, producer_id)
                ).fetchone()
                if owned is None:
                    connection.rollback()
                    self.send_json_result(404, {"message": "This listing is not in your producer inventory."})
                    return
                collision = connection.execute(
                    "SELECT product_id FROM products WHERE batch_number = ? AND product_id != ? LIMIT 1",
                    (batch, product_id)
                ).fetchone()
                if collision:
                    connection.rollback()
                    self.send_json_result(409, {"message": "That batch reference is already in use."})
                    return
                connection.execute("""
                    UPDATE products
                    SET product_name = ?, batch_number = ?, price = ?,
                        stock_level = ?, allergen_info = ?, harvest_date = ?,
                        product_description = ?
                    WHERE product_id = ? AND producer_id = ?
                """, (name, batch, price, raw_stock, allergen, harvest, description, product_id, producer_id))
                connection.commit()
                self.send_json_result(200, {"status": "success", "message": "Product updated.", "product_id": product_id})
            except (ValueError, TypeError, json.JSONDecodeError):
                if connection is not None:
                    connection.rollback()
                self.send_json_result(400, {"message": "Please check the product name, stock, price, batch and allergen details."})
            except sqlite3.Error as error:
                print(f"PRODUCT UPDATE ERROR: {error}")
                if connection is not None:
                    connection.rollback()
                self.send_json_result(500, {"message": "Unable to save changes. Your original listing is intact."})
            finally:
                if connection is not None:
                    connection.close()
        elif self.path.startswith('/users/'):
            try:
                # extracts the user id from the URL
                user_id = int(self.path.split('/')[-1])
                content_length = int(self.headers.get('Content-Length', 0))
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))

                full_name    = payload.get("full_name")
                email        = payload.get("email")
                raw_password = payload.get("password")

                connection = get_db_connection()
                cursor = connection.cursor()
                if self.authenticated_user(connection) != user_id:
                    connection.close()
                    self.send_json_result(403, {"message": "Not authorised to update this account."})
                    return

                if raw_password:
                    # converts the new password into a hash before updating the record
                    hashed_pw = hash_password(raw_password)
                    # SQL update statement that includes the new password hash
                    cursor.execute(
                        "UPDATE users SET full_name=?, email=?, password_hash=? WHERE user_id=?",
                        (full_name, email, hashed_pw, user_id)
                    )
                else:
                    # SQL update that leaves the password hash unchanged
                    cursor.execute(
                        "UPDATE users SET full_name=?, email=? WHERE user_id=?",
                        (full_name, email, user_id)
                    )

                connection.commit()
                connection.close()

                print(f"PROFILE UPDATE LOG: User ID {user_id} details updated.")
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success",
                    "full_name": full_name,
                    "email": email
                }).encode('utf-8'))

            except Exception as e:
                print(f"PROFILE UPDATE ERROR: {e}")
                self.send_response(500)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        if not self._origin_allowed():
            self.send_json_result(403, {"message": "Cross-site requests are not permitted."})
            return
        if self.path.startswith('/products/'):
            connection = None
            try:
                product_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                producer_id = producer_from_request(connection, self.headers)
                if producer_id is None:
                    self.send_json_result(401, {"message": "Producer sign-in required."})
                    return
                changed = connection.execute(
                    "DELETE FROM products WHERE product_id = ? AND producer_id = ?",
                    (product_id, producer_id)
                )
                connection.commit()
                if changed.rowcount == 0:
                    self.send_json_result(404, {
                        "message": "Product was not found in your inventory."
                    })
                else:
                    self.send_json_result(200, {"status": "success"})
            except ValueError:
                self.send_json_result(400, {"message": "Invalid product ID."})
            except sqlite3.Error as error:
                print(f"PRODUCT DELETE ERROR: {error}")
                self.send_json_result(500, {"message": "Could not remove this product."})
            finally:
                if connection is not None:
                    connection.close()

        elif self.path.startswith('/users/'):
            try:
                user_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()
                if self.authenticated_user(connection) != user_id:
                    connection.close()
                    self.send_json_result(403, {"message": "Not authorised to delete this account."})
                    return
                # Prevent orphaned order history; accounts with orders need review.
                owns_orders = connection.execute(
                    "SELECT 1 FROM orders WHERE customer_id = ? LIMIT 1", (user_id,)
                ).fetchone()
                if owns_orders:
                    connection.close()
                    self.send_json_result(409, {
                        "message": "Accounts with order history cannot be deleted through this demo."
                    })
                    return
                # deletes the producers products first to satisfy the foreign key constraint
                cursor.execute("DELETE FROM products WHERE producer_id = ?", (user_id,))
                # then removes the user account itself
                cursor.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
                connection.commit()
                connection.close()

                print(f"ACCOUNT DELETION LOG: User ID {user_id} and associated data purged.")
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            except Exception as e:
                print(f"ACCOUNT DELETION ERROR: {e}")
                self.send_response(500)
                self.end_headers()


if __name__ == "__main__":
    # Local development server: do not expose sign-in and account APIs on the LAN.
    server_address = ('127.0.0.1', PORT)
    httpd = HTTPServer(server_address, NativeAPIHandler)
    print(f"SYSTEM LOG: GLH // CO-OP Native API initialized at http://127.0.0.1:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nSYSTEM LOG: Shutdown signal received. Closing server.")
        httpd.server_close()
