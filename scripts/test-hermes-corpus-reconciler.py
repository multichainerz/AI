#!/usr/bin/env python3
"""Focused safety tests for the VM2 corpus companion."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


class CorpusReconcilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        os.environ["ORCASYNAPSE_HERMES_STATE_ROOT"] = str(cls.root / "state")
        os.environ["HERMES_HOME"] = str(cls.root / "state/data")
        os.environ["ORCASYNAPSE_HERMES_SOURCE"] = str(cls.root / "hermes-source")
        (cls.root / "state").mkdir(parents=True)
        (cls.root / "state/node-id").write_text("9de260d7-bc51-4558-9d20-06916d393072\n", encoding="utf-8")
        source = Path(__file__).with_name("hermes-corpus-reconciler.py")
        spec = importlib.util.spec_from_file_location("hermes_corpus_reconciler", source)
        assert spec and spec.loader
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def setUp(self) -> None:
        data = self.root / "state/data"
        if data.exists():
            shutil.rmtree(data)
        data.mkdir(parents=True)

    def command(self, **overrides):
        value = {
            "format": self.module.FORMAT_MUTATION,
            "mutationId": str(uuid.uuid4()),
            "nodeId": "9de260d7-bc51-4558-9d20-06916d393072",
            "operation": "MEMORY_ADD",
            "path": "memories/MEMORY.md",
            "expectedHash": None,
            "content": "Remember the operator preference.",
            "oldText": None,
            "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        }
        value.update(overrides)
        return value

    def test_snapshot_is_allowlisted_bounded_and_secret_aware(self) -> None:
        memories = self.root / "state/data/memories"
        skill = self.root / "state/data/skills/research"
        references = skill / "references"
        categorized = self.root / "state/data/skills/operations/incident_response"
        organization = self.root / "state/data/skills/_org/shared_skill"
        unsupported = self.root / "state/data/skills"
        memories.mkdir(parents=True)
        references.mkdir(parents=True)
        categorized.mkdir(parents=True)
        organization.mkdir(parents=True)
        (memories / "MEMORY.md").write_text("First entry\n§\nSecond entry", encoding="utf-8")
        (memories / ".env").write_text("PASSWORD=should-not-appear", encoding="utf-8")
        (skill / "SKILL.md").write_text("---\nname: research\n---\n# Research", encoding="utf-8")
        (references / "guide.md").write_text("API_KEY=abcdefghijklmnopqrstuvwxyz123456", encoding="utf-8")
        (references / "credentials.json").write_text('{"token":"secret"}', encoding="utf-8")
        (references / "nested").mkdir()
        (references / "nested/SKILL.md").write_text("# Support fixture", encoding="utf-8")
        (categorized / "SKILL.md").write_text("---\nname: incident_response\n---\n# Incident response", encoding="utf-8")
        (organization / "SKILL.md").write_text("---\nname: shared_skill\n---\n# Shared", encoding="utf-8")
        (unsupported / "catalog.json").write_text('{"generated":true}', encoding="utf-8")

        snapshot = self.module.scan_corpus()
        by_path = {entry["path"]: entry for entry in snapshot["entries"]}
        self.assertEqual(by_path["memories/MEMORY.md"]["structuredEntries"], ["First entry", "Second entry"])
        self.assertIsInstance(by_path["memories/MEMORY.md"]["sizeBytes"], str)
        self.assertEqual(by_path["skills/research/SKILL.md"]["kind"], "SKILL")
        self.assertEqual(by_path["skills/operations/incident_response/SKILL.md"]["kind"], "SKILL")
        self.assertEqual(by_path["skills/_org/shared_skill/SKILL.md"]["kind"], "SKILL")
        self.assertTrue(by_path["skills/_org/shared_skill/SKILL.md"]["readOnly"])
        self.assertTrue(by_path["skills/catalog.json"]["readOnly"])
        self.assertNotIn("skills/research/references/guide.md", by_path)
        self.assertEqual(by_path["skills/research/references/nested/SKILL.md"]["kind"], "SKILL_FILE")
        self.assertNotIn("memories/.env", by_path)
        self.assertNotIn("skills/research/references/credentials.json", by_path)

        digest = hashlib.sha256()
        for entry in sorted(snapshot["entries"], key=lambda item: item["path"]):
            digest.update(entry["path"].encode())
            digest.update(b"\0")
            digest.update(entry["sha256"].encode("ascii"))
            digest.update(b"\n")
        self.assertEqual(snapshot["rootHash"], digest.hexdigest())

    def test_expected_hash_conflict_stops_native_mutation(self) -> None:
        target = self.root / "state/data/memories/MEMORY.md"
        target.parent.mkdir(parents=True)
        target.write_text("current", encoding="utf-8")
        result = self.module.apply_command(self.command(expectedHash="0" * 64))
        self.assertEqual(result["status"], "CONFLICT")
        self.assertEqual(target.read_text(encoding="utf-8"), "current")

    def test_scan_limits_fail_closed_instead_of_publishing_a_partial_deletion_view(self) -> None:
        memories = self.root / "state/data/memories"
        memories.mkdir(parents=True)
        (memories / "MEMORY.md").write_text("Memory", encoding="utf-8")
        (memories / "USER.md").write_text("User", encoding="utf-8")
        original = self.module.MAX_FILES
        self.module.MAX_FILES = 1
        try:
            with self.assertRaises(self.module.ReconcileError):
                self.module.scan_corpus()
        finally:
            self.module.MAX_FILES = original

    @unittest.skipUnless(os.name == "posix", "VM2 symlink confinement is a POSIX boundary")
    def test_scan_never_follows_a_symlink_outside_hermes_home(self) -> None:
        outside = self.root / "outside-secret.md"
        outside.write_text("PASSWORD=abcdefghijklmnopqrstuvwxyz123456", encoding="utf-8")
        skill = self.root / "state/data/skills/research"
        references = skill / "references"
        references.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: research\n---\n", encoding="utf-8")
        (references / "leak.md").symlink_to(outside)

        paths = {entry["path"] for entry in self.module.scan_corpus()["entries"]}
        self.assertNotIn("skills/research/references/leak.md", paths)

    def test_demoted_mutation_uses_root_supplied_node_identity(self) -> None:
        target = self.root / "state/data/memories/MEMORY.md"
        target.parent.mkdir(parents=True)
        target.write_text("current", encoding="utf-8")
        original = self.module.read_state
        os.environ["ORCASYNAPSE_NODE_ID"] = "9de260d7-bc51-4558-9d20-06916d393072"
        self.module.read_state = lambda _name: (_ for _ in ()).throw(PermissionError("root-only state"))
        try:
            result = self.module.apply_command(self.command(expectedHash="0" * 64))
        finally:
            self.module.read_state = original
            os.environ.pop("ORCASYNAPSE_NODE_ID", None)
        self.assertEqual(result["status"], "CONFLICT")

    def test_memory_changes_use_the_native_store(self) -> None:
        target = self.root / "state/data/memories/MEMORY.md"
        target.parent.mkdir(parents=True)
        calls = []

        class Store:
            def load_from_disk(self): calls.append("load")
            def add(self, scope, content):
                calls.append(("add", scope, content))
                target.write_text(content, encoding="utf-8")
                return {"success": True}

        tools = types.ModuleType("tools")
        memory = types.ModuleType("tools.memory_tool")
        memory.load_on_disk_store = lambda: Store()
        sys.modules["tools"] = tools
        sys.modules["tools.memory_tool"] = memory
        result = self.module.apply_command(self.command())
        self.assertEqual(result["status"], "APPLIED")
        self.assertIn(("add", "memory", "Remember the operator preference."), calls)
        self.assertEqual(result["observedHash"], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_skill_changes_replay_through_hermes_approved_mutation_api(self) -> None:
        target = self.root / "state/data/skills/research/SKILL.md"
        target.parent.mkdir(parents=True)
        target.write_text("old", encoding="utf-8")
        observed = hashlib.sha256(target.read_bytes()).hexdigest()
        calls = []

        tools = types.ModuleType("tools")
        skills = types.ModuleType("tools.skill_manager_tool")
        def apply(payload):
            calls.append(payload)
            target.write_text(payload["content"], encoding="utf-8")
            return json.dumps({"success": True})
        skills.apply_skill_pending = apply
        sys.modules["tools"] = tools
        sys.modules["tools.skill_manager_tool"] = skills
        result = self.module.apply_command(self.command(
            operation="SKILL_EDIT", path="skills/research/SKILL.md",
            expectedHash=observed, content="new", oldText=None,
        ))
        self.assertEqual(result["status"], "APPLIED")
        self.assertEqual(calls, [{"action": "edit", "name": "research", "content": "new"}])

    def test_path_traversal_is_rejected(self) -> None:
        with self.assertRaises(self.module.ReconcileError):
            self.module.safe_path("skills/../../identity/node.key")

    def test_skill_paths_follow_native_names_categories_and_support_roots(self) -> None:
        main = self.root / "state/data/skills/operations/incident_response/SKILL.md"
        main.parent.mkdir(parents=True)
        main.write_text("---\nname: incident_response\n---\n", encoding="utf-8")
        self.assertEqual(
            self.module.skill_parts("skills/operations/incident_response/SKILL.md"),
            ("incident_response", None, "operations"),
        )
        self.assertEqual(
            self.module.skill_parts("skills/operations/incident_response/references/runbook.md"),
            ("incident_response", "references/runbook.md", None),
        )
        with self.assertRaises(self.module.ReconcileError):
            self.module.skill_parts("skills/operations/incident_response/examples/unsafe.md")

        support_named_skill = self.root / "state/data/skills/operations/references/SKILL.md"
        support_named_skill.parent.mkdir(parents=True)
        support_named_skill.write_text("---\nname: references\n---\n", encoding="utf-8")
        self.assertEqual(
            self.module.skill_parts("skills/operations/references/references/runbook.md"),
            ("references", "references/runbook.md", None),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
