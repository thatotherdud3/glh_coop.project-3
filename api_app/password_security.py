"""Password hashing with backward-compatible upgrades from the original SHA-256 format."""
import hashlib
import hmac
import secrets

ITERATIONS = 310_000

def hash_password(password):
    if not isinstance(password, str) or not password:
        raise ValueError("Password is required.")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"

def verify_password(password, stored_hash):
    if not isinstance(password, str) or not isinstance(stored_hash, str):
        return False
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            _, work, salt_hex, expected_hex = stored_hash.split("$", 3)
            iterations = int(work)
            if iterations < 100_000 or iterations > 1_000_000:
                return False
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(expected_hex)
            calculated = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, iterations,
            )
            return hmac.compare_digest(expected, calculated)
        except (ValueError, TypeError):
            return False
    if len(stored_hash) == 64:
        legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(stored_hash, legacy)
    return False

def needs_upgrade(stored_hash):
    return not stored_hash.startswith("pbkdf2_sha256$")
