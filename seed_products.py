import sqlite3, hashlib, os, shutil

DB = os.path.join(os.path.dirname(__file__), "glh_coop.db")

# delete old db
if os.path.exists(DB):
    os.remove(DB)
    print("Old database deleted")

conn = sqlite3.connect(DB)
conn.executescript("""
CREATE TABLE users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
    product_id INTEGER PRIMARY KEY AUTOINCREMENT,
    producer_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    price REAL NOT NULL,
    stock_level INTEGER NOT NULL DEFAULT 0,
    allergen_info TEXT,
    batch_number TEXT,
    product_image TEXT DEFAULT 'placeholder.png',
    harvest_date TEXT DEFAULT NULL,
    safety_clearance TEXT DEFAULT NULL,
    product_description TEXT DEFAULT NULL,
    FOREIGN KEY (producer_id) REFERENCES users(user_id)
);
CREATE TABLE orders (
    order_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_price REAL NOT NULL,
    delivery_method TEXT,
    collection_node_code TEXT,
    delivery_address_json TEXT,
    FOREIGN KEY (customer_id) REFERENCES users(user_id)
);
CREATE TABLE order_items (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    producer_id INTEGER,
    unit_price REAL,
    product_name TEXT,
    fulfilled_at TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (product_id) REFERENCES products(product_id)
);
CREATE TABLE checkout_requests (
    customer_id INTEGER NOT NULL,
    checkout_key TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (customer_id, checkout_key)
);
CREATE TABLE cookie_consent (
    consent_id INTEGER PRIMARY KEY AUTOINCREMENT,
    consent_token TEXT NOT NULL UNIQUE,
    strictly_necessary INTEGER DEFAULT 1,
    analytics INTEGER DEFAULT 0,
    marketing INTEGER DEFAULT 0,
    consented_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
""")

def h(p): return hashlib.sha256(p.encode()).hexdigest()

# producers: (name, email, password)
producers = [
    ("Marcus Thorne",   "marcus@glh.com",  "secure123"),
    ("Elena Rostova",   "elena@glh.com",   "secure123"),
    ("David MacAulay",  "david@glh.com",   "secure123"),
    ("Chloe Vance",     "chloe@glh.com",   "secure123"),
    ("Arthur Pendelton","arthur@glh.com",  "secure123"),
    ("Sarah Jenkins",   "sarah@glh.com",   "secure123"),
]

ids = {}
for name, email, pw in producers:
    cur = conn.execute(
        "INSERT INTO users (full_name, email, password_hash, role) VALUES (?,?,?,?)",
        (name, email, h(pw), "producer")
    )
    ids[name] = cur.lastrowid
    print(f"Producer: {name} → id {ids[name]}")

# also add a test customer
conn.execute(
    "INSERT INTO users (full_name, email, password_hash, role) VALUES (?,?,?,?)",
    ("Test Customer", "test@glhcoop.com", h("secure123"), "customer")
)

# products: (producer_name, product_name, price, stock, allergen, batch, image)
products = [
    # Marcus Thorne (MT)
    ("Marcus Thorne",   "Chantenay Carrots",    6.50, 200, "No Allergens Present", "MT-26-A1", "chantenaycarrots.jpg"),
    ("Marcus Thorne",   "Pink Fir Potatoes",    8.00, 150, "No Allergens Present", "MT-26-A2", "potatoes.jpg"),
    ("Marcus Thorne",   "Roscoff Sweet Onions", 7.50, 180, "No Allergens Present", "MT-26-A3", "onions.jpg"),
    ("Marcus Thorne",   "Rainbow Carrots",      6.00, 40, "No Allergens Present", "MT-26-A4", "rainbowcarrots.jpg"),
    # Elena Rostova (ER)
    ("Elena Rostova",   "Butterhead Lettuce",   8.50, 120, "No Allergens Present", "ER-26-B1", "lettuce.jpeg"),
    ("Elena Rostova",   "Baby Winter Spinach",  12.00, 100, "No Allergens Present", "ER-26-B2", "spinach.jpeg"),
    ("Elena Rostova",   "Sweet Basil Canopy",   18.00, 0, "No Allergens Present", "ER-26-B3", "basil.jpg"),
    ("Elena Rostova",   "Tarragon & Chervil",   22.00, 60, "No Allergens Present", "ER-26-B4", "tarragon.jpeg"),
    # David MacAulay (DM)
    ("David MacAulay",  "Foraged Chanterelles", 45.00, 40, "No Allergens Present", "DM-26-C1", "chanterelles.jpeg"),
    ("David MacAulay",  "Hen of the Woods",     55.00, 30, "No Allergens Present", "DM-26-C2", "hen ow.jpeg"),
    ("David MacAulay",  "Bramble Blackberries", 24.00, 90, "No Allergens Present", "DM-26-C3", "blackberries.jpeg"),
    ("David MacAulay",  "Wild Penny Buns",      65.00, 25, "No Allergens Present", "DM-26-C4", "wpb.jpeg"),
    # Chloe Vance (CV)
    ("Chloe Vance",     "Heritage Pullet Eggs", 14.00, 10, "Eggs",               "CV-26-D1", "eggs.jpg"),
    ("Chloe Vance",     "Pastured Whole Chicken",18.00, 70, "No Allergens Present","CV-26-D2", "wholechicken.jpg"),
    ("Chloe Vance",     "Foraged Duck Eggs",    18.00, 85, "Eggs",                "CV-26-D3", "Duckeggs.jpg"),
    ("Chloe Vance",     "Wild-Roam Quail",      32.00, 200, "No Allergens Present", "CV-26-D4", "Wilquail.jpg"),
    # Arthur Pendelton (AP)
    ("Arthur Pendelton","Spring Blossom Honey", 28.00, 95, "No Allergens Present", "AP-26-E1", "Honeyjar.jpg"),
    ("Arthur Pendelton","Heather Comb Honey",   45.00, 60, "No Allergens Present", "AP-26-E2", "honeycomb.jpg"),
    ("Arthur Pendelton","Raw Beeswax Block",    24.00, 75, "No Allergens Present", "AP-26-E3", "RawBeeswaxBlock.jpg"),
    ("Arthur Pendelton","Whipped Amber Honey",  32.00, 80, "No Allergens Present", "AP-26-E4", "amber honey.jpg"),
    # Sarah Jenkins (SJ)
    ("Sarah Jenkins",   "Reserve Cox's Apples", 9.50, 10, "No Allergens Present","SJ-26-F1", "apples.jpg"),
    ("Sarah Jenkins",   "Conference Pears",     11.00, 180, "No Allergens Present","SJ-26-F2", "pear.jpg"),
    ("Sarah Jenkins",   "Victoria Plums",       14.00, 0, "No Allergens Present","SJ-26-F3", "plums.jpg"),
    ("Sarah Jenkins",   "Comice Pears",         12.50, 160, "No Allergens Present","SJ-26-F4", "comicepear.jpg"),
]

for pname, name, price, stock, allergen, batch, img in products:
    conn.execute(
        "INSERT INTO products (producer_id, product_name, price, stock_level, allergen_info, batch_number, product_image) VALUES (?,?,?,?,?,?,?)",
        (ids[pname], name, price, stock, allergen, batch, img)
    )
    print(f"  Product: {name} [{batch}] img={img}")

conn.commit()
conn.close()
print("\nDone — database seeded.")
