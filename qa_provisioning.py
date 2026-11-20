import sqlite3
import hashlib
import os

DB_PATH = "glh_coop.db"

def rebuild_master_ledger():
    print("SYSTEM LOG: Commencing Master Re-Initialization...")

    # Step 1: Purge existing ledger for a clean slate
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        print("SYSTEM LOG: Legacy database purged.")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # --- IDENTITY & ACCESS SCHEMA ---
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'customer',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # --- INVENTORY SCHEMA ---
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS products (
            product_id INTEGER PRIMARY KEY AUTOINCREMENT,
            producer_id INTEGER NOT NULL,
            product_name TEXT NOT NULL,
            price REAL NOT NULL,
            stock_level INTEGER NOT NULL,
            allergen_info TEXT NOT NULL,
            batch_number TEXT NOT NULL,
            product_image TEXT,
            FOREIGN KEY (producer_id) REFERENCES users (user_id)
        )
    ''')

    # format: (Full Name, Email, Raw Password, Role)
    producer_roster = [
        ("Original Test Producer", "farm@glhcoop.com", "secure123", "producer"),
        ("Marcus Thorne", "marcus@glh.com", "secure123", "producer"),
        ("Elena Rostova", "elena@glh.com", "secure123", "producer"),
        ("David MacAulay", "david@glh.com", "secure123", "producer"),
        ("Chloe Vance", "chloe@glh.com", "secure123", "producer"),
        ("Arthur Pendelton", "arthur@glh.com", "secure123", "producer"),
        ("Sarah Jenkins", "sarah@glh.com", "secure123", "producer")
    ]

    print("SYSTEM LOG: Injecting Producer Roster...")
    for name, email, pw, role in producer_roster:
        h_pw = hashlib.sha256(pw.encode()).hexdigest()
        cursor.execute("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)",
                       (name, email, h_pw, role))

    # --- DATA PAYLOAD: BASELINE INVENTORY ---
    # Bound to Producer ID 1 (Original Test Producer)
    baseline_inventory = [
        (1, "Heirloom Carrots", 4.50, 450, "No Allergens Present", "BATCH-2026-A1", "placeholder.png"),
        (1, "Swiss Chard", 3.00, 120, "No Allergens Present", "BATCH-2026-A2", "placeholder.png"),
        (1, "Pasture Eggs", 7.50, 0, "Eggs", "BATCH-2026-B1", "placeholder.png"),
        (1, "Raw Honey", 18.00, 42, "No Allergens Present", "BATCH-2026-C1", "placeholder.png")
    ]

    cursor.executemany('''
        INSERT INTO products (
            producer_id, product_name, price, stock_level, allergen_info, batch_number, product_image
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', baseline_inventory)

    conn.commit()
    conn.close()
    print(f"SYSTEM LOG: Master Reset Complete. 7 Producers and 4 Products live.")

if __name__ == "__main__":
    rebuild_master_ledger()