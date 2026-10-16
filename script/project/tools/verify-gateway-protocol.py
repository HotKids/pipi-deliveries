#!/usr/bin/env python3
"""Offline delivery pairing; live-version verification remains a release prerequisite."""
import argparse
from datetime import datetime
from pathlib import Path
import re
import sys
import time
import zipfile


LEGACY_EXPIRES_AT_MS = int(datetime.fromisoformat("2026-11-01T00:00:00+08:00").timestamp() * 1000)


def verify(client_track, origin, protocol, worker, now_ms=None):
    expected = {"formal": "https://pipiassistant.app", "beta": "https://beta.pipiassistant.app"}
    if client_track not in expected or origin != expected[client_track]:
        raise ValueError("Client track and gateway origin do not match")
    if client_track == "beta" and protocol != "2":
        raise ValueError("Beta delivery requires protocol v2; do not distribute this candidate")
    if protocol == "1" and (time.time() * 1000 if now_ms is None else now_ms) >= LEGACY_EXPIRES_AT_MS:
        raise ValueError("Client protocol v1 has expired; do not distribute this candidate")
    supported = set()
    if re.search(r'SCRIPTING_PROTOCOL_VERSION\s*=\s*[\"\']1[\"\']', worker) and "x-scripting-token" in worker:
        supported.add("1")
    if (re.search(r'SCRIPTING_V2_PROTOCOL_VERSION\s*=\s*[\"\']2[\"\']', worker)
            and "authenticateScriptingV2" in worker and "x-scripting-key-id" in worker):
        supported.add("2")
    if protocol not in supported:
        raise ValueError(f"Client protocol v{protocol} is unsupported by the {client_track} Worker artifact; do not distribute this candidate")
    selected = max(supported)
    if protocol != selected:
        raise ValueError(f"The {client_track} Worker artifact requires the client to select protocol v{selected}; do not distribute this candidate")


def declaration(source, name):
    match = re.search(rf'export const {name}\s*=\s*"([^"\n]+)"', source)
    if not match:
        raise ValueError(f"Missing client declaration: {name}")
    return match[1]


def client_protocol(track_source, auth_source):
    if re.search(r"\bSCRIPTING_GATEWAY_PROTOCOL_VERSION\b", track_source):
        return declaration(track_source, "SCRIPTING_GATEWAY_PROTOCOL_VERSION")
    # Historical archives declared their single supported protocol in the auth module.
    return declaration(auth_source, "SCRIPTING_PROTOCOL_VERSION")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--worker-artifact", type=Path,
                        help="Exact target-track Worker artifact already verified by the release owner")
    args = parser.parse_args()
    with zipfile.ZipFile(args.archive) as archive:
        def source(name):
            info = archive.getinfo(name)
            if info.file_size > 256 * 1024:
                raise ValueError("Client protocol source exceeds the inspection limit")
            return archive.read(info).decode("utf-8")
        track_source = source("services/build-track.ts")
        track = declaration(track_source, "SCRIPT_BUILD_TRACK")
        origin = declaration(track_source, "GATEWAY_ORIGIN")
        protocol = client_protocol(track_source, source("services/scripting-auth.ts"))
    worker = args.worker_artifact
    if worker is None:
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "cloudflare/express-gateway/src" / ("worker.js" if track == "formal" else "worker.beta.js")
            if candidate.is_file():
                worker = candidate
                break
    if worker is None or not worker.is_file():
        raise ValueError("Delivery requires the verified target Worker artifact; pass --worker-artifact (source-only candidates may still be packaged)")
    if worker.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Worker artifact exceeds the inspection limit")
    verify(track, origin, protocol, worker.read_text())
    print(f"Offline delivery protocol pair verified: {track}, v{protocol}; live readiness must also be verified")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
