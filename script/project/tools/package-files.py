#!/usr/bin/env python3
"""Package files from the Git index, or a source archive without a work tree."""
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
    project = project.resolve()
    ceilings = {Path(path).resolve() for path in os.environ.get("GIT_CEILING_DIRECTORIES", "").split(os.pathsep)
                if path}
    git_owned = bool(os.environ.get("GIT_DIR") or os.environ.get("GIT_WORK_TREE"))
    for parent in (project, *project.parents):
        if parent != project and parent in ceilings:
            break
        if os.path.lexists(parent / ".git"):
            git_owned = True
            break
    if git_owned:
        # Broken metadata or a missing Git executable must not include untracked files.
        root = Path(subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], cwd=project,
            stderr=subprocess.PIPE).decode().strip()).resolve()
        if not project.is_relative_to(root):
            raise RuntimeError("The discovered Git work tree does not own this Scripting project")
        indexed = subprocess.check_output(
            ["git", "ls-files", "--cached", "-z", "--", ".", "../README.md"],
            cwd=project, stderr=subprocess.PIPE)
        paths = [os.fsdecode(raw) for raw in indexed.split(b"\0")]
        if "script.json" not in paths:
            raise RuntimeError("The discovered Git index does not track this project's script.json")
    else:
        paths = ["../README.md", *(path.relative_to(project).as_posix()
                                  for path in project.rglob("*") if path.is_file())]
    files = {}
    for path in paths:
        relative = "README.md" if path == "../README.md" else path
        source = project / path
        if (path == "../README.md" or is_ios_file(path)) and source.is_file():
            files[relative] = source
    return dict(sorted(files.items()))


def temporary_root(project):
    mirror = project.resolve().parents[1]
    canonical = mirror.parent
    root = canonical if mirror.name == "deliveries" and (canonical / "flutter_app/pubspec.yaml").is_file() else mirror
    return root / "project-data/tmp"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--temp-root", action="store_true")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    if args.temp_root:
        print(temporary_root(project))
        return
    try:
        files = package_files(project)
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "Cannot read the Scripting project's Git work tree or index"
        parser.exit(1, message + "\n")
    if args.archive is None:
        for relative in files:
            print(relative)
    else:
        with zipfile.ZipFile(args.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for relative, source in files.items():
                archive.write(source, relative)


if __name__ == "__main__":
    main()
