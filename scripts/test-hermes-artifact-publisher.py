#!/usr/bin/env python3
"""Focused safety tests for the VM2 artifact publisher.

The publisher's job is mostly deciding what NOT to send: symlinks, dotfiles,
secret-shaped files, oversized files, and sessions that fail attribution must
all degrade without blocking the deliverables beside them. Each of those
refusals is what gets asserted; the happy path is one test.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


class ArtifactPublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        os.environ["ORCASYNAPSE_HERMES_STATE_ROOT"] = str(cls.root / "state")
        os.environ["ORCASYNAPSE_HERMES_ARTIFACT_ROOT"] = str(cls.root / "state/artifacts")
        (cls.root / "state").mkdir(parents=True)
        (cls.root / "state/node-id").write_text("9de260d7-bc51-4558-9d20-06916d393072\n", encoding="utf-8")
        source = Path(__file__).with_name("hermes-artifact-publisher.py")
        spec = importlib.util.spec_from_file_location("hermes_artifact_publisher", source)
        assert spec and spec.loader
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def setUp(self) -> None:
        self.artifact_root = Path(os.environ["ORCASYNAPSE_HERMES_ARTIFACT_ROOT"])
        if self.artifact_root.exists():
            import shutil
            shutil.rmtree(self.artifact_root)
        self.artifact_root.mkdir(parents=True)
        state = Path(os.environ["ORCASYNAPSE_HERMES_STATE_ROOT"]) / "artifact-publisher-state.json"
        if state.exists():
            state.unlink()
        self.module.ARTIFACT_ROOT = self.artifact_root
        self.module.PUBLISH_STATE = state
        self.sent: list[dict] = []
        # The wire is replaced, not mocked per-test: every test asserts on what
        # would have been signed and posted, which is the script's whole output.
        self.module.request_json = lambda method, path, body: self.sent.append({"method": method, "path": path, "body": body}) or {"accepted": True, "results": [], "serverTime": "2026-08-19T00:00:00.000Z"}

    def write(self, session: str, relative: str, data: bytes) -> Path:
        path = self.artifact_root / session / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_publishes_a_deliverable_inline_with_hash_and_size(self) -> None:
        self.write("session-1", "out/report.md", b"# Report\n")
        self.assertEqual(self.module.scan(), 0)
        self.assertEqual(len(self.sent), 1)
        request = self.sent[0]
        self.assertEqual(request["path"], "/api/v1/runtime-nodes/9de260d7-bc51-4558-9d20-06916d393072/artifacts")
        [entry] = request["body"]["artifacts"]
        self.assertEqual(entry["path"], "out/report.md")
        self.assertEqual(entry["sizeBytes"], "9")
        self.assertEqual(entry["sha256"], hashlib.sha256(b"# Report\n").hexdigest())
        self.assertEqual(base64.b64decode(entry["contentBase64"]), b"# Report\n")
        self.assertEqual(request["body"]["sessionId"], "session-1")

    def test_downgrades_a_secret_shaped_file_to_metadata_only(self) -> None:
        self.write("session-1", "notes.md", b"api_key = 'sk-" + b"a" * 24 + b"'")
        self.module.scan()
        [entry] = self.sent[0]["body"]["artifacts"]
        self.assertIsNone(entry["contentBase64"])

    def test_skips_denied_names_and_suffixes_entirely_from_inline(self) -> None:
        self.write("session-1", "server.key", b"private material")
        self.write("session-1", "report.md", b"fine")
        self.module.scan()
        entries = {entry["path"]: entry for entry in self.sent[0]["body"]["artifacts"]}
        self.assertIsNone(entries["server.key"]["contentBase64"])
        self.assertIsNotNone(entries["report.md"]["contentBase64"])

    def test_never_follows_a_symlink(self) -> None:
        outside = self.root / "outside-secret.txt"
        outside.write_bytes(b"never published")
        session = self.artifact_root / "session-1"
        session.mkdir()
        (session / "link.txt").symlink_to(outside)
        self.write("session-1", "real.txt", b"real")
        self.module.scan()
        paths = [entry["path"] for entry in self.sent[0]["body"]["artifacts"]]
        self.assertEqual(paths, ["real.txt"])

    def test_never_follows_a_directory_symlink(self) -> None:
        outside = self.root / "host-etc"
        outside.mkdir()
        (outside / "passwd").write_bytes(b"root:x:0:0:root:/root:/bin/sh")
        session = self.artifact_root / "session-1"
        session.mkdir()
        (session / "escape").symlink_to(outside)
        self.write("session-1", "real.txt", b"real")
        self.module.scan()
        paths = [entry["path"] for entry in self.sent[0]["body"]["artifacts"]]
        self.assertEqual(paths, ["real.txt"])

    def test_skips_dotfiles_and_implausible_session_names(self) -> None:
        self.write("session-1", ".hidden", b"x")
        self.write("session-1", "seen.txt", b"x")
        self.write("..evil", "escape.txt", b"x")
        self.module.scan()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual([entry["path"] for entry in self.sent[0]["body"]["artifacts"]], ["seen.txt"])

    def test_second_pass_sends_nothing_until_the_file_changes(self) -> None:
        self.write("session-1", "report.md", b"v1")
        self.module.scan()
        self.module.scan()
        self.assertEqual(len(self.sent), 1)
        self.write("session-1", "report.md", b"v2")
        self.module.scan()
        self.assertEqual(len(self.sent), 2)

    def test_a_refused_session_does_not_block_the_next_one(self) -> None:
        self.write("aaa-refused", "a.txt", b"a")
        self.write("bbb-accepted", "b.txt", b"b")
        original = self.module.request_json
        def wire(method: str, path: str, body: dict):
            if body["sessionId"] == "aaa-refused":
                raise self.module.PublishError("control plane refused artifact upload (400): unknown session")
            return original(method, path, body)
        self.module.request_json = wire
        self.assertEqual(self.module.scan(), 0)
        self.assertEqual([request["body"]["sessionId"] for request in self.sent], ["bbb-accepted"])

    def test_reports_a_vanished_file_once_and_forgets_it_after_acceptance(self) -> None:
        target = self.write("session-1", "report.md", b"v1")
        self.module.scan()
        target.unlink()
        self.module.scan()
        removals = [request["body"]["removedPaths"] for request in self.sent[1:]]
        self.assertEqual(removals, [["report.md"]])
        # Accepted, so forgotten: a third pass has nothing to say.
        self.module.scan()
        self.assertEqual(len(self.sent), 2)

    def test_keeps_a_tombstone_the_control_plane_never_accepted(self) -> None:
        target = self.write("session-1", "report.md", b"v1")
        self.module.scan()
        target.unlink()
        original = self.module.request_json
        def refuse(method: str, path: str, body: dict):
            raise self.module.PublishError("control plane refused artifact upload (503): busy")
        self.module.request_json = refuse
        self.module.scan()
        self.module.request_json = original
        self.module.scan()
        self.assertEqual(self.sent[-1]["body"]["removedPaths"], ["report.md"])

    def test_oversized_file_travels_as_metadata_without_content(self) -> None:
        big = b"x" * (self.module.INLINE_LIMIT_BYTES + 1)
        self.write("session-1", "big.bin", big)
        self.module.scan()
        [entry] = self.sent[0]["body"]["artifacts"]
        self.assertIsNone(entry["contentBase64"])
        self.assertEqual(entry["sizeBytes"], str(len(big)))
        self.assertEqual(entry["sha256"], hashlib.sha256(big).hexdigest())

    def test_does_not_publish_the_session_inbox(self) -> None:
        self.write("session-1", "inbox/notes.txt", b"from the control plane")
        self.write("session-1", "out/report.md", b"# Report\n")
        self.module.scan()
        self.assertEqual([entry["path"] for entry in self.sent[0]["body"]["artifacts"]], ["out/report.md"])

    def test_writes_an_inbox_file_under_the_session(self) -> None:
        dest = self.module.write_inbox_file("session-1", "notes.txt", b"hello")
        self.assertEqual(dest.read_bytes(), b"hello")
        self.assertEqual(dest.parent.name, "inbox")
        with self.assertRaises(self.module.PublishError):
            self.module.write_inbox_file("session-1", "../escape.txt", b"no")
        with self.assertRaises(self.module.PublishError):
            self.module.write_inbox_file("session-1", ".hidden", b"no")
        with self.assertRaises(self.module.PublishError):
            self.module.write_inbox_file("session-1", "foo..bar.txt", b"no")
        inbox = dest.parent
        dest.unlink()
        inbox.rmdir()
        inbox.symlink_to("/tmp")
        with self.assertRaises(self.module.PublishError):
            self.module.write_inbox_file("session-1", "notes2.txt", b"no")


if __name__ == "__main__":
    unittest.main(verbosity=2)
