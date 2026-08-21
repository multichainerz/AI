#!/usr/bin/env python3
"""OrcaSynapse VM2 Hermes artifact publisher.

Agent runs leave their deliverables on this node's filesystem; nothing else
tells the control plane those files exist. This companion watches the
conventional artifact root -- one directory per Hermes session, files beneath
it -- and publishes what it finds over the node-signed channel, so a person
can list and download a run's output from the dashboard after the run ends.

Publish, never mirror: the corpus reconciler synchronizes *desired state* the
control plane approves onto this node, while this script reports *output* that
already exists. The two stay separate scripts on separate timers so an
artifact bug can never stall corpus reconciliation, and vice versa.

Layout: ``<ORCASYNAPSE_HERMES_ARTIFACT_ROOT>/<sessionId>/<relative path>``.
The session directory name is the attribution: the control plane resolves it
to the run it authorized and refuses anything it never issued, so files in a
mistyped directory are reported here and skipped, not stored unattributed.

Files at or under 4 MiB travel inline (base64 in signed JSON) and are retained
centrally; larger files are published as metadata so the dashboard can say
they exist without holding them. Files matching the corpus reconciler's secret
denylist are downgraded to metadata-only: their existence is honest to report,
their bytes are not ours to copy off the node.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FORMAT_ARTIFACTS = "orcasynapse-hermes-artifacts/v1"
INLINE_LIMIT_BYTES = 4 * 1024 * 1024
OBSERVE_LIMIT_BYTES = 1024 * 1024 * 1024
BATCH_MAX_FILES = 20
MAX_FILES_PER_SESSION = 200

STATE_ROOT = Path(os.environ.get("ORCASYNAPSE_HERMES_STATE_ROOT", "/var/lib/orcasynapse-hermes"))
ARTIFACT_ROOT = Path(os.environ.get("ORCASYNAPSE_HERMES_ARTIFACT_ROOT", str(STATE_ROOT / "artifacts")))
PUBLISH_STATE = STATE_ROOT / "artifact-publisher-state.json"

SESSION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
TEXT_SUFFIXES = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".py", ".sh",
    ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".sql", ".csv",
    ".xml", ".ini", ".cfg", ".conf", ".jinja", ".j2",
}
MEDIA_TYPES = {
    ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
    ".csv": "text/csv", ".html": "text/html", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".zip": "application/zip",
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


class PublishError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def read_state(name: str) -> str:
    value = (STATE_ROOT / name).read_text(encoding="utf-8").strip()
    if not value:
        raise PublishError(f"missing protected runtime state: {name}")
    return value


def signed_headers(method: str, path: str, body: Any) -> dict[str, str]:
    """Sign one operation, not any operation carrying the same body.

    Identical to the corpus reconciler's construction on purpose: the control
    plane rebuilds exactly these bytes in ``signatureMessage``, and method and
    path are part of them so a signature captured from one route is worthless
    on another.
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
            raise PublishError("could not sign the artifact request with the enrolled node identity")
        signature = base64.urlsafe_b64encode(Path(signature_file.name).read_bytes()).decode("ascii").rstrip("=")
    return {
        # An explicit product identity, because the default is a block: bare
        # urllib announces "Python-urllib", which Cloudflare's Browser
        # Integrity Check refuses with error 1010 before the control plane
        # ever sees the request. The curl-based node clients pass; these two
        # failed on any Cloudflare-fronted deployment until this header.
        "User-Agent": "orcasynapse-hermes-artifacts/1.0",
        "x-orcasynapse-node-timestamp": timestamp,
        "x-orcasynapse-node-nonce": nonce,
        "x-orcasynapse-node-signature": signature,
    }


def request_json(method: str, path: str, body: Any) -> Any:
    base = read_state("control-plane-url").rstrip("/")
    payload = canonical(body)
    headers = signed_headers(method, path, body)
    headers["content-type"] = "application/json"
    request = urllib.request.Request(f"{base}{path}", data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(4_096).decode("utf-8", "replace")
        raise PublishError(f"control plane refused artifact upload ({error.code}): {detail}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise PublishError(f"artifact control-plane request failed: {error}") from error


def load_publish_state() -> dict[str, str]:
    try:
        value = json.loads(PUBLISH_STATE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_publish_state(state: dict[str, str]) -> None:
    # Best effort: the ingest is idempotent per (run, path), so losing this
    # file costs one redundant upload per artifact, never a duplicate row.
    try:
        PUBLISH_STATE.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    except OSError:
        pass


def media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in MEDIA_TYPES:
        return MEDIA_TYPES[suffix]
    if suffix in TEXT_SUFFIXES:
        return "text/plain"
    return "application/octet-stream"


def looks_secret(name: str, content: bytes | None) -> bool:
    lowered = name.lower()
    if lowered in DENIED_NAMES or Path(lowered).suffix in DENIED_SUFFIXES:
        return True
    if content is not None:
        return any(pattern.search(content) for pattern in SECRET_PATTERNS)
    return False


def session_files(session_dir: Path) -> list[Path]:
    """List regular files under the session without following any symlink.

    ``Path.rglob`` follows directory symlinks, so ``escape -> /etc`` used to
    yield ``escape/passwd`` as a regular file whose ``read_bytes()`` then
    copied host material. ``os.walk(..., followlinks=False)`` plus skipping
    symlink directories keeps every path under the session root.
    """
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(session_dir, followlinks=False):
        current = Path(dirpath)
        dirnames[:] = sorted(
            name for name in dirnames
            if not name.startswith(".") and not (current / name).is_symlink()
        )
        for name in sorted(filenames):
            if len(files) >= MAX_FILES_PER_SESSION:
                print(f"note: {session_dir.name}: more than {MAX_FILES_PER_SESSION} files; the rest wait for the next pass", file=sys.stderr)
                return files
            if name.startswith("."):
                continue
            path = current / name
            if path.is_symlink() or not path.is_file():
                continue
            files.append(path)
    return files


def open_nofollow(path: Path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return os.open(path, flags)


def read_regular_file(path: Path) -> bytes:
    with os.fdopen(open_nofollow(path), "rb") as handle:
        return handle.read()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with os.fdopen(open_nofollow(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def publish_session(node_id: str, session_dir: Path, state: dict[str, str]) -> int:
    entries: list[dict[str, Any]] = []
    present: set[str] = set()
    for path in session_files(session_dir):
        stat = path.lstat()
        if stat.st_size > OBSERVE_LIMIT_BYTES:
            print(f"note: skipping {path}: beyond the 1 GiB observation limit", file=sys.stderr)
            continue
        relative = path.relative_to(session_dir).as_posix()
        state_key = f"{session_dir.name}/{relative}"
        present.add(relative)
        content: bytes | None = None
        try:
            if stat.st_size <= INLINE_LIMIT_BYTES:
                content = read_regular_file(path)
                digest = hashlib.sha256(content).hexdigest()
            else:
                digest = sha256_file(path)
        except OSError as error:
            print(f"note: skipping {path}: {error}", file=sys.stderr)
            continue
        if state.get(state_key) == digest:
            continue
        if looks_secret(path.name, content):
            # Existence is honest to report; the bytes are not ours to copy.
            content = None
        entries.append({
            "path": relative,
            "mediaType": media_type(path),
            "sizeBytes": str(len(content) if content is not None else stat.st_size),
            "sha256": digest,
            "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "contentBase64": base64.b64encode(content).decode("ascii") if content is not None else None,
            "_state_key": state_key,
        })

    # Tombstones: paths this publisher once reported that are gone from disk.
    # Only ever a reconciliation hint -- the control plane drops the row solely
    # for files it never retained (`storage: NODE`); an inline artifact
    # survives node cleanup on purpose.
    prefix = f"{session_dir.name}/"
    removed = sorted(key[len(prefix):] for key in state if key.startswith(prefix) and key[len(prefix):] not in present)

    published = 0
    batches: list[dict[str, Any]] = []
    for start in range(0, len(entries), BATCH_MAX_FILES):
        batch = entries[start:start + BATCH_MAX_FILES]
        batches.append({
            "format": FORMAT_ARTIFACTS,
            "observedAt": utc_now(),
            "sessionId": session_dir.name,
            "artifacts": [{key: value for key, value in entry.items() if key != "_state_key"} for entry in batch],
            "removedPaths": [],
            "_batch": batch,
        })
    if removed and batches:
        batches[0]["removedPaths"] = removed[:200]
    elif removed:
        batches.append({
            "format": FORMAT_ARTIFACTS, "observedAt": utc_now(), "sessionId": session_dir.name,
            "artifacts": [], "removedPaths": removed[:200], "_batch": [],
        })
    for body in batches:
        batch = body.pop("_batch")
        request_json("POST", f"/api/v1/runtime-nodes/{node_id}/artifacts", body)
        for entry in batch:
            state[entry["_state_key"]] = entry["sha256"]
        if body["removedPaths"]:
            # Forget a tombstone only after the control plane accepted it, so a
            # failed pass reports it again rather than never.
            for relative in body["removedPaths"]:
                state.pop(f"{session_dir.name}/{relative}", None)
        published += len(batch)
    return published


def scan() -> int:
    node_id = read_state("node-id")
    if not ARTIFACT_ROOT.is_dir():
        # Nothing has produced an artifact yet. Not an error: the directory
        # appears with the first run that writes into it.
        return 0
    state = load_publish_state()
    published = 0
    failures = 0
    for session_dir in sorted(ARTIFACT_ROOT.iterdir()):
        if not session_dir.is_dir() or session_dir.is_symlink():
            continue
        if not SESSION_NAME.match(session_dir.name):
            print(f"note: skipping {session_dir}: not a plausible session directory name", file=sys.stderr)
            continue
        try:
            published += publish_session(node_id, session_dir, state)
        except PublishError as error:
            # A refused session (mistyped directory, or a run this control
            # plane never authorized) must not block the sessions after it.
            print(f"warning: {session_dir.name}: {error}", file=sys.stderr)
            failures += 1
    save_publish_state(state)
    print(f"artifact publish pass complete: {published} file(s) published, {failures} session(s) refused")
    return 1 if failures > 0 and published == 0 else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan", action="store_true", help="publish one pass of the artifact root (the default)")
    parser.parse_args()
    try:
        return scan()
    except PublishError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
