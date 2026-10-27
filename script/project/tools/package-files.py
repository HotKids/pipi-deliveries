#!/usr/bin/env python3
"""Git-owned working files shared by packaging and mirror version preparation."""
import argparse
import os
from pathlib import Path
import subprocess
import zipfile

IOS_FILES = {"script.json", "models.ts", "index.tsx", "widget.tsx", "intent.tsx", "app_intents.tsx"}
IOS_DIRECTORIES = {"components", "pages", "services", "contracts", "assets", "widget"}


def is_ios_file(path):
    return (not path.lower().endswith(".md")
            and not any(part.startswith(".") for part in path.split("/"))
            and (path in IOS_FILES or path.split("/", 1)[0] in IOS_DIRECTORIES))


def package_files(project):
    indexed = subprocess.check_output(["git", "ls-files", "--cached", "-z", "--", ".", "../README.md"],
                                      cwd=project)
    files = {}
    for raw in indexed.split(b"\0"):
        path = os.fsdecode(raw)
        relative = "README.md" if path == "../README.md" else path
        source = project / path
        if (path == "../README.md" or is_ios_file(path)) and source.is_file():
            files[relative] = source
    return dict(sorted(files.items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    files = package_files(Path(__file__).resolve().parents[1])
    if args.archive is None:
        for relative in files:
            print(relative)
    else:
        with zipfile.ZipFile(args.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for relative, source in files.items():
                archive.write(source, relative)


if __name__ == "__main__":
    main()
