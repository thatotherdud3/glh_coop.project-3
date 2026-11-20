"""Update existing product image references without rebuilding the GLH database.

Run from the project root:
    python3 sync_product_images.py

This changes only product_image values for four known batches.
It never deletes or recreates tables, inventory, users, or orders.
"""
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "glh_coop.db"
ASSETS = ROOT / "frontend" / "assets"

IMAGE_UPDATES = {
    "ER-26-B3": "basil.jpg",
    "ER-26-B4": "tarragon.jpeg",
    "DM-26-C2": "hen ow.jpeg",
    "AP-26-E4": "amber honey.jpg",
}


def main():
    if not DATABASE.is_file():
        print(f"Database not found: {DATABASE}", file=sys.stderr)
        return 1

    missing_assets = [
        image for image in IMAGE_UPDATES.values() if not (ASSETS / image).is_file()
    ]
    if missing_assets:
        print(f"Missing images: {', '.join(missing_assets)}", file=sys.stderr)
        return 1

    try:
        with sqlite3.connect(DATABASE) as connection:
            for batch, image in IMAGE_UPDATES.items():
                rows = connection.execute(
                    "SELECT product_id, product_image FROM products WHERE batch_number = ?",
                    (batch,),
                ).fetchall()
                if len(rows) != 1:
                    raise ValueError(
                        f"Expected exactly one product for {batch}; found {len(rows)}. "
                        "No changes saved."
                    )
                old_filename = rows[0][1]
                if old_filename != image:
                    connection.execute(
                        "UPDATE products SET product_image = ? WHERE product_id = ?",
                        (image, rows[0][0]),
                    )
                print(f"{batch}: {old_filename or '(empty)'} -> {image}")
            # The transaction commits only if all four batches were found.
    except (sqlite3.Error, ValueError) as error:
        print(f"Image sync failed: {error}", file=sys.stderr)
        return 1

    print("Image filenames updated. Refresh the Shop Produce page.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
