import sqlite3

print("SYSTEM LOG: Initializing Sprint 2 Schema Migration...")

conn = sqlite3.connect("glh_coop.db")
cursor = conn.cursor()

# Master Order Receipt Table
cursor.execute('''
    CREATE TABLE IF NOT EXISTS orders (
        order_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        order_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_price REAL NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES users (user_id)
    )
''')

# Order Items Line-Item Table
cursor.execute('''
    CREATE TABLE IF NOT EXISTS order_items (
        item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders (order_id),
        FOREIGN KEY (product_id) REFERENCES products (product_id)
    )
''')

conn.commit()
conn.close()
print("SYSTEM LOG: Migration Successful. Transactional tables are live.")