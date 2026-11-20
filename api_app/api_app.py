import json
import sqlite3
import hashlib
import os
from http.server import SimpleHTTPRequestHandler, HTTPServer
from email.parser import BytesParser

PORT = 8000
FRONTEND_DIR = "frontend"
ASSET_DIR = os.path.join(FRONTEND_DIR, "assets")

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
        INSERT INTO products (producer_id, product_name, price, stock_level, allergen_info, batch_number, product_image)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        # binds each value to its paramterised placeholder
        data.get("producer_id"),
        data.get("product_name"),
        data.get("price"),
        data.get("stock_level"),
        data.get("allergen_info"),
        data.get("batch_number"),
        data.get("product_image")
    ))
    connection.commit()
    connection.close()
    print(f"CORE LOG: Asset {data.get('product_name')} successfully committed to ledger.")


class NativeAPIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # tells the server to serve files from the frontend folder
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def do_OPTIONS(self):
        # handles the CORS pre-flight request so the browser allows cross-origin calls
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/products' or self.path.startswith('/products?'):
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

                # SQL select to fetch a single users public profile
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

        elif self.path.startswith('/orders/'):
            try:
                # pulls the customer id from the URL to filter their orders
                customer_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()

                # joins orders to order_items to get the item count per order, newest first
                cursor.execute("""
                    SELECT o.order_id, o.order_time, o.total_price,
                           COUNT(oi.item_id) as item_count
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
                role = payload.get("role", "customer")

                # converts the password into a SHA256 hash before storing it
                hashed_pw = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()

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

                # hashes the input to compare against the stored hash
                hashed_pw = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()

                connection = get_db_connection()
                cursor = connection.cursor()
                # SQL select checks the email and hashed password both match
                cursor.execute("SELECT user_id, full_name, role FROM users WHERE email = ? AND password_hash = ?", (email, hashed_pw))
                user = cursor.fetchone()
                connection.close()

                if user:
                    role = user["role"]

                    # blocks a customer account from accessing the producer terminal
                    if requested_node == "producer" and role == "customer":
                        print(f"SECURITY ALERT: Hard bounce. Customer identity [{email}] attempted access via Producer Terminal.")
                        self.send_response(403)
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('Content-type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "error", "message": "Clearance denied. Producer privileges required."}).encode('utf-8'))
                        return

                    # sends the user to the correct portal based on which terminal they logged in through
                    if requested_node == "customer":
                        target_node = "customer-portal.html"
                    else:
                        target_node = "producer-portal.html" if role == "producer" else "customer-portal.html"

                    print(f"SECURITY LOG: Authentication successful for [{email}]. Node assignment: {role.upper()}.")
                    self.send_response(200)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "status": "success",
                        "role": role,
                        "user_id": user["user_id"],
                        "full_name": user["full_name"],
                        "redirect_url": target_node
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
            try:
                content_type = self.headers.get('Content-Type')
                content_length = int(self.headers.get('Content-Length'))
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
                            image_filename = os.path.basename(filename)
                            save_path = os.path.join(ASSET_DIR, image_filename)
                            with open(save_path, 'wb') as f:
                                f.write(part.get_payload(decode=True))
                    else:
                        # decodes all other text fields into the data dict
                        data[field_name] = part.get_payload(decode=True).decode('utf-8')

                producer_id_raw = data.get("producer_id", 1)

                # casts each field to the correct type before inserting
                final_payload = {
                    "producer_id": int(producer_id_raw),
                    "batch_number": data.get("batch_number"),
                    "product_name": data.get("product_name"),
                    "stock_level": int(data.get("stock_level", 0)),
                    "price": float(data.get("price", 0.0)),
                    "allergen_info": data.get("allergen_info"),
                    "product_image": image_filename
                }

                insert_inventory(final_payload)

                self.send_response(201)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

            except Exception as e:
                print(f"SYSTEM ERROR: Post-ingestion failure. {e}")
                self.send_response(500)
                self.end_headers()

        # atomic checkout endpoint
        elif self.path == '/checkout':
            connection = get_db_connection()
            cursor = connection.cursor()
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))

                customer_id = payload.get("customer_id")
                cart_items = payload.get("cart", [])
                total_price = payload.get("total_price", 0.0)

                # wraps all three write operations in a single transaction
                connection.execute("BEGIN TRANSACTION")

                # step 1: checks stock levels before writing anything to the database
                for item in cart_items:
                    cursor.execute("SELECT stock_level FROM products WHERE product_id = ?", (item['product_id'],))
                    row = cursor.fetchone()
                    if not row or row["stock_level"] < item['quantity']:
                        # rolls back and rejects if any item doesnt have enough stock
                        connection.rollback()
                        self.send_response(400)
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('Content-type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "error", "message": f"Insufficient stock for {item['product_name']}"}).encode('utf-8'))
                        return

                # step 2: SQL insert to create the master order record
                cursor.execute("INSERT INTO orders (customer_id, total_price) VALUES (?, ?)", (customer_id, total_price))
                # captures the new order id to use as the foreign key in order_items
                order_id = cursor.lastrowid

                # step 3: loops through the cart and inserts a line item row for each product
                for item in cart_items:
                    cursor.execute("INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)",
                                   (order_id, item['product_id'], item['quantity']))

                    # SQL update decrements the stock level using a relative calculation
                    cursor.execute("UPDATE products SET stock_level = stock_level - ? WHERE product_id = ?",
                                   (item['quantity'], item['product_id']))

                # commits all three operations at once
                connection.commit()
                print(f"TRANSACTION LOG: Order {order_id} successfully processed for Customer {customer_id}.")

                self.send_response(201)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "order_id": order_id}).encode('utf-8'))

            except Exception as e:
                # if anything fails all three SQL operations are rolled back together
                connection.rollback()
                print(f"TRANSACTION HALTED: Critical failure during checkout. {e}")
                self.send_response(500)
                self.end_headers()
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
        if self.path.startswith('/users/'):
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

                if raw_password:
                    # converts the new password into a hash before updating the record
                    hashed_pw = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()
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
        if self.path.startswith('/products/'):
            try:
                # pulls the product id out of the URL
                product_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()
                # SQL delete statement to remove the product record
                cursor.execute("DELETE FROM products WHERE product_id = ?", (product_id,))
                connection.commit()
                connection.close()

                print(f"DELETION LOG: ID {product_id} purged from SQLite.")
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
            except Exception as e:
                print(f"DELETION ERROR: {e}")
                self.send_response(500)
                self.end_headers()

        elif self.path.startswith('/users/'):
            try:
                user_id = int(self.path.split('/')[-1])
                connection = get_db_connection()
                cursor = connection.cursor()
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
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, NativeAPIHandler)
    print(f"SYSTEM LOG: GLH // CO-OP Native API initialized at http://127.0.0.1:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nSYSTEM LOG: Shutdown signal received. Closing server.")
        httpd.server_close()
