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
                safety_clearance TEXT
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
             origin=None, raw_body=None, content_type="application/json"):
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

    def test_checkout_requires_customer_and_rejects_duplicate_items(self):
        payload = {
            "customer_id": 4, "delivery_method": "hub",
            "collection_node_code": "ND-01", "total_price": 6,
            "cart": [{"product_id": 11, "quantity": 2}],
        }
        self.assertEqual(self.send("POST", "/checkout", payload=payload)[0], 401)
        self.assertEqual(
            self.send("POST", "/checkout", payload=payload, session_role="producer", user_id=2)[0], 401
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
