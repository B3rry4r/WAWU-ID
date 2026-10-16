#!/usr/bin/env python3
"""deploy-build-in-sync (OPS-CI).

.github/workflows/branch-checks.yml runs the same steps on every task branch
that deploy.yml's `build` job runs after a merge. Its steps are a COPY, because
a workflow cannot call another workflow's job. A copy that drifts would let a
branch go green on checks that are not the deploy's, which is the failure
OPS-CI exists to stop. This script fails the moment the two differ.

What is compared: deploy.yml `jobs.build` against `jobs.build` of the copy,
parsed with a YAML loader (so comments, blank lines and quoting do not matter).

  * Job level, every key except those in JOB_KEYS_IGNORED: `runs-on`,
    `services` (the Postgres service) and `env`.
  * Steps, every key of every step except `name`, in the same order.

The only things ignored, all of them documented here:

  1. A step's `name`.
  2. The last step of the copy, when it has `id: result`: the step that prints
     the job's result as its last log line. It is the copy's own.
  3. Job keys in JOB_KEYS_IGNORED: `name`, `needs` and `steps` (the job's
     display name, its order, and the steps compared separately).

Usage: python3 scripts/ci/check_deploy_in_sync.py [deploy.yml] [branch-checks.yml]
The last line printed is "IN-SYNC OK" or "IN-SYNC FAIL". Exit 0 or 1.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
JOB = "build"
JOB_KEYS_IGNORED = {"name", "needs", "steps"}


def load_jobs(path: Path) -> dict:
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as err:
        print(f"{path.name} is not valid YAML: {str(err).splitlines()[0]}")
        print("IN-SYNC FAIL")
        sys.exit(1)
    return doc.get("jobs") or {}


def normalise(step: dict) -> dict:
    return {k: v for k, v in step.items() if k != "name"}


def describe(step: dict | None) -> str:
    if step is None:
        return "(missing)"
    text = step.get("run") or step.get("uses") or "?"
    return str(text).strip().splitlines()[0][:100]


def main() -> int:
    deploy_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".github/workflows/deploy.yml"
    copy_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / ".github/workflows/branch-checks.yml"
    deploy = load_jobs(deploy_path).get(JOB)
    copy = load_jobs(copy_path).get(JOB)
    problems: list[str] = []
    if not deploy:
        problems.append(f"{deploy_path.name} has no job `{JOB}`")
    if not copy:
        problems.append(f"{copy_path.name} has no job `{JOB}`")
    if problems:
        print("\n".join(problems))
        print("IN-SYNC FAIL")
        return 1

    want_keys = {k: v for k, v in deploy.items() if k not in JOB_KEYS_IGNORED}
    got_keys = {k: v for k, v in copy.items() if k not in JOB_KEYS_IGNORED}
    for key in sorted(set(want_keys) | set(got_keys)):
        if want_keys.get(key) != got_keys.get(key):
            problems.append(
                f"job key `{key}` differs\n"
                f"    deploy.yml    : {want_keys.get(key)!r}\n"
                f"    branch-checks : {got_keys.get(key)!r}"
            )

    steps = list(copy.get("steps", []))
    if steps and steps[-1].get("id") == "result":
        steps = steps[:-1]
    else:
        problems.append("the last step must have `id: result` (it prints the job's result)")
    want = [normalise(s) for s in deploy.get("steps", [])]
    got = [normalise(s) for s in steps]
    for i in range(max(len(want), len(got))):
        w = want[i] if i < len(want) else None
        g = got[i] if i < len(got) else None
        if w != g:
            problems.append(
                f"step {i + 1} differs\n"
                f"    deploy.yml    : {describe(w)}\n"
                f"    branch-checks : {describe(g)}"
            )
            break

    if problems:
        print(f"{copy_path.name} is not a copy of the `{JOB}` job in {deploy_path.name}:")
        for p in problems:
            print("  - " + p)
        print("Change both files in the same commit. Never edit this script to make the check pass.")
        print("IN-SYNC FAIL")
        return 1
    print(f"`{JOB}` in {copy_path.name} is a copy of {deploy_path.name}: {len(want)} steps compared")
    print("IN-SYNC OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
