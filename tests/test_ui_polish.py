"""Smoke checks for the GLH storefront pages and final UI requirements."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "frontend"

class StorefrontUiTests(unittest.TestCase):
    def test_favicon_and_busted_assets_are_linked_everywhere(self):
        self.assertTrue((ROOT / "favicon.svg").exists())
        pages = sorted(ROOT.glob("*.html"))
        self.assertEqual(len(pages), 15)
        for page in pages:
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                self.assertIn('rel="icon"', text)
                self.assertIn('href="favicon.svg"', text)
                self.assertIn("glh-final-ui-20261121", text)

    def test_public_producer_registration_is_closed(self):
        login = (ROOT / "producer-login.html").read_text(encoding="utf-8")
        registration = (ROOT / "producer-registration.html").read_text(encoding="utf-8")
        self.assertNotIn('href="producer-registration.html"', login)
        self.assertNotIn("<form", registration)
        self.assertIn("REGISTRATION CLOSED", registration)
        self.assertIn('href="producer-login.html"', registration)

    def test_allergen_editor_has_separate_ingredient_and_contact_fields(self):
        source = (ROOT / "producer-portal.html").read_text(encoding="utf-8")
        for control in ("allergen-other", "allergen-may-contain",
                        "edit-product-contains", "edit-product-may-contain",
                        "no-allergens"):
            with self.subTest(control=control):
                self.assertIn('id="' + control + '"', source)
        self.assertNotIn('id="other"', source)
        self.assertNotIn('value="lbs"', source)

    def test_cart_uses_order_wording_and_shop_action(self):
        html = (ROOT / "cart.html").read_text(encoding="utf-8")
        js = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("PLACE ORDER</button>", html)
        self.assertIn('const CART_CHECKOUT_LABEL = "PLACE ORDER";', js)
        self.assertIn("EXPLORE PRODUCE", js)
        self.assertIn("shop-inventory-retry", js)


if __name__ == "__main__":
    unittest.main()
