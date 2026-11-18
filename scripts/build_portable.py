"""Build the self-contained Windows x64 folder and a ZIP with the user's data.

Run with .venv/Scripts/python.exe scripts/build_portable.py [--skip-freeze] [--no-zip].
The build reads source data; it never deletes or overwrites source user files.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / ".build"
OUTPUT = ROOT / "portable" / "Pulse"


def application_version() -> tuple[str, str]:
    namespace: dict = {}
    exec((ROOT / "backend" / "version.py").read_text("utf-8"), namespace)
    return namespace["VERSION"], namespace["GITHUB_REPOSITORY"]


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination, follow_symlinks=True)


def copy_data(source: Path, destination: Path) -> None:
    """Copy permanent data only; omit current-machine PIDs, logs and test artifacts."""
    if not source.is_dir():
        return
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        if child.name in {"runtime", "server.json", "server.log", "server-error.log", "browser-tests", "test-fixtures", "portable-checks", "portable-verification"}:
            continue
        if child.is_dir() and child.name in {"media", "exports", "projects"}:
            shutil.copytree(child, destination / child.name, dirs_exist_ok=True)


def create_archive(without_data: bool = False) -> None:
    archive = OUTPUT.parent / "Pulse-Portable-Windows-x64.zip"
    files = [p for p in OUTPUT.rglob("*") if p.is_file() and "runtime" not in p.relative_to(OUTPUT).parts
             and p.relative_to(OUTPUT).parts[:2] != ("data", "updates")
             and (not without_data or p.relative_to(OUTPUT).parts[0] not in {"data", "Project backups"})]
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as output:
        for index, path in enumerate(files, 1):
            # Camera video/music and image files are already compressed.
            # Storing these avoids expensive, ineffective recompression.
            method = zipfile.ZIP_STORED if path.suffix.lower() in {".mov", ".mp4", ".mp3", ".jpg", ".png", ".webp", ".flac", ".zip"} else zipfile.ZIP_DEFLATED
            output.write(path, Path("Pulse") / path.relative_to(OUTPUT), compress_type=method)
            if index % 300 == 0:
                print(f"ZIP {index}/{len(files)}", flush=True)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", "ascii")
    if without_data:
        version, repository = application_version()
        manifest = {"version": version, "repository": repository, "schema": 1,
                    "asset": {"name": archive.name, "size": archive.stat().st_size, "sha256": digest,
                              "url": f"https://github.com/{repository}/releases/download/v{version}/{archive.name}"}}
        (OUTPUT.parent / "pulse-update.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    print(f"ZIP ready: {archive} ({archive.stat().st_size/1024**2:.1f} MiB)", flush=True)


def main() -> None:
    global OUTPUT
    args = argparse.ArgumentParser()
    args.add_argument("--skip-freeze", action="store_true")
    args.add_argument("--no-zip", action="store_true")
    args.add_argument("--zip-only", action="store_true")
    args.add_argument("--without-data", action="store_true", help="Create a public app-only release in release/, excluding all user data.")
    options = args.parse_args()
    OUTPUT = ROOT / ("release" if options.without_data else "portable") / "Pulse"
    if options.zip_only:
        create_archive(options.without_data)
        return
    if sys.platform != "win32":
        raise SystemExit("Build this Windows package on a Windows x64 host.")
    if not (ROOT / "dist" / "index.html").is_file():
        raise SystemExit("Run npm run build first.")
    BUILD.mkdir(exist_ok=True)
    frozen = BUILD / "frozen" / "Pulse"
    # PyInstaller may replace its generated output. Verify those paths are
    # always confined to this build directory, never the user's data folder.
    assert frozen.resolve().is_relative_to(BUILD.resolve())
    if not options.skip_freeze:
        command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--windowed",
                   "--name", "Pulse", "--distpath", str(BUILD / "frozen"),
                   "--workpath", str(BUILD / "pyinstaller"), "--specpath", str(ROOT / "packaging"),
                   "--paths", str(ROOT), "--noupx", "--log-level", "WARN",
                   "--hidden-import", "uvicorn.loops.asyncio", "--hidden-import", "uvicorn.protocols.http.h11_impl",
                   "--hidden-import", "uvicorn.lifespan.on",
                   "--exclude-module", "matplotlib", "--exclude-module", "pandas",
                   "--exclude-module", "IPython", "--exclude-module", "pytest", "--exclude-module", "tkinter"]
        icon = ROOT / "packaging" / "pulse.ico"
        if icon.is_file():
            command += ["--icon", str(icon)]
        command.append(str(ROOT / "portable_runtime.py"))
        subprocess.run(command, cwd=ROOT, check=True)
        helper_command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--windowed",
                          "--name", "PulseUpdater", "--distpath", str(BUILD / "helpers"),
                          "--workpath", str(BUILD / "helper-build"), "--specpath", str(ROOT / "packaging"),
                          "--noupx", "--log-level", "WARN", str(ROOT / "updater_runtime.py")]
        subprocess.run(helper_command, cwd=ROOT, check=True)
    if not (frozen / "Pulse.exe").is_file():
        raise SystemExit("No frozen runtime was created.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    shutil.copytree(frozen, OUTPUT, dirs_exist_ok=True)
    shutil.copytree(ROOT / "dist", OUTPUT / "dist", dirs_exist_ok=True)
    copy_file(BUILD / "helpers" / "PulseUpdater.exe", OUTPUT / "bin" / "PulseUpdater.exe")
    binary_sources: dict[str, Path] = {}
    for name in ("ffmpeg", "ffprobe"):
        found = shutil.which(name)
        if not found:
            raise SystemExit(f"{name} is required on the build host.")
        source = Path(found).resolve()
        copy_file(source, OUTPUT / "bin" / f"{name}.exe")
        binary_sources[name] = source
    if not options.without_data:
        copy_data(ROOT / "data", OUTPUT / "data")
        for project in ROOT.glob("*.pulse.json"):
            copy_file(project, OUTPUT / "Project backups" / project.name)
    (OUTPUT / "Start Pulse.cmd").write_text('@echo off\nstart "" "%~dp0Pulse.exe"\n', encoding="ascii", newline="\r\n")
    (OUTPUT / "Stop Pulse.cmd").write_text('@echo off\nstart "" "%~dp0Pulse.exe" --stop\n', encoding="ascii", newline="\r\n")
    instructions = """Pulse Portable — Windows 10/11 x64

۱. کل پوشهٔ Pulse را از ZIP بیرون بیاورید؛ برنامه را داخل ZIP اجرا نکنید.
۲. روی Pulse.exe یا Start Pulse.cmd دوبار کلیک کنید.
۳. مرورگر پیش‌فرض باز می‌شود. نصب Python، Node یا FFmpeg لازم نیست؛ اینترنت هم لازم نیست.

پروژه‌ها خودکار در data/projects ذخیره می‌شوند. فایل‌های اصلی و پیش‌نمایش‌ها در data/media
و خروجی‌ها در data/exports هستند. برای انتقال یا بکاپ، کل همین پوشهٔ Pulse را همراه data
کپی یا ZIP کنید. اجرای EXE به‌تنهایی از یک پوشهٔ دیگر کافی نیست.

قبل از جابه‌جایی اجازه دهید رندر تمام شود، وضعیت Saved to folder را ببینید، سپس با
Stop Pulse.cmd سرور را ببندید. بستن تب مرورگر به‌تنهایی سرور پس‌زمینه را نمی‌بندد.

برنامه را در پوشه‌ای که اجازهٔ نوشتن دارد باز کنید، مثلاً Documents یا یک USB writable.
همهٔ پردازش‌ها روی همین دستگاه‌اند و سرور فقط روی 127.0.0.1 اجرا می‌شود.

در صورت اشغال پورت 8765، یک پورت آزاد انتخاب و مرورگر روی همان آدرس باز می‌شود.
برای بازکردن یک نسخهٔ درحال اجرا دوباره Pulse.exe را اجرا کنید.
گزارش خطا: data/runtime/pulse.log

برای آپدیت، دکمهٔ Check for updates بالای برنامه را بزنید. آپدیت فقط با درخواست شما
از GitHub دانلود می‌شود و اینترنت لازم دارد. پیش از نصب، پروژه ذخیره می‌شود؛ پوشهٔ data
شامل مدیا، پروژه‌ها و خروجی‌ها حفظ می‌شود و برنامه پس از نصب دوباره باز می‌شود.

خروجی‌های فعلی SDR / BT.709 هستند؛ HDR آیفون برای خروجی SDR تبدیل رنگ می‌شود.
فایل‌های اصلی HDR بدون تغییر نگه داشته می‌شوند.

برای سیستم مقصد نصب یک مرورگر معمول مثل Edge که همراه ویندوز است کافی است.
این بسته برای Windows x64 ساخته شده؛ برای macOS/Linux یا Windows 32-bit نیست.
"""
    (OUTPUT / "راهنمای اجرا.txt").write_text(instructions, encoding="utf-8-sig")
    copy_file(ROOT / "README.md", OUTPUT / "Developer README.md")
    licenses = OUTPUT / "licenses"
    licenses.mkdir(exist_ok=True)
    ffmpeg_root = binary_sources["ffmpeg"].parent.parent
    for name in ("LICENSE", "README.txt"):
        if (ffmpeg_root / name).is_file():
            copy_file(ffmpeg_root / name, licenses / f"FFmpeg-{name}")
    for python_license_name in ("LICENSE_PYTHON.txt", "LICENSE.txt", "LICENSE"):
        python_license = Path(sys.base_prefix) / python_license_name
        if python_license.is_file():
            copy_file(python_license, licenses / "Python-LICENSE.txt")
            break
    for package in importlib.metadata.distributions():
        name = package.metadata.get("Name", "unknown").replace("/", "-")
        for item in package.files or []:
            if (".dist-info/" in str(item).replace("\\", "/") and
                    ("license" in str(item).lower() or "copying" in item.name.lower())):
                source = Path(package.locate_file(item))
                if source.is_file():
                    copy_file(source, licenses / name / item.name)
    versions = {name: importlib.metadata.version(name) for name in ("pyinstaller", "fastapi", "uvicorn", "numpy", "scipy")}
    versions["python"] = sys.version.split()[0]
    versions["ffmpeg"] = subprocess.check_output([str(binary_sources["ffmpeg"]), "-version"], text=True).splitlines()[0]
    version, repository = application_version()
    (OUTPUT / "build-info.json").write_text(json.dumps({"version": version, "repository": repository,
        "target": "windows-x86_64", "versions": versions, "portableFormat": 1,
        "userdata": ["data/media", "data/projects", "data/exports"], "offline": True,
        "updates": "user-triggered GitHub releases"}, indent=2), "utf-8")
    (licenses / "THIRD-PARTY.txt").write_text(
        "Pulse bundles Python and the third-party libraries listed in build-info.json.\n"
        "Their license notices are included in this directory.\n"
        "FFmpeg build: https://www.gyan.dev/ffmpeg/builds/\n"
        "FFmpeg source and licenses: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html\n"
        "PyInstaller: https://pyinstaller.org/\n", "utf-8")
    files = [p for p in OUTPUT.rglob("*") if p.is_file() and "runtime" not in p.relative_to(OUTPUT).parts]
    size = sum(p.stat().st_size for p in files)
    print(f"Portable folder ready: {OUTPUT} ({len(files)} files, {size/1024**2:.1f} MiB)", flush=True)
    if not options.no_zip:
        create_archive(options.without_data)


if __name__ == "__main__":
    main()
