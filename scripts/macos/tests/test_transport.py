"""CLI transport errors must not masquerade as a successful send or submit."""
import base64
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("native_transport_cli", ROOT / "scripts/macos/mast.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class NativeTransport(unittest.TestCase):
    def test_failed_payload_does_not_submit_or_retry(self):
        with patch.object(cli, "emit", return_value=False) as emit, \
             patch.object(cli.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "delivery is unconfirmed"):
                cli.main(["send", "#42", "cargo test"])
        emit.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(base64.b64decode(emit.call_args.args[0].split(b";")[-1][:-1]), b"cargo test")

    def test_failed_literal_payload_is_reported(self):
        with patch.object(cli, "emit", return_value=False) as emit:
            with self.assertRaisesRegex(ValueError, "delivery is unconfirmed"):
                cli.main(["send", "-l", "#42", "draft"])
        emit.assert_called_once()

    def test_failed_submit_does_not_resend_the_payload(self):
        with patch.object(cli, "emit", side_effect=[True, False]) as emit, \
             patch.object(cli.time, "sleep"):
            with self.assertRaisesRegex(ValueError, "delivery is unconfirmed"):
                cli.main(["send", "#42", "cargo test"])
        self.assertEqual(emit.call_count, 2)
        self.assertEqual(base64.b64decode(emit.call_args.args[0].split(b";")[-1][:-1]), b"\r")

    def test_failed_query_cleans_reply_directory_without_waiting(self):
        directories = []

        def fail(packet):
            path = Path(base64.b64decode(packet.split(b";")[-1][:-1]).decode())
            directories.append(path.parent)
            self.assertTrue(path.parent.is_dir())
            return False

        with patch.object(cli, "emit", side_effect=fail), \
             patch.object(cli.time, "sleep") as sleep, \
             patch.object(cli, "commands_by_tty") as processes:
            with self.assertRaisesRegex(ValueError, "cannot query Mast"):
                cli.main(["ls"])
        sleep.assert_not_called()
        processes.assert_not_called()
        self.assertEqual(len(directories), 1)
        self.assertTrue(all(not path.exists() for path in directories))


if __name__ == "__main__":
    unittest.main()
