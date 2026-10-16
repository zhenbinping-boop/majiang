#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校验远程 commit 的文件与本地逐字节一致（git blob SHA-1）。"""
import hashlib
import json
import os
import subprocess
import sys

SLUG = "zhenbinping-boop/majiang"
PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
TOKEN = sys.argv[1]
COMMIT = sys.argv[2]


def api(path):
    cmd = ["curl", "-sS", "--max-time", "60", "--proxy", PROXY,
           "-H", "Authorization: Bearer " + TOKEN,
           "-H", "Accept: application/vnd.github+json",
           "https://api.github.com" + path]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        print("API 解析失败:", path, p.stdout[:200])
        raise


commit = api("/repos/%s/git/commits/%s" % (SLUG, COMMIT))
tree = commit["tree"]["sha"]
items = api("/repos/%s/git/trees/%s?recursive=1" % (SLUG, tree))["tree"]
remote = {i["path"]: i["sha"] for i in items if i["type"] == "blob"}

EX = {"shots", "node_modules", ".git", "__pycache__", ".cache", ".venv"}
SKIP = {"tests/push_via_api.py", "tests/push_via_api.sh"}


def gitsha(path):
    d = open(path, "rb").read()
    return hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest()


bad, checked = [], 0
for dp, dn, fn in os.walk("."):
    dn[:] = [d for d in dn if d not in EX]
    for f in fn:
        if f.endswith(".log") or f in (".DS_Store", "Thumbs.db"):
            continue
        rel = os.path.relpath(os.path.join(dp, f), ".").replace("\\", "/")
        if rel in SKIP:
            continue
        if rel not in remote:
            bad.append("缺失: " + rel)
            continue
        if gitsha(os.path.join(dp, f)) != remote[rel]:
            bad.append("不一致: " + rel)
        checked += 1

print("远程 blob 数:", len(remote), " 本地校验数:", checked)
print("结果:", "全部一致 ✓" if not bad else "\n".join(bad))
