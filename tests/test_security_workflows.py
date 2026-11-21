"""Run with: python3 -m unittest discover -s tests -v

These tests use a temporary SQLite database and ephemeral local HTTP server.
They never modify the project's glh_coop.db.
"""
import hashlib
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api_app"))
import api_app
from producer_metrics import issue_producer_token
from password_security import hash_password, verify_password


class SecurityWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "tests.db")
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE users (
                user_id INTEGER PRIMARY KEY,
                full_name TEXT,
                email TEXT UNIQUE,
                password_hash TEXT,
                role TEXT
            );
            CREATE TABLE products (
                product_id INTEGER PRIMARY KEY,
                producer_id INTEGER,
                product_name TEXT,
                price REAL,
                stock_level INTEGER,
                allergen_info TEXT,
                batch_number TEXT,
                product_image TEXT,
                harvest_date TEXT,
                safety_clearance TEXT,
                product_description TEXT
            );
            CREATE TABLE orders (
                order_id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER,
                order_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_price REAL,
                delivery_method TEXT,
                collection_node_code TEXT,
                delivery_address_json TEXT
            );
            CREATE TABLE checkout_requests (
                customer_id INTEGER NOT NULL,
                checkout_key TEXT NOT NULL,
                order_id INTEGER NOT NULL,
                PRIMARY KEY (customer_id, checkout_key)
            );
            CREATE TABLE order_items (
                item_id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER,
                product_id INTEGER,
                quantity INTEGER,
                producer_id INTEGER,
                unit_price REAL,
                product_name TEXT,
                fulfilled_at TEXT
            );
        """)
        sha = lambda pw: hashlib.sha256(pw.encode()).hexdigest()
        conn.executemany(
            "INSERT INTO users VALUES (?, ?, ?, ?, ?)",
            [
                (1, "Test Customer", "customer@glh.test", sha("secure123"), "customer"),
                (2, "Producer A", "producer-a@glh.test", sha("secure123"), "producer"),
                (3, "Producer B", "producer-b@glh.test", sha("secure123"), "producer"),
                (4, "Other Customer", "other@glh.test", sha("secure123"), "customer"),
            ],
        )
        conn.executemany(
            "INSERT INTO products (product_id, producer_id, product_name, price, stock_level, allergen_info, batch_number, product_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (11, 2, "Carrots", 3.00, 10, "None", "A11", "carrots.jpg"),
                (12, 3, "Beans", 5.00, 10, "None", "B12", "beans.jpg"),
            ],
        )
        conn.commit()
        conn.close()

        self.original_get_db_connection = api_app.get_db_connection

        def get_test_connection():
            db = sqlite3.connect(self.db_path)
            db.row_factory = sqlite3.Row
            return db

        api_app.get_db_connection = get_test_connection
        self.httpd = api_app.HTTPServer(("127.0.0.1", 0), api_app.NativeAPIHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        api_app.get_db_connection = self.original_get_db_connection
        self.tmp.cleanup()

    def query(self, sql, args=()):
        with sqlite3.connect(self.db_path) as conn:
            return conn.execute(sql, args).fetchone()

    def send(self, method, path, payload=None, session_role=None, user_id=1,
             origin=None, raw_body=None, content_type="application/json",
             cookie_header=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        headers = {}
        body = raw_body
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        if body is not None:
            headers["Content-Type"] = content_type
        if session_role:
            name = "glh_customer_session" if session_role == "customer" else "glh_producer_session"
            headers["Cookie"] = name + "=" + issue_producer_token(user_id)
        if cookie_header:
            headers["Cookie"] = cookie_header
        if origin:
            headers["Origin"] = origin
        request = Request(url, data=body, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            result = json.loads(raw) if raw else {}
            return response.status, result, response.headers

    def test_passwords_are_salted_and_legacy_hashes_supported(self):
        password = hash_password("secure123")
        self.assertTrue(verify_password("secure123", password))
        self.assertFalse(verify_password("incorrect", password))
        self.assertNotEqual(password, hash_password("secure123"))
        legacy = hashlib.sha256(b"secure123").hexdigest()
        self.assertTrue(verify_password("secure123", legacy))

    def test_login_upgrades_legacy_password_and_sets_http_only_cookie(self):
        status, body, headers = self.send("POST", "/login", payload={
            "email": "customer@glh.test",
            "password": "secure123",
            "requested_node": "customer",
        })
        self.assertEqual(status, 200, body)
        self.assertIn("HttpOnly", headers.get("Set-Cookie", ""))
        stored = self.query("SELECT password_hash FROM users WHERE user_id = 1")[0]
        self.assertTrue(stored.startswith("pbkdf2_sha256$"))

    def test_public_registration_cannot_create_producers(self):
        status, _, _ = self.send("POST", "/register", payload={
            "full_name": "Intruder", "email": "intruder@glh.test",
            "password": "secure123", "role": "producer",
        })
        self.assertEqual(status, 403)
        self.assertEqual(self.query("SELECT count(*) FROM users")[0], 4)

    def test_customer_registration_validates_and_handles_duplicates(self):
        payload = {
            "full_name": "New Member",
            "email": "new-member@glh.test",
            "password": "strong-password-123",
            "role": "customer",
        }
        status, body, _ = self.send("POST", "/register", payload=payload)
        self.assertEqual(status, 201, body)
        self.assertEqual(body.get("status"), "success")
        self.assertEqual(
            self.query("SELECT role FROM users WHERE email = ?", (payload["email"],))[0],
            "customer",
        )
        self.assertTrue(self.query(
            "SELECT password_hash FROM users WHERE email = ?", (payload["email"],)
        )[0].startswith("pbkdf2_sha256$"))
        self.assertEqual(self.send("POST", "/register", payload=payload)[0], 409)
        self.assertEqual(self.send("POST", "/register", payload={
            **payload, "email": "short-password@glh.test", "password": "123"
        })[0], 400)

    def test_signed_session_and_order_history_require_matching_identity(self):
        self.assertEqual(self.send("GET", "/session")[0], 401)
        code, current_user, _ = self.send("GET", "/session", session_role="customer", user_id=1)
        self.assertEqual(code, 200)
        self.assertEqual(current_user["user_id"], 1)
        self.assertEqual(current_user["role"], "customer")
        code, producer, _ = self.send("GET", "/session", session_role="producer", user_id=2)
        self.assertEqual(code, 200)
        self.assertEqual(producer["role"], "producer")
        self.assertEqual(
            self.send("GET", "/orders/4", session_role="customer", user_id=1)[0], 403
        )
        code, orders, _ = self.send("GET", "/orders/1", session_role="customer", user_id=1)
        self.assertEqual(code, 200)
        self.assertEqual(orders, [])

    def test_producer_login_can_switch_nodes_and_complete_checkout(self):
        """The exact same cookie works at both producer and customer nodes."""
        payload = {
            "delivery_method": "hub", "collection_node_code": "ND-01",
            "total_price": 6,
            "checkout_key": "producer-customer-node-001",
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        for requested_node in ("producer", "customer"):
            # Exercise a real HTTP login, not only a synthesised test token.
            status, login, headers = self.send("POST", "/login", payload={
                "email": "producer-a@glh.test",
                "password": "secure123",
                "requested_node": requested_node,
            })
            self.assertEqual(status, 200, login)
            self.assertEqual(login["role"], "producer")
            self.assertEqual(
                login["redirect_url"],
                "producer-portal.html" if requested_node == "producer" else "customer-portal.html"
            )
            issued = headers.get_all("Set-Cookie", [])
            cookie = next(
                value.split(";", 1)[0]
                for value in issued
                if value.startswith("glh_producer_session=")
            )
            session_status, session, _ = self.send(
                "GET", "/session", cookie_header=cookie
            )
            self.assertEqual(session_status, 200, session)
            self.assertEqual((session["user_id"], session["role"]), (2, "producer"))

            # Producers retain their dashboard access while shopping.
            self.assertEqual(
                self.send("GET", "/producer/dashboard", cookie_header=cookie)[0], 200
            )
            self.assertEqual(
                self.send("GET", "/orders/2", cookie_header=cookie)[0], 200
            )
            self.assertEqual(
                self.send("GET", "/orders/1", cookie_header=cookie)[0], 403
            )
            self.assertEqual(
                self.send("GET", "/orders/3", cookie_header=cookie)[0], 403
            )

            # Both entry points share an identity and must not bypass ownership.
            result_status, created, _ = self.send(
                "POST", "/checkout", payload={
                    **payload, "checkout_key": "producer-shopping-" + requested_node
                }, cookie_header=cookie
            )
            self.assertEqual(result_status, 201, created)
            self.assertEqual(
                self.query(
                    "SELECT customer_id FROM orders WHERE order_id = ?",
                    (created["order_id"],)
                )[0], 2
            )
            history_status, history, _ = self.send(
                "GET", "/orders/2", cookie_header=cookie
            )
            self.assertEqual(history_status, 200, history)
            self.assertTrue(any(row["order_id"] == created["order_id"] for row in history))
            self.assertEqual(
                self.send(
                    "GET", f"/orders/{created['order_id']}/confirmation",
                    cookie_header=cookie
                )[0], 200
            )
            self.assertEqual(
                self.send("GET", "/producer/dashboard", cookie_header=cookie)[0], 200
            )

    def test_customer_sessions_never_gain_producer_dashboard_access(self):
        self.assertEqual(
            self.send("GET", "/producer/dashboard", session_role="customer", user_id=1)[0],
            401
        )
        self.assertEqual(
            self.send("GET", "/orders/2", session_role="customer", user_id=1)[0],
            403
        )

    def test_checkout_requires_signed_member_and_rejects_duplicate_items(self):
        payload = {
            "customer_id": 4, "delivery_method": "hub",
            "collection_node_code": "ND-01", "total_price": 6,
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        self.assertEqual(self.send("POST", "/checkout", payload=payload)[0], 401)
        # A producer account is also a valid shopping member.
        self.assertEqual(
            self.send("POST", "/checkout", payload=payload, session_role="producer", user_id=2)[0], 201
        )
        duplicate = {**payload, "cart": [
            {"product_id": 11, "quantity": 2},
            {"product_id": 11, "quantity": 2},
        ]}
        self.assertEqual(
            self.send("POST", "/checkout", payload=duplicate, session_role="customer")[0], 400
        )

    def test_checkout_uses_signed_customer_identity_and_stores_delivery(self):
        payload = {
            "customer_id": 4,  # spoofed: API must ignore this
            "delivery_method": "direct",
            "delivery_address": {
                "line1": "12 Example Lane", "line2": "",
                "town": "Liverpool", "postcode": "L1 1AA",
                "country": "United Kingdom"
            },
            "total_price": 21,
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        status, body, _ = self.send("POST", "/checkout", payload=payload, session_role="customer")
        self.assertEqual(status, 201, body)
        order_id = body["order_id"]
        customer_id, total, method = self.query(
            "SELECT customer_id, total_price, delivery_method FROM orders WHERE order_id = ?",
            (order_id,),
        )
        self.assertEqual((customer_id, total, method), (1, 21, "direct"))
        status, receipt, _ = self.send(
            "GET", f"/orders/{order_id}/confirmation",
            session_role="customer",
        )
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["delivery_address"]["town"], "Liverpool")
        self.assertEqual(receipt["payment_status"], "NOT_PROCESSED")
        self.assertEqual(receipt["items"][0]["product_name"], "Carrots")
        self.assertEqual(receipt["delivery_fee"], 15)
        self.assertEqual(
            self.send("GET", f"/orders/{order_id}/confirmation",
                      session_role="customer", user_id=4)[0], 404
        )

    def test_checkout_retry_returns_same_order_without_reducing_stock_twice(self):
        payload = {
            "delivery_method": "hub", "collection_node_code": "ND-01",
            "total_price": 6, "checkout_key": "retry-key-12345",
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        first_status, first, _ = self.send(
            "POST", "/checkout", payload=payload, session_role="customer"
        )
        self.assertEqual(first_status, 201, first)
        retry_status, second, _ = self.send(
            "POST", "/checkout", payload=payload, session_role="customer"
        )
        self.assertEqual(retry_status, 200, second)
        self.assertEqual(second["order_id"], first["order_id"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(self.query("SELECT COUNT(*) FROM orders")[0], 1)
        self.assertEqual(self.query("SELECT COUNT(*) FROM order_items")[0], 1)
        self.assertEqual(self.query("SELECT stock_level FROM products WHERE product_id = 11")[0], 8)
        self.assertEqual(self.query("SELECT COUNT(*) FROM checkout_requests")[0], 1)
        receipt_status, receipt, _ = self.send(
            "GET", "/checkout/status?key=retry-key-12345", session_role="customer"
        )
        self.assertEqual(receipt_status, 200, receipt)
        self.assertEqual(receipt["order_id"], first["order_id"])
        self.assertEqual(
            self.send("GET", "/checkout/status?key=retry-key-12345",
                      session_role="customer", user_id=4)[0], 404
        )
        self.assertEqual(
            self.send("GET", "/checkout/status?key=retry-key-12345")[0], 401
        )

    def test_unrecorded_checkout_key_does_not_report_an_order(self):
        status, result, _ = self.send(
            "GET", "/checkout/status?key=not-recorded-12345", session_role="customer"
        )
        self.assertEqual(status, 404, result)

    def test_checkout_stale_stock_is_rejected_without_new_order(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE products SET stock_level = 1 WHERE product_id = 11")
        payload = {
            "delivery_method": "hub", "collection_node_code": "ND-01",
            "total_price": 6, "checkout_key": "out-of-stock-123",
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        status, response, _ = self.send(
            "POST", "/checkout", payload=payload, session_role="customer"
        )
        self.assertEqual(status, 409, response)
        self.assertEqual(response["code"], "INSUFFICIENT_STOCK")
        self.assertEqual(response["available_stock"], 1)
        self.assertEqual(self.query("SELECT COUNT(*) FROM orders")[0], 0)
        self.assertEqual(self.query("SELECT stock_level FROM products WHERE product_id = 11")[0], 1)

    def test_checkout_stale_price_preserves_stock(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE products SET price = 3.50 WHERE product_id = 11")
        payload = {
            "delivery_method": "hub", "collection_node_code": "ND-01",
            "total_price": 6, "checkout_key": "price-conflict-123",
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        status, response, _ = self.send(
            "POST", "/checkout", payload=payload, session_role="customer"
        )
        self.assertEqual(status, 409, response)
        self.assertEqual(response["code"], "PRICE_CHANGED")
        self.assertEqual(self.query("SELECT COUNT(*) FROM orders")[0], 0)
        self.assertEqual(self.query("SELECT stock_level FROM products WHERE product_id = 11")[0], 10)

    def test_product_edit_requires_ownership_and_validates_fields(self):
        payload = {
            "product_name": "Heritage Carrots", "batch_number": "A11",
            "price": 3.75, "stock_level": 7, "harvest_date": None,
            "product_description": "Harvested locally in autumn.",
            "allergen_info": "No Allergens Present",
        }
        self.assertEqual(self.send("PUT", "/products/11", payload=payload)[0], 401)
        self.assertEqual(
            self.send("PUT", "/products/12", payload=payload,
                      session_role="producer", user_id=2)[0], 404
        )
        status, response, _ = self.send(
            "PUT", "/products/11", payload=payload,
            session_role="producer", user_id=2
        )
        self.assertEqual(status, 200, response)
        self.assertEqual(
            self.query("SELECT product_name, price, stock_level, product_description FROM products WHERE product_id = 11"),
            ("Heritage Carrots", 3.75, 7, "Harvested locally in autumn."),
        )
        invalid = {**payload, "stock_level": -1}
        self.assertEqual(
            self.send("PUT", "/products/11", payload=invalid,
                      session_role="producer", user_id=2)[0], 400
        )
        collision = {**payload, "batch_number": "B12"}
        self.assertEqual(
            self.send("PUT", "/products/11", payload=collision,
                      session_role="producer", user_id=2)[0], 409
        )
        self.assertEqual(self.query("SELECT batch_number FROM products WHERE product_id = 11")[0], "A11")

    def test_edit_does_not_rewrite_existing_order_price(self):
        order = {
            "delivery_method": "hub", "collection_node_code": "ND-01",
            "total_price": 6, "checkout_key": "preserve-order-price-01",
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        status, created, _ = self.send(
            "POST", "/checkout", payload=order, session_role="customer"
        )
        self.assertEqual(status, 201, created)
        update = {
            "product_name": "Newly Named Carrots", "batch_number": "A11",
            "price": 4, "stock_level": 12, "harvest_date": None,
            "product_description": "A product description.", "allergen_info": "None",
        }
        self.assertEqual(
            self.send("PUT", "/products/11", payload=update,
                      session_role="producer", user_id=2)[0], 200
        )
        status, receipt, _ = self.send(
            "GET", f"/orders/{created['order_id']}/confirmation", session_role="customer"
        )
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["items"][0]["product_name"], "Carrots")
        self.assertEqual(receipt["items"][0]["unit_price"], 3.00)

    def test_product_deletion_requires_producer_and_ownership(self):
        self.assertEqual(self.send("DELETE", "/products/11")[0], 401)
        self.assertEqual(
            self.send("DELETE", "/products/12", session_role="producer", user_id=2)[0], 404
        )
        self.assertEqual(self.query("SELECT count(*) FROM products")[0], 2)
        self.assertEqual(
            self.send("DELETE", "/products/11", session_role="producer", user_id=2)[0], 200
        )
        self.assertEqual(self.query("SELECT count(*) FROM products")[0], 1)

    def test_cross_origin_write_is_rejected(self):
        status, _, _ = self.send("POST", "/login", payload={
            "email": "customer@glh.test", "password": "secure123",
            "requested_node": "customer",
        }, origin="https://untrusted.example")
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
