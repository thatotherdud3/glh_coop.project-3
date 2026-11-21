"""Session signing survives interpreter restarts without committing a secret."""
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class SessionPersistenceTests(unittest.TestCase):
    def test_token_can_be_verified_in_a_fresh_python_process(self):
        with tempfile.TemporaryDirectory() as directory:
            key_path = Path(directory) / ".glh_session_key"
            env = os.environ.copy()
            env.pop("GLH_SESSION_SECRET_HEX", None)
            env["GLH_SESSION_KEY_FILE"] = str(key_path)
            env["PYTHONPATH"] = str(ROOT / "api_app")
            issued = subprocess.check_output([
                sys.executable, "-c",
                "from producer_metrics import issue_producer_token; print(issue_producer_token(7))"
            ], env=env, cwd=str(ROOT), text=True).strip()
            self.assertTrue(key_path.is_file())
            self.assertEqual(stat.S_IMODE(key_path.stat().st_mode), 0o600)
            verified = subprocess.check_output([
                sys.executable, "-c",
                "import sqlite3, sys; "
                "from producer_metrics import producer_from_token; "
                "db=sqlite3.connect(':memory:'); "
                "db.execute('CREATE TABLE users (user_id INTEGER, role TEXT)'); "
                "db.execute(\"INSERT INTO users VALUES (7, 'producer')\"); "
                "print(producer_from_token(db, 'Bearer ' + sys.argv[1]))",
                issued
            ], env=env, cwd=str(ROOT), text=True).strip()
            self.assertEqual(verified, "7")

    def test_weak_environment_key_is_not_accepted(self):
        env = os.environ.copy()
        env["GLH_SESSION_SECRET_HEX"] = "weak"
        env["PYTHONPATH"] = str(ROOT / "api_app")
        completed = subprocess.run(
            [sys.executable, "-c", "import producer_metrics"],
            env=env, cwd=str(ROOT), text=True, capture_output=True, check=False
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("GLH_SESSION_SECRET_HEX", completed.stderr)

if __name__ == "__main__":
    unittest.main()
