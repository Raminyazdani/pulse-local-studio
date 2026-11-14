"""User-triggered updates from this application's public GitHub Releases."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .media import CREATE_FLAGS, DATA, ROOT
from .version import GITHUB_REPOSITORY, VERSION
from updater_runtime import sha256_file, validate_archive, version_tuple, write_json

MAX_DOWNLOAD = 2 * 1024**3
LOCK = threading.RLock()
STATE: dict = {"status": "idle", "progress": 0}
MANIFEST: dict | None = None
LAST_RECEIPT: tuple | None = None


def configured_repository() -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", GITHUB_REPOSITORY):
        raise ValueError("A GitHub update repository has not been configured.")
    return GITHUB_REPOSITORY


def validate_url(url: str, repository: str | None = None, *, api: bool = False, redirect: bool = False) -> str:
    if not isinstance(url, str):
        raise ValueError("Invalid GitHub update URL.")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Update downloads require HTTPS GitHub URLs.")
    host = (parsed.hostname or "").casefold()
    if api:
        if host != "api.github.com":
            raise ValueError("Update metadata must come from the GitHub API.")
    elif host == "github.com":
        if repository and not urllib.parse.unquote(parsed.path).casefold().startswith(f"/{repository}/releases/download/".casefold()):
            raise ValueError("Update asset does not belong to this repository.")
    elif not (redirect and host.endswith(".githubusercontent.com")):
        raise ValueError("Update asset was redirected outside GitHub.")
    return url


class GitHubRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, repository: str):
        super().__init__()
        self.repository = repository

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_url(newurl, self.repository, redirect=True)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def open_github(url: str, repository: str, *, api: bool = False):
    validate_url(url, repository, api=api)
    headers = {"User-Agent": f"Pulse-Local-Studio/{VERSION}", "Accept": "application/vnd.github+json" if api else "application/octet-stream"}
    if api:
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    opener = urllib.request.build_opener(GitHubRedirects(repository))
    return opener.open(urllib.request.Request(url, headers=headers), timeout=30)


def fetch_json(url: str, repository: str, *, api: bool = False, maximum: int = 1024 * 1024) -> dict:
    with open_github(url, repository, api=api) as response:
        raw = response.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("GitHub update metadata is larger than expected.")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Invalid GitHub release metadata.")
    return value


def validate_manifest(value: dict, repository: str, latest: str) -> dict:
    if value.get("repository", "").casefold() != repository.casefold() or value.get("version") != latest:
        raise ValueError("Update manifest does not match the selected repository and release version.")
    version_tuple(value["version"])
    asset = value.get("asset")
    if not isinstance(asset, dict) or not isinstance(asset.get("name"), str) or not asset["name"].endswith(".zip"):
        raise ValueError("Update manifest does not contain a portable ZIP asset.")
    if not isinstance(asset.get("sha256"), str) or not re.fullmatch(r"[a-fA-F0-9]{64}", asset["sha256"]):
        raise ValueError("Update manifest must include a SHA-256 checksum.")
    if isinstance(asset.get("size"), bool) or not isinstance(asset.get("size"), int) or not 0 < asset["size"] <= MAX_DOWNLOAD:
        raise ValueError("Update package size is invalid.")
    validate_url(asset.get("url"), repository)
    if urllib.parse.unquote(urllib.parse.urlsplit(asset["url"]).path).split("/")[-1] != asset["name"]:
        raise ValueError("Update asset URL and name do not match.")
    return copy.deepcopy(value)


def update_status() -> dict:
    global LAST_RECEIPT
    with LOCK:
        portable = os.environ.get("PULSE_PORTABLE") == "1"
        receipt_path = DATA / "updates" / "last-result.json"
        try:
            receipt = json.loads(receipt_path.read_text("utf-8"))
            key = (receipt.get("transactionId"), receipt.get("status"), receipt.get("timestamp"))
            if key != LAST_RECEIPT:
                LAST_RECEIPT = key
                # Historical results are startup context only. Never replace a
                # fresh check/download result with an older completion receipt.
                history_only = STATE.get("status") == "idle" or STATE.get("_fromReceipt") is True
                if history_only and receipt.get("status") == "complete" and receipt.get("version") == VERSION:
                    STATE.update(status="up-to-date", progress=1, message=receipt.get("message"), latestVersion=VERSION, _fromReceipt=True)
                elif history_only and receipt.get("status") in {"error", "rolled-back"}:
                    STATE.update(status="error", progress=0, error=receipt.get("message"), message=receipt.get("message"), _fromReceipt=True)
        except (OSError, ValueError):
            pass
        result = {"currentVersion": VERSION, "repository": GITHUB_REPOSITORY,
                  "portable": portable, **copy.deepcopy({key: value for key, value in STATE.items() if not key.startswith("_")})}
        if not portable and result["status"] == "idle":
            result.update(status="unsupported", message="Automatic installation is available in the portable Windows app.")
        return result


def is_installing() -> bool:
    with LOCK:
        return STATE.get("status") in {"downloading", "ready", "installing"}


def _error(exc: Exception) -> None:
    message = str(exc)
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 404:
            message = "No public release is available yet, or the update repository is not accessible."
        elif exc.code in {403, 429}:
            message = "GitHub temporarily limited update checks. Try again later."
    with LOCK:
        STATE.update(status="error", progress=0, error=message, message=message, _fromReceipt=False)


def _check() -> None:
    global MANIFEST
    try:
        with LOCK:
            STATE["_fromReceipt"] = False
        repository = configured_repository()
        release = fetch_json(f"https://api.github.com/repos/{repository}/releases/latest", repository, api=True)
        if release.get("draft") or release.get("prerelease"):
            raise ValueError("Only stable published releases can be installed.")
        latest = str(release.get("tag_name", "")).removeprefix("v")
        version_tuple(latest)
        release_url = f"https://github.com/{repository}/releases/tag/v{latest}"
        with LOCK:
            STATE.update(latestVersion=latest, releaseUrl=release_url,
                         changelog=str(release.get("body") or "")[:20000])
        if version_tuple(latest) <= version_tuple(VERSION):
            with LOCK:
                MANIFEST = None
                STATE.update(status="up-to-date", progress=1, message="You are running the latest stable version.")
            return
        manifest_asset = next((asset for asset in release.get("assets", []) if asset.get("name") == "pulse-update.json"), None)
        if not manifest_asset:
            raise ValueError("This release does not contain an automatic-update manifest.")
        manifest = validate_manifest(fetch_json(manifest_asset["browser_download_url"], repository), repository, latest)
        published_asset = next((asset for asset in release.get("assets", []) if asset.get("name") == manifest["asset"]["name"]), None)
        if not published_asset or published_asset.get("size") != manifest["asset"]["size"] or published_asset.get("browser_download_url") != manifest["asset"]["url"]:
            raise ValueError("The update manifest does not match GitHub's published release asset.")
        published_digest = published_asset.get("digest")
        if published_digest and published_digest.lower() != "sha256:" + manifest["asset"]["sha256"].lower():
            raise ValueError("GitHub's release asset digest does not match the update manifest.")
        with LOCK:
            MANIFEST = manifest
            STATE.update(status="available", progress=0, message=f"Version {latest} is available.")
    except Exception as exc:
        _error(exc)


def start_check() -> dict:
    with LOCK:
        if STATE.get("status") in {"checking", "downloading", "ready", "installing"}:
            return update_status()
        STATE.clear()
        STATE.update(status="checking", progress=0, message="Checking GitHub Releases…")
        threading.Thread(target=_check, daemon=True, name="pulse-update-check").start()
    return update_status()


def _install(manifest: dict, on_ready_to_exit, port: int) -> None:
    stage = None
    helper_process = None
    try:
        repository = configured_repository()
        asset = manifest["asset"]
        stage = DATA / "updates" / str(uuid.uuid4())
        stage.mkdir(parents=True)
        archive = stage / "package.zip"
        downloaded = 0
        with open_github(asset["url"], repository) as response, archive.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > asset["size"] or downloaded > MAX_DOWNLOAD:
                    raise ValueError("Update download exceeded its expected size.")
                output.write(chunk)
                with LOCK:
                    STATE["progress"] = min(.95, downloaded / asset["size"] * .95)
        if downloaded != asset["size"] or sha256_file(archive).lower() != asset["sha256"].lower():
            raise ValueError("The downloaded update failed its size or SHA-256 verification. Nothing was installed.")
        validate_archive(archive)
        helper = stage / "PulseUpdater.exe"
        shutil.copy2(ROOT / "bin" / "PulseUpdater.exe", helper)
        plan = {"schema": 1, "appRoot": str(ROOT), "dataDir": str(DATA), "version": manifest["version"],
                "currentVersion": VERSION, "sha256": asset["sha256"].lower(), "size": downloaded,
                "parentPid": os.getpid(), "port": port}
        write_json(stage / "plan.json", plan)
        with LOCK:
            STATE.update(status="ready", progress=1, message="Update verified. Restarting Pulse…")
        helper_process = subprocess.Popen([str(helper), "--plan", str(stage / "plan.json")], cwd=stage, creationflags=CREATE_FLAGS)
        until = time.monotonic() + 120
        while time.monotonic() < until:
            try:
                ready = json.loads((stage / "helper-ready.json").read_text("utf-8"))
                if ready.get("ready") is True and ready.get("version") == manifest["version"] and ready.get("sha256") == plan["sha256"]:
                    break
            except (OSError, ValueError):
                pass
            if helper_process.poll() is not None:
                raise RuntimeError("The update helper could not prepare the new runtime. Pulse is still running; see the update log.")
            time.sleep(.15)
        else:
            raise RuntimeError("Preparing the update took too long. Pulse is still running; no application files were replaced.")
        with LOCK:
            STATE.update(status="installing", message="Installing the update and restarting Pulse…")
        on_ready_to_exit()
    except Exception as exc:
        if stage is not None and helper_process is not None:
            try:
                write_json(stage / "cancelled.json", {"cancelled": True})
            except OSError:
                pass
        _error(exc)


def start_install(on_ready_to_exit, port: int) -> dict:
    with LOCK:
        if is_installing():
            return update_status()
        if os.environ.get("PULSE_PORTABLE") != "1" or not (ROOT / "Pulse.exe").is_file() or not (ROOT / "bin" / "PulseUpdater.exe").is_file():
            raise ValueError("Use the current portable Windows package to install updates automatically.")
        if MANIFEST is None or STATE.get("status") != "available":
            raise ValueError("Check for an available update before installing.")
        if version_tuple(MANIFEST["version"]) <= version_tuple(VERSION):
            raise ValueError("An equal or older version cannot replace this application.")
        if not callable(on_ready_to_exit):
            raise ValueError("This app instance cannot restart automatically.")
        manifest = copy.deepcopy(MANIFEST)
        STATE.update(status="downloading", progress=0, message="Downloading the verified portable update…")
        threading.Thread(target=_install, args=(manifest, on_ready_to_exit, port), daemon=True, name="pulse-update-install").start()
    return update_status()
