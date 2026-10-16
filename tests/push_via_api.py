#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 GitHub REST API 把本地目录推送到远程仓库（等价于 git push）。

适用：github.com:443 不通、但 api.github.com 经代理可达的网络环境。

用法:
    python push_via_api.py --token <TOKEN> --repo owner/name --root <本地目录> \
        [--branch main] [--message "commit message"] [--exclude shots/,node_modules]

注意：
  * 仓库完全为空时，先用 Contents API 建一个初始文件（见 SKILL.md 第 1 节），
    否则 Git Data API 会返回 409 "Git Repository is empty"。
  * 代理从 HTTPS_PROXY / https_proxy 环境变量读取，不要硬编码端口。
  * 本脚本调用 curl 子进程发请求（curl 通常比 urllib 更容易穿过企业代理）。
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

API = "https://api.github.com"
PROXY = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
         or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or "")

DEFAULT_EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", ".cache", ".venv", "dist", "build"}
DEFAULT_EXCLUDE_FILES = {".DS_Store", "Thumbs.db", "desktop.ini"}
DEFAULT_EXCLUDE_SUFFIX = (".log",)
SAFE_MODE = "100644"
MAX_CONCURRENCY = 4
RETRY_TIMES = 15


def curl(method, path, token, body_file=None):
    cmd = ["curl", "-sS", "--max-time", "120"]
    if PROXY:
        cmd += ["--proxy", PROXY]
    cmd += ["-X", method,
            "-H", "Authorization: Bearer " + token,
            "-H", "Accept: application/vnd.github+json",
            "-H", "X-GitHub-Api-Version: 2022-11-28",
            API + path]
    if body_file:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@" + body_file]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def api(method, path, token, body_file=None, tries=RETRY_TIMES):
    last = ""
    for _ in range(tries):
        rc, out = curl(method, path, token, body_file)
        if rc == 0:
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                last = out[:200]
        else:
            last = out[:200]
        time.sleep(1.5)
    raise RuntimeError("API 失败 %s %s -> %s" % (method, path, last))


def build_walker(root, exclude_dirs, exclude_files, exclude_suffix):
    def walk():
        out = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
            for fn in filenames:
                if fn in exclude_files or fn.endswith(exclude_suffix):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace("\\", "/")
                out.append((rel, full))
        return sorted(out)
    return walk


def upload_blob(slug, token, rel, full):
    raw = open(full, "rb").read()
    try:
        payload = {"content": raw.decode("utf-8"), "encoding": "utf-8"}
    except UnicodeDecodeError:
        payload = {"content": base64.b64encode(raw).decode(), "encoding": "base64"}
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    try:
        b = api("POST", "/repos/%s/git/blobs" % slug, token, tmp)
    finally:
        os.remove(tmp)
    return {"path": rel, "mode": SAFE_MODE, "type": "blob", "sha": b["sha"]}


def write_body(obj):
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    return tmp


def verify(root, slug, token, tree_sha):
    """逐字节校验远程内容与本地一致（git blob SHA-1）。"""
    tree = api("GET", "/repos/%s/git/trees/%s?recursive=1" % (slug, tree_sha), token)
    remote = {t["path"]: t["sha"] for t in tree.get("tree", []) if t["type"] == "blob"}
    missing, mismatch = [], []
    for path, sha in remote.items():
        local_path = os.path.join(root, path)
        if not os.path.exists(local_path):
            missing.append(path)
            continue
        data = open(local_path, "rb").read()
        if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != sha:
            mismatch.append(path)
    return remote, missing, mismatch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--root", default=".")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", default="chore: 同步本地文件")
    ap.add_argument("--exclude", default="", help="额外排除的目录名或相对路径，逗号分隔")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    slug = args.repo
    token = args.token
    extra = {s.strip().strip("/") for s in args.exclude.split(",") if s.strip()}

    exclude_dirs = DEFAULT_EXCLUDE_DIRS | {e for e in extra if "/" not in e}
    exclude_files = DEFAULT_EXCLUDE_FILES | {e for e in extra if "/" in e}

    walker = build_walker(root, exclude_dirs, exclude_files, DEFAULT_EXCLUDE_SUFFIX)
    files = [(rel, full) for rel, full in walker()
             if not any(rel == e or rel.startswith(e + "/") for e in extra)]

    print("=== 仓库 %s | 分支 %s | 代理 %s" % (slug, args.branch, PROXY or "(直连)"))
    print("=== 上传 blobs (%d 个文件，并发 %d) ===" % (len(files), MAX_CONCURRENCY))
    tree_items = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as ex:
        futs = {ex.submit(upload_blob, slug, token, rel, full): rel for rel, full in files}
        for fu in futs:
            item = fu.result()
            print("  ok %s  %s" % (item["sha"][:8], item["path"]), flush=True)
            tree_items.append(item)
    tree_items.sort(key=lambda x: x["path"])

    ref = api("GET", "/repos/%s/git/ref/heads/%s" % (slug, args.branch), token)
    base_sha = ref["object"]["sha"]
    base_commit = api("GET", "/repos/%s/git/commits/%s" % (slug, base_sha), token)
    base_tree = base_commit["tree"]["sha"]
    print("=== base %s / tree %s" % (base_sha[:8], base_tree[:8]))

    tmp = write_body({"base_tree": base_tree, "tree": tree_items})
    tree = api("POST", "/repos/%s/git/trees" % slug, token, tmp)
    os.remove(tmp)
    print("=== tree %s" % tree["sha"][:8])

    tmp = write_body({"message": args.message, "tree": tree["sha"], "parents": [base_sha]})
    commit = api("POST", "/repos/%s/git/commits" % slug, token, tmp)
    os.remove(tmp)
    print("=== commit %s" % commit["sha"][:8])

    tmp = write_body({"sha": commit["sha"], "force": True})
    api("PATCH", "/repos/%s/git/refs/heads/%s" % (slug, args.branch), token, tmp)
    os.remove(tmp)
    print("=== 已更新 %s -> %s" % (args.branch, commit["sha"][:8]))

    if not args.no_verify:
        print("=== 一致性校验 ===")
        remote, missing, mismatch = verify(root, slug, token, tree["sha"])
        print("  远程 blob %d 个 / 本地缺失 %s / 内容不一致 %s"
              % (len(remote), missing or "无", mismatch or "无"))
        if missing or mismatch:
            print(">>> 校验未通过 ✗（CDN 无关，是本次上传有问题）")
            sys.exit(1)
        print(">>> 全部一致 ✓")

    print("\n完成 ✓  https://github.com/%s" % slug)


if __name__ == "__main__":
    main()
