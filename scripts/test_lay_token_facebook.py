import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("lay-token-facebook.py")
SPEC = importlib.util.spec_from_file_location("lay_token_facebook", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FacebookTokenHelperTests(unittest.TestCase):
    def make_home(self, base: Path, relative: str, marker: str = "config.yaml") -> Path:
        home = base / relative
        home.mkdir(parents=True)
        (home / marker).write_text("", encoding="utf-8")
        return home

    def test_explicit_hermes_home_has_precedence(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            explicit = self.make_home(base, "explicit")
            windows = self.make_home(base, "local/hermes")
            unix = self.make_home(base, "user/.hermes")
            env = {"HERMES_HOME": str(explicit), "LOCALAPPDATA": str(windows.parent)}

            found = MODULE.resolve_hermes_home(env=env, os_name="nt", user_home=str(unix.parent))

            self.assertEqual(found, explicit)

    def test_windows_default_uses_localappdata_hermes(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            expected = self.make_home(base, "local/hermes", marker=".env")

            found = MODULE.resolve_hermes_home(
                env={"LOCALAPPDATA": str(expected.parent)}, os_name="nt", user_home=str(base / "user")
            )

            self.assertEqual(found, expected)

    def test_unix_default_uses_dot_hermes(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            expected = self.make_home(base, "user/.hermes")

            found = MODULE.resolve_hermes_home(env={}, os_name="posix", user_home=str(expected.parent))

            self.assertEqual(found, expected)

    def test_missing_home_fails_clearly_without_using_script_directory(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)

            with self.assertRaisesRegex(RuntimeError, "HERMES_HOME"):
                MODULE.resolve_hermes_home(env={}, os_name="posix", user_home=str(base))

    def test_rendered_page_status_never_contains_page_token(self):
        token = "page-secret-token-value"
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            MODULE.print_page_status(
                {"id": "page-123", "name": "Page thử", "access_token": token},
                forever=True,
                missing=["pages_read_user_content"],
            )

        rendered = output.getvalue()
        self.assertIn("Page thử", rendered)
        self.assertIn("page-123", rendered)
        self.assertIn("pages_read_user_content", rendered)
        self.assertNotIn(token, rendered)
        self.assertNotIn("FB_PAGE_TOKEN", rendered)


if __name__ == "__main__":
    unittest.main()
