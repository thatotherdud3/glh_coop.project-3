"""Check consistent copyright attribution across all storefront pages."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTICE = "© 2026 THATOTHERCOMPANY. ALL RIGHTS RESERVED."

class CopyrightFooterTests(unittest.TestCase):
    def test_each_html_page_has_one_notice_at_the_bottom(self):
        pages = sorted((ROOT / "frontend").glob("*.html"))
        self.assertTrue(pages)
        for page in pages:
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                self.assertEqual(text.count(NOTICE), 1)
                self.assertIn('class="site-copyright"', text)
                self.assertLess(text.rindex("</main>"), text.index(NOTICE))
                self.assertLess(text.index(NOTICE), text.rindex("</footer>"))

if __name__ == "__main__":
    unittest.main()
