import sqlite3

def setup_database():
    # Connect to the database (creates the file if it doesn't exist)
    connection = sqlite3.connect("glh_coop.db")
    cursor = connection.cursor()

    # 1. USERS TABLE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'customer'
    )
    """)

    # 2. FARMS TABLE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS farms (
        farm_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        farm_name VARCHAR(255) NOT NULL,
        hygiene_rating INTEGER NOT NULL,
        farm_story VARCHAR(1000),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
    """)

    # 3. PRODUCTS TABLE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS products (
        product_id INTEGER PRIMARY KEY AUTOINCREMENT,
        producer_id INTEGER NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        price DOUBLE(10,2) NOT NULL,
        stock_level INTEGER NOT NULL,
        allergen_info VARCHAR(500) NOT NULL,
        batch_number VARCHAR(100) NOT NULL,
        harvest_date TEXT,
        safety_clearance TEXT,
        FOREIGN KEY (producer_id) REFERENCES users(user_id)
    )
    """)

    # 4. ORDERS TABLE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS orders (
        order_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        order_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        collection_slot DATETIME NOT NULL,
        total_price DOUBLE(10,2) NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES users(user_id)
    )
    """)

    # 5. ORDER_ITEMS TABLE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS order_items (
        item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(order_id),
        FOREIGN KEY (product_id) REFERENCES products(product_id)
    )
    """)

    # --- INJECT SEED DATA FOR TESTING ---
    # Adding a test producer
    cursor.execute("""
    INSERT OR IGNORE INTO users (user_id, full_name, email, password_hash, role) 
    VALUES (1, 'John Oakhaven', 'producer@glh.com', 'hashed_pass_123', 'producer')
    """)

    # Adding a test farm for the producer
    cursor.execute("""
    INSERT OR IGNORE INTO farms (farm_id, user_id, farm_name, hygiene_rating, farm_story) 
    VALUES (1, 1, 'Oakhaven Farms', 5, 'Local organic farm dedicated to community health.')
    """)

    # Adding some test products
    baseline_stock = [
        (1, 1, "Heirloom Carrots", 4.50, 450, "None", "BATCH-2026-A1"),
        (2, 1, "Swiss Chard", 3.00, 120, "None", "BATCH-2026-A2"),
        (3, 1, "Pasture Eggs", 7.50, 0, "Eggs", "BATCH-2026-B1"),
        (4, 1, "Raw Honey", 18.00, 42, "None", "BATCH-2026-C1")
    ]
    
    cursor.executemany("""
    INSERT OR IGNORE INTO products (product_id, producer_id, product_name, price, stock_level, allergen_info, batch_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """, baseline_stock)

    # Save and close
    connection.commit()
    connection.close()
    print("Database built successfully. All 5 tables match the GLH Proposal ERD.")

if __name__ == "__main__":
    setup_database()