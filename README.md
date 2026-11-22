# GLH // CO OP

A local produce marketplace built as a portfolio project. Customers can explore produce, build a basket and place demo orders. Approved producers can manage their stock and fulfil orders.

## Tech stack

Python 3.11, SQLite, HTML, CSS and vanilla JavaScript. The Python standard library serves both the site and its JSON API.

## Features

* Customer accounts, producer access and signed browser sessions that survive server restarts
* Product search, sorting, stock levels, photographs and batch records
* Cart, collection or delivery choices, demo checkout and private order receipts
* Producer dashboard, inventory editing, allergen declarations and order fulfilment
* Responsive layouts, consent preferences and automated regression checks

## Run locally

In a terminal at the project root:

```bash
# only for a fresh clone without a database
python3 seed_products.py

# start the local website and API
python3 api_app/api_app.py
```

Open **http://127.0.0.1:8000/index.html**.

**Important:** `seed_products.py` deletes and recreates `glh_coop.db`. Never run it to update an existing database. The active SQLite database, its journals and the local session signing key are excluded from Git. Back up `glh_coop.db` before changing or resetting data.

## Demo accounts

These accounts are created by the seed script for local testing.

| Role | Email | Password |
| --- | --- | --- |
| Customer | `test@glhcoop.com` | `secure123` |
| Producer | `marcus@glh.com` | `secure123` |

Public producer registration is closed. Producer access is managed using the seeded or preexisting accounts.

## Test

```bash
python3 -m unittest discover -s tests -v
node --check frontend/app.js
node tests/test_frontend.js
```

GitHub Actions runs the Python and JavaScript checks automatically.

## Project layout

* `frontend/`: pages, layouts, assets and browser scripts
* `api_app/`: API endpoints, session validation and order logic
* `database_app/`: database utilities
* `tests/`: authentication, inventory, checkout and interface regression tests

## Scope

This is a **portfolio demo**, not a commercial marketplace. Checkout records orders but **does not charge payment cards**. Collection hubs and deliveries are illustrative and do not arrange real transport. Run the server locally; deployment and production security are outside this demonstration's scope.
