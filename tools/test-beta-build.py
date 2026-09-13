#!/usr/bin/env python3
"""Exercise the real beta configuration function without signing or Gradle."""
from pathlib import Path
import subprocess
import tempfile
import unittest


DELIVERIES = Path(__file__).resolve().parents[1]
REPOSITORY = DELIVERIES.parent
TEMP_ROOT = REPOSITORY / "project-data" / "cache" / "tmp"


class BetaBuildTest(unittest.TestCase):
    def configure(self, version=None, script_version="0.6", overrides=None):
        source = (DELIVERIES / "build.sh").read_text()
        function = source[source.index("configure_beta_build() {"):
                          source.index("\nresolve_local_properties() {")]
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lite-beta-build-", dir=TEMP_ROOT) as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "app/build.gradle.kts").write_text('val releaseVersionNameDefault = "1.3.5"\n')
            (root / "script/project/services").mkdir(parents=True)
            (root / "script/project/services/build-track.ts").write_text(
                f'export const SCRIPT_VERSION = "{script_version}";\n')
            environment = {"PATH": "/usr/bin:/bin"}
            if version is not None:
                environment["DELIVERIES_VERSION_NAME"] = version
            environment.update(overrides or {})
            command = 'set -euo pipefail\nROOT="$1"\n' + function + '\nconfigure_beta_build\n'
            command += 'printf "%s\\n" "$DELIVERIES_VERSION_NAME" "$DELIVERIES_VERSION_CODE" "$DELIVERIES_EXPRESS_GATEWAY_URL"\n'
            return subprocess.run(["/bin/bash", "-c", command, "test-beta-build", str(root)],
                                  env=environment, capture_output=True, text=True)

    def test_explicit_android_beta_does_not_require_ios_beta(self):
        result = self.configure("1.3.5-beta1")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["1.3.5-beta1", "1030501", "https://beta.pipiassistant.app"],
                         result.stdout.splitlines())

    def test_explicit_beta_fixes_endpoint_and_code(self):
        result = self.configure("1.3.5-beta98", "0.6-beta12", {
            "DELIVERIES_VERSION_CODE": "1",
            "DELIVERIES_EXPRESS_GATEWAY_URL": "https://pipiassistant.app",
        })
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["1.3.5-beta98", "1030598", "https://beta.pipiassistant.app"],
                         result.stdout.splitlines())

    def test_legacy_numbered_ios_beta_remains_supported(self):
        result = self.configure(script_version="0.6-beta58")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("1.3.5-beta58", result.stdout.splitlines()[0])

    def test_formal_ios_without_explicit_android_beta_is_rejected(self):
        self.assertNotEqual(0, self.configure().returncode)

    def test_explicit_version_must_match_android_release_base(self):
        for version in ["1.3.5", "0.6-beta1", "1.3.4-beta1", "1x3x5-beta1", "1.3.5-beta1-extra"]:
            with self.subTest(version=version):
                result = self.configure(version, "0.6-beta12")
                self.assertNotEqual(0, result.returncode)
                self.assertEqual("", result.stdout)

    def test_explicit_number_must_fit_beta_slots(self):
        for number in ["0", "99", "100", "-1"]:
            with self.subTest(number=number):
                self.assertNotEqual(0, self.configure("1.3.5-beta" + number, "0.6-beta12").returncode)


if __name__ == "__main__":
    unittest.main()
