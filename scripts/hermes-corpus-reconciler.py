#!/usr/bin/env python3
"""OrcaSynapse VM2 Hermes corpus reconciler.

HERMES_HOME is authoritative. This companion publishes a confined observation
of native memory and skill files, polls signed mutation commands, and delegates
writes to the pinned Hermes MemoryStore and skill_manage implementations.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

try:
    import pwd
except ImportError:  # pragma: no cover - VM2 is Linux; permits local contract checks.
    pwd = None

FORMAT_SNAPSHOT = "orcasynapse-hermes-corpus-snapshot/v1"
FORMAT_DESIRED = "orcasynapse-hermes-corpus-desired-state/v1"
FORMAT_MUTATION = "orcasynapse-hermes-corpus-mutation/v1"
MAX_FILES = 1_000
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TEXT_BYTES = 128 * 1024
MAX_SNAPSHOT_TEXT_BYTES = 640 * 1024
SERVICE_USER = os.environ.get("ORCASYNAPSE_HERMES_USER", "orcasynapse-hermes")
STATE_ROOT = Path(os.environ.get("ORCASYNAPSE_HERMES_STATE_ROOT", "/var/lib/orcasynapse-hermes"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(STATE_ROOT / "data")))
HERMES_SOURCE = Path(os.environ.get("ORCASYNAPSE_HERMES_SOURCE", "/usr/local/lib/hermes-agent"))
SCRIPT_PATH = Path(__file__).resolve()

TEXT_SUFFIXES = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".py", ".sh",
    ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".sql", ".csv",
    ".xml", ".ini", ".cfg", ".conf", ".jinja", ".j2",
}
DENIED_NAMES = {
    ".env", "credentials.json", "auth.json", "state.db", "hermes.db",
    "id_rsa", "id_ed25519", "known_hosts", ".netrc", ".npmrc",
    ".git-credentials", "pip.conf",
}
DENIED_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"}
SECRET_PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-/.+=]{20,}"),
    re.compile(rb"AKIA[0-9A-Z]{16}"),
    re.compile(rb"(?i)bearer\s+[A-Za-z0-9_\-/.+=]{20,}"),
    re.compile(rb"(?:sk-[A-Za-z0-9_-]{20,}|gh[opsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})"),
]
SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SKILL_SUPPORT_DIRS = {"references", "templates", "scripts", "assets"}


class ReconcileError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def read_state(name: str) -> str:
    value = (STATE_ROOT / name).read_text(encoding="utf-8").strip()
    if not value:
        raise ReconcileError(f"missing protected runtime state: {name}")
    return value


def signed_headers(method: str, path: str, body: Any) -> dict[str, str]:
    """Sign one operation, not any operation carrying the same body.

    The control plane rebuilds these bytes in `signatureMessage`. Before the
    method and path were part of them, this reconciler's desired-state poll and
    the runtime plane's were byte-identical requests — both authenticate over a
    literal ``null`` — so a signature captured from one was valid on the other.
    """
    timestamp = utc_now()
    nonce = str(uuid.uuid4())
    digest = hashlib.sha256(canonical(body)).hexdigest()
    message = f"{method.upper()}\n{path}\n{timestamp}\n{nonce}\n{digest}".encode("utf-8")
    with tempfile.NamedTemporaryFile() as message_file, tempfile.NamedTemporaryFile() as signature_file:
        message_file.write(message)
        message_file.flush()
        completed = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(STATE_ROOT / "identity/node.key"),
             "-in", message_file.name, "-out", signature_file.name],
            check=False, capture_output=True,
        )
        if completed.returncode != 0:
            raise ReconcileError("could not sign the corpus request with the enrolled node identity")
        signature = base64.urlsafe_b64encode(Path(signature_file.name).read_bytes()).decode("ascii").rstrip("=")
    return {
        # An explicit product identity, because the default is a block: bare
        # urllib announces "Python-urllib", which Cloudflare's Browser
        # Integrity Check refuses with error 1010 before the control plane
        # ever sees the request. The curl-based node clients pass; these two
        # failed on any Cloudflare-fronted deployment until this header.
        "User-Agent": "orcasynapse-hermes-corpus/1.0",
        "x-orcasynapse-node-timestamp": timestamp,
        "x-orcasynapse-node-nonce": nonce,
        "x-orcasynapse-node-signature": signature,
    }


def request_json(method: str, path: str, body: Any = None) -> Any:
    base = read_state("control-plane-url").rstrip("/")
    payload = None if method == "GET" else canonical(body)
    headers = signed_headers(method, path, body)
    if payload is not None:
        headers["content-type"] = "application/json"
    request = urllib.request.Request(f"{base}{path}", data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(4_096).decode("utf-8", "replace")
        raise ReconcileError(f"control plane refused corpus request ({error.code}): {detail}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ReconcileError(f"corpus control-plane request failed: {error}") from error


def control_plane_fingerprint(public_key: Path) -> str:
    completed = subprocess.run(
        ["openssl", "pkey", "-pubin", "-in", str(public_key), "-outform", "DER"],
        check=False, capture_output=True,
    )
    if completed.returncode != 0:
        raise ReconcileError("the pinned control-plane public key is invalid")
    return hashlib.sha256(completed.stdout).hexdigest()


def verify_signed_document(envelope: Any) -> dict[str, Any]:
    if not isinstance(envelope, dict):
        raise ReconcileError("the corpus desired-state envelope is invalid")
    try:
        document = base64.b64decode(envelope["documentBase64"], validate=True)
        signature = base64.b64decode(envelope["signature"], validate=True)
        fingerprint = str(envelope["publicKeyFingerprint"])
    except (KeyError, ValueError, TypeError) as error:
        raise ReconcileError("the corpus desired-state envelope is incomplete") from error
    public_key = STATE_ROOT / "control-plane-key.pem"
    if control_plane_fingerprint(public_key) != fingerprint:
        raise ReconcileError("the corpus desired state was signed by an unpinned control plane")
    with tempfile.NamedTemporaryFile() as document_file, tempfile.NamedTemporaryFile() as signature_file:
        document_file.write(document)
        document_file.flush()
        signature_file.write(signature)
        signature_file.flush()
        completed = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key), "-rawin",
             "-in", document_file.name, "-sigfile", signature_file.name],
            check=False, capture_output=True,
        )
        if completed.returncode != 0:
            raise ReconcileError("the corpus desired-state signature is invalid")
    try:
        parsed = json.loads(document.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReconcileError("the signed corpus desired state is not valid JSON") from error
    if parsed.get("format") != FORMAT_DESIRED or parsed.get("nodeId") != read_state("node-id"):
        raise ReconcileError("the signed corpus desired state belongs to another protocol or node")
    return parsed


def normalized_relative(path: Path) -> str:
    relative = path.relative_to(HERMES_HOME).as_posix()
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ReconcileError("encountered a non-normalized corpus path")
    return str(pure)


def allowed_roots() -> list[Path]:
    return [HERMES_HOME / "memories", HERMES_HOME / "skills", HERMES_HOME / "skill-bundles", HERMES_HOME / "pending"]


def skill_main_path_candidates(relative: str) -> list[str]:
    """Return the parent Skill paths permitted by the corpus protocol.

    Keep this structurally identical to VM1's skillMainPathCandidates. A
    support file is mutable only while one of these parents is present in the
    same signed snapshot as an observed Skill, not merely present on disk.
    """
    parts = relative.split("/")
    candidates: list[str] = []
    for index in range(2, len(parts) - 1):
        if parts[index] not in SKILL_SUPPORT_DIRS:
            continue
        prefix = parts[1:index]
        suffix = parts[index + 1:]
        if prefix and all(SKILL_NAME.fullmatch(part) for part in prefix) \
                and suffix and all(not part.startswith(".") for part in suffix):
            candidates.append("/".join((*parts[:index], "SKILL.md")))
    return candidates


def classify(relative: str) -> tuple[str, bool]:
    if relative in {"memories/MEMORY.md", "memories/USER.md"}:
        return "MEMORY", False
    if relative.startswith("skills/.hub/") or "/.hub/" in relative or relative.endswith(".bundled_manifest"):
        return "PROVENANCE", True
    if relative.startswith("skill-bundles/"):
        return "SKILL_BUNDLE", True
    if relative.startswith("pending/"):
        return "PENDING_CHANGE", True
    parts = relative.split("/")
    if len(parts) >= 3 and parts[0] == "skills" and parts[-1] == "SKILL.md" \
            and SKILL_NAME.fullmatch(parts[-2]):
        for index in range(2, len(parts) - 1):
            if parts[index] not in SKILL_SUPPORT_DIRS:
                continue
            parent_main = HERMES_HOME.joinpath(*parts[:index], "SKILL.md")
            if parent_main.is_file() and not parent_main.is_symlink():
                return "SKILL_FILE", False
        writable_main = all(SKILL_NAME.fullmatch(part) for part in parts[1:-1])
        return "SKILL", not writable_main
    support_index = -1
    for index in range(2, len(parts) - 1):
        if parts[index] not in SKILL_SUPPORT_DIRS \
                or not all(SKILL_NAME.fullmatch(part) for part in parts[1:index]) \
                or any(part.startswith(".") for part in parts[index + 1:]):
            continue
        parent_main = HERMES_HOME.joinpath(*parts[:index], "SKILL.md")
        if parent_main.is_file() and not parent_main.is_symlink():
            support_index = index
            break
    writable_support = support_index >= 2
    return "SKILL_FILE", not writable_support


def is_denied(path: Path) -> bool:
    lowered = path.name.lower()
    return lowered in DENIED_NAMES or lowered.startswith(".env.") \
        or path.suffix.lower() in DENIED_SUFFIXES or lowered.endswith("~")


def media_type(path: Path) -> str:
    if path.suffix.lower() == ".md":
        return "text/markdown"
    if path.suffix.lower() == ".json":
        return "application/json"
    if path.suffix.lower() in {".yaml", ".yml"}:
        return "application/yaml"
    return "text/plain" if path.suffix.lower() in TEXT_SUFFIXES else "application/octet-stream"


def memory_entries(raw: str) -> list[str]:
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    return [entry.strip() for entry in normalized.split("\n§\n") if entry.strip()]


@contextmanager
def securely_open_corpus_file(relative: str):
    """Open beneath HERMES_HOME without following any path-component link."""
    path = safe_path(relative)
    if os.name != "posix":  # Local contract tests; VM2 is always Linux.
        with path.open("rb") as handle:
            yield handle
        return
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW
    descriptors: list[int] = []
    try:
        current = os.open(HERMES_HOME, directory_flags)
        descriptors.append(current)
        parts = PurePosixPath(relative).parts
        for segment in parts[:-1]:
            current = os.open(segment, directory_flags, dir_fd=current)
            descriptors.append(current)
        file_descriptor = os.open(parts[-1], file_flags, dir_fd=current)
        with os.fdopen(file_descriptor, "rb") as handle:
            yield handle
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def scan_corpus() -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    mirrored_text = 0
    def scan_error(error: OSError) -> None:
        # A partial walk would make VM1 misclassify unreadable files as
        # deletions. Preserve the last complete snapshot and retry instead.
        raise ReconcileError(f"could not read the complete Hermes corpus: {error}")

    for root in allowed_roots():
        if not root.exists() or root.is_symlink():
            continue
        for directory, names, files in os.walk(root, followlinks=False, onerror=scan_error):
            base = Path(directory)
            names[:] = sorted(
                name for name in names
                if not (base / name).is_symlink()
                and name not in {"__pycache__", ".git", ".venv", ".pytest_cache", "node_modules", "cache"}
                and (not name.startswith(".") or name == ".hub")
            )
            for name in sorted(files):
                path = base / name
                if len(entries) >= MAX_FILES:
                    raise ReconcileError(f"corpus exceeds the {MAX_FILES}-file safety limit")
                if path.is_symlink() or is_denied(path) or (name.startswith(".") and name != ".bundled_manifest"):
                    continue
                relative = normalized_relative(path)
                # The memories root is intentionally two-file only.
                if relative.startswith("memories/") and relative not in {"memories/MEMORY.md", "memories/USER.md"}:
                    continue
                digest = hashlib.sha256()
                chunks: list[bytes] = []
                try:
                    with securely_open_corpus_file(relative) as handle:
                        info = os.fstat(handle.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                            continue
                        while True:
                            chunk = handle.read(64 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                            if info.st_size <= MAX_TEXT_BYTES:
                                chunks.append(chunk)
                except OSError as error:
                    raise ReconcileError(f"could not safely read corpus file {path.name}: {error}") from error
                raw = b"".join(chunks)
                kind, read_only = classify(relative)
                content: str | None = None
                structured: list[str] | None = None
                secret_like = any(pattern.search(raw) for pattern in SECRET_PATTERNS)
                if secret_like:
                    continue
                textual = path.suffix.lower() in TEXT_SUFFIXES
                if textual and mirrored_text + len(raw) <= MAX_SNAPSHOT_TEXT_BYTES:
                    try:
                        content = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        content = None
                    if content is not None:
                        mirrored_text += len(raw)
                        if kind == "MEMORY":
                            structured = memory_entries(content)
                entries.append({
                    "path": relative, "kind": kind, "mediaType": media_type(path),
                    # Signed JSON is number-free by protocol. Python, jq, and
                    # JavaScript otherwise disagree on some numeric spellings.
                    "sizeBytes": str(info.st_size), "sha256": digest.hexdigest(),
                    "content": content, "structuredEntries": structured,
                    "readOnly": read_only or content is None,
                })
    # Classification deliberately consults the filesystem so only native
    # Hermes support trees can become writable. Observation is stricter: a
    # parent can be present on disk yet absent from the snapshot because its
    # contents are secret-like or over the file limit. Publishing its detached
    # children would create an incoherent repository and VM1 must reject it.
    # Prune every support-tree entry whose parent Skill is not itself visible
    # in this exact signed snapshot. Unsupported top-level metadata (which has
    # no parent candidate and is always read-only) remains observable.
    observed_skills = {
        entry["path"] for entry in entries if entry["kind"] == "SKILL"
    }
    entries = [
        entry for entry in entries
        if entry["kind"] != "SKILL_FILE"
        or not skill_main_path_candidates(entry["path"])
        or any(
            candidate in observed_skills
            for candidate in skill_main_path_candidates(entry["path"])
        )
    ]
    entries.sort(key=lambda entry: entry["path"])
    root_hash = hashlib.sha256()
    for entry in entries:
        root_hash.update(entry["path"].encode("utf-8"))
        root_hash.update(b"\0")
        root_hash.update(entry["sha256"].encode("ascii"))
        root_hash.update(b"\n")
    return {"format": FORMAT_SNAPSHOT, "observedAt": utc_now(), "rootHash": root_hash.hexdigest(), "entries": entries}


def scan_as_service_user() -> dict[str, Any]:
    """Scan as Hermes, never as the root identity/signing process.

    Hermes owns every writable corpus path. Keeping traversal in its Unix
    account means even a malicious symlink race cannot turn the root-owned
    synchronization service into a host-secret reader.
    """
    if os.geteuid() != 0:
        return scan_corpus()
    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--scan"], capture_output=True,
        **service_user_subprocess_credentials(), env={
            **os.environ, "HERMES_HOME": str(HERMES_HOME),
            "ORCASYNAPSE_HERMES_STATE_ROOT": str(STATE_ROOT),
            "ORCASYNAPSE_HERMES_SOURCE": str(HERMES_SOURCE),
        },
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()[:3_500]
        raise ReconcileError(detail or "Hermes corpus scan subprocess failed")
    try:
        value = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReconcileError("Hermes corpus scan subprocess returned invalid JSON") from error
    if not isinstance(value, dict) or value.get("format") != FORMAT_SNAPSHOT:
        raise ReconcileError("Hermes corpus scan subprocess returned an invalid snapshot")
    return value


def safe_path(relative: str) -> Path:
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ReconcileError("mutation path is not normalized")
    candidate = HERMES_HOME.joinpath(*pure.parts)
    for parent in [candidate, *candidate.parents]:
        if parent == HERMES_HOME.parent:
            break
        if parent.exists() and parent.is_symlink():
            raise ReconcileError("mutation path crosses a symbolic link")
        if parent == HERMES_HOME:
            break
    try:
        candidate.relative_to(HERMES_HOME)
    except ValueError as error:
        raise ReconcileError("mutation path escapes HERMES_HOME") from error
    return candidate


def file_hash(path: Path) -> str | None:
    if not path.exists() or path.is_symlink() or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_tool_result(result: Any) -> dict[str, Any]:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError as error:
            raise ReconcileError("Hermes returned an invalid mutation result") from error
    if not isinstance(result, dict):
        raise ReconcileError("Hermes returned an invalid mutation result")
    return result


def skill_parts(relative: str) -> tuple[str, str | None, str | None]:
    parts = PurePosixPath(relative).parts
    if len(parts) < 3 or parts[0] != "skills":
        raise ReconcileError("mutation is outside the user skill namespace")
    if parts[-1] == "SKILL.md" and all(SKILL_NAME.fullmatch(part) for part in parts[1:-1]):
        category_parts = parts[1:-2]
        category = category_parts[0] if len(category_parts) == 1 else None
        return parts[-2], None, category
    support_index = -1
    for index in range(2, len(parts) - 1):
        if parts[index] not in SKILL_SUPPORT_DIRS \
                or not all(SKILL_NAME.fullmatch(part) for part in parts[1:index]) \
                or any(part.startswith(".") for part in parts[index + 1:]):
            continue
        parent_main = safe_path("/".join((*parts[:index], "SKILL.md")))
        if parent_main.is_file() and not parent_main.is_symlink():
            support_index = index
            break
    if support_index < 2:
        raise ReconcileError("mutation is outside the user skill namespace")
    nested = "/".join(parts[support_index:])
    return parts[support_index - 1], nested, None


def apply_command(command: dict[str, Any]) -> dict[str, Any]:
    # Root verifies and supplies the enrolled identity before the mutation
    # subprocess drops privileges. The service account deliberately cannot
    # read the root-owned node identity files under STATE_ROOT.
    expected_node_id = os.environ.get("ORCASYNAPSE_NODE_ID") or read_state("node-id")
    if command.get("format") != FORMAT_MUTATION or command.get("nodeId") != expected_node_id:
        raise ReconcileError("mutation command belongs to another protocol or node")
    expires = datetime.fromisoformat(str(command["expiresAt"]).replace("Z", "+00:00"))
    if expires <= datetime.now(timezone.utc):
        return {"status": "FAILED", "observedHash": None, "message": "Mutation command expired before execution."}
    operation = str(command["operation"])
    path = safe_path(str(command["path"]))
    expected = command.get("expectedHash")
    observed = file_hash(path)
    if expected is not None and observed != expected:
        return {"status": "CONFLICT", "observedHash": observed, "message": "Corpus content changed after the control-plane observation."}
    sys.path.insert(0, str(HERMES_SOURCE))
    try:
        if operation.startswith("MEMORY_"):
            if command["path"] not in {"memories/MEMORY.md", "memories/USER.md"}:
                raise ReconcileError("memory mutation target is not allowed")
            from tools.memory_tool import load_on_disk_store
            store = load_on_disk_store()
            store.load_from_disk()
            target = "user" if command["path"].endswith("USER.md") else "memory"
            if operation == "MEMORY_ADD":
                result = store.add(target, str(command.get("content") or ""))
            elif operation == "MEMORY_REPLACE":
                result = store.replace(target, str(command.get("oldText") or ""), str(command.get("content") or ""))
            elif operation == "MEMORY_REMOVE":
                result = store.remove(target, str(command.get("oldText") or ""))
            else:
                raise ReconcileError("unsupported memory operation")
        else:
            # The control plane is the approval authority for this signed
            # command. Replaying through Hermes' approved-write entry point
            # keeps all native validation and atomic mutation behavior while
            # avoiding a second, invisible local staging queue.
            from tools.skill_manager_tool import apply_skill_pending
            name, nested, category = skill_parts(str(command["path"]))
            if operation == "SKILL_CREATE":
                payload = {"action": "create", "name": name, "content": str(command.get("content") or "")}
                if category:
                    payload["category"] = category
                result = parse_tool_result(apply_skill_pending(payload))
            elif operation == "SKILL_EDIT":
                result = parse_tool_result(apply_skill_pending({"action": "edit", "name": name, "content": str(command.get("content") or "")}))
            elif operation == "SKILL_DELETE":
                result = parse_tool_result(apply_skill_pending({"action": "delete", "name": name}))
            elif operation == "SKILL_WRITE_FILE":
                if not nested:
                    raise ReconcileError("skill support-file path is required")
                result = parse_tool_result(apply_skill_pending({"action": "write_file", "name": name, "file_path": nested, "file_content": str(command.get("content") or "")}))
            elif operation == "SKILL_REMOVE_FILE":
                if not nested:
                    raise ReconcileError("skill support-file path is required")
                result = parse_tool_result(apply_skill_pending({"action": "remove_file", "name": name, "file_path": nested}))
            else:
                raise ReconcileError("unsupported skill operation")
    except ReconcileError:
        raise
    except Exception as error:
        raise ReconcileError(f"Hermes mutation adapter failed: {error}") from error
    result = parse_tool_result(result)
    if not result.get("success"):
        message = str(result.get("error") or "Hermes rejected the corpus mutation.")[:4_000]
        return {"status": "FAILED", "observedHash": file_hash(path), "message": message}
    return {"status": "APPLIED", "observedHash": file_hash(path), "message": "Hermes applied the governed corpus mutation."}


def service_user_subprocess_credentials() -> dict[str, Any]:
    """Resolve the Hermes account before fork and request a complete ID drop.

    Python's preexec_fn runs after fork and before exec. Calling pwd/NSS or
    other non-async-signal-safe library code there can fail opaquely as
    ``Exception occurred in preexec_fn``. Popen's POSIX credential parameters
    perform the transition internally and empty supplementary groups as an
    explicit part of the security boundary.
    """
    if pwd is None:
        raise ReconcileError("service-account demotion requires a Unix runtime")
    try:
        account = pwd.getpwnam(SERVICE_USER)
    except KeyError as error:
        raise ReconcileError(f"Hermes service account does not exist: {SERVICE_USER}") from error
    return {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": ()}


def apply_as_service_user(command: dict[str, Any]) -> dict[str, Any]:
    if os.geteuid() != 0:
        return apply_command(command)
    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--apply-stdin"], input=canonical(command),
        capture_output=True, **service_user_subprocess_credentials(), env={
            **os.environ, "HERMES_HOME": str(HERMES_HOME),
            "ORCASYNAPSE_HERMES_STATE_ROOT": str(STATE_ROOT),
            "ORCASYNAPSE_HERMES_SOURCE": str(HERMES_SOURCE),
            "ORCASYNAPSE_NODE_ID": read_state("node-id"),
        },
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()[:3_500]
        return {"status": "FAILED", "observedHash": None, "message": detail or "Hermes mutation subprocess failed."}
    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except json.JSONDecodeError:
        return {"status": "FAILED", "observedHash": None, "message": "Hermes mutation subprocess returned invalid JSON."}


def load_receipts() -> dict[str, Any]:
    path = STATE_ROOT / "corpus-mutation-receipts.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_receipts(receipts: dict[str, Any]) -> None:
    path = STATE_ROOT / "corpus-mutation-receipts.json"
    trimmed = dict(list(receipts.items())[-500:])
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(trimmed, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def reconcile_once() -> None:
    node_id = read_state("node-id")
    snapshot_path = f"/api/v1/runtime-nodes/{node_id}/corpus/snapshot"
    desired_path = f"/api/v1/runtime-nodes/{node_id}/corpus/desired-state"
    result_path = f"/api/v1/runtime-nodes/{node_id}/corpus/mutation-result"
    request_json("POST", snapshot_path, scan_as_service_user())
    desired = verify_signed_document(request_json("GET", desired_path, None))
    command = desired.get("mutation")
    if not command:
        return
    mutation_id = str(command.get("mutationId") or "")
    try:
        uuid.UUID(mutation_id)
    except ValueError as error:
        raise ReconcileError("signed corpus mutation has an invalid identifier") from error
    receipts = load_receipts()
    result = receipts.get(mutation_id)
    if not isinstance(result, dict):
        result = apply_as_service_user(command)
        result = {**result, "mutationId": mutation_id, "completedAt": utc_now()}
        receipts[mutation_id] = result
        save_receipts(receipts)
    request_json("POST", result_path, result)
    if result.get("status") == "APPLIED":
        request_json("POST", snapshot_path, scan_as_service_user())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply-stdin", action="store_true")
    parser.add_argument("--scan", action="store_true")
    args = parser.parse_args()
    try:
        if args.apply_stdin:
            command = json.loads(sys.stdin.buffer.read().decode("utf-8"))
            print(json.dumps(apply_command(command), ensure_ascii=False, separators=(",", ":")))
        elif args.scan:
            print(json.dumps(scan_corpus(), ensure_ascii=False, separators=(",", ":")))
        else:
            reconcile_once()
        return 0
    except (ReconcileError, OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        print(f"orcasynapse-hermes-corpus: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
