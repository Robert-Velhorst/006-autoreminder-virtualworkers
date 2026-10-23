"""Bounded native PG17 backup. A success receipt is the publication commit marker.

Archive listing verifies readability, NOT a restore. No retention or remote copy.
Only trusted Python callers may override settings; the CLI is production-fixed.
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time


PG_BIN = Path("/usr/lib/postgresql/17/bin")
DIRECTORY = Path("/var/backups/va-dashboard/postgres")
ALLOWANCE = 64 * 1024**2
CHUNK = 64 * 1024
# libpq warns for /dev/null because a password file must be regular. Explicit
# absent paths prevent fallback to the peer account's personal client files.
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
       "HOME": "/nonexistent", "PGPASSFILE": "/nonexistent/va-dashboard-backup.pgpass",
       "PGSERVICEFILE": "/nonexistent/va-dashboard-backup.pg_service.conf", "PGCONNECT_TIMEOUT": "15"}
FAILURE_CODES = frozenset({"backup_already_running", "insufficient_capacity",
                           "deadline_exceeded", "output_limit_exceeded",
                           "child_diagnostics_require_review", "child_failed",
                           "empty_archive", "invalid_archive_signature",
                           "write_failed", "interrupted"})


@dataclass(frozen=True)
class BackupSettings:
    database: str
    directory: Path
    pg_bin: Path = PG_BIN
    reserve_bytes: int = 3 * 1024**3
    max_seconds: float = 1800


class BackupError(RuntimeError):
    """Messages are fixed codes; never include child output or exception details."""


def _validate(settings):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise BackupError("linux_root_required")
    if (not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", settings.database)
            or not settings.directory.is_absolute()
            or ".." in settings.directory.parts
            or settings.directory == Path("/")
            or not settings.pg_bin.is_absolute()
            or not isinstance(settings.reserve_bytes, int)
            or settings.reserve_bytes < 0
            or not math.isfinite(settings.max_seconds)
            or settings.max_seconds <= 0):
        raise BackupError("invalid_settings")


def _verify_directory(fd, private=False):
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o022
            or (private and stat.S_IMODE(info.st_mode) != 0o700)):
        raise BackupError("insecure_directory")


def _directory(path, create):
    """Walk anchored descriptors; never resolve through symlinks or chmod targets."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        _verify_directory(fd)
        for index, part in enumerate(path.parts[1:]):
            try:
                child = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    return fd
                os.mkdir(part, 0o700, dir_fd=fd)
                os.fsync(fd)
                child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            _verify_directory(fd, private=index == len(path.parts) - 2)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _available(fd):
    usage = os.fstatvfs(fd)
    return usage.f_bavail * usage.f_frsize


def _capacity(fd, required):
    # Observational only: unrelated writers can consume space after this check.
    if _available(fd) < required:
        raise BackupError("insufficient_capacity")


def _lock_directory(fd):
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise BackupError("backup_already_running") from None


def _kill_join(process):
    # start_new_session makes this PGID exclusively ours, including runuser children.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    finally:
        process.wait()


def _pump(argv, deadline, consume, stdout_limit):
    """Drain both pipes fairly; no communicate() or unbounded captured output."""
    if time.monotonic() >= deadline:
        raise BackupError("deadline_exceeded")
    process = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env=dict(ENV), cwd="/", shell=False,
        start_new_session=True, close_fds=True)
    try:
        with selectors.DefaultSelector() as selector:
            for pipe, kind in ((process.stdout, "out"), (process.stderr, "err")):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, kind)
            counts = {"out": 0, "err": 0}
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BackupError("deadline_exceeded")
                for key, _ in selector.select(min(remaining, 0.2)):
                    data = os.read(key.fileobj.fileno(), CHUNK)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    kind = key.data
                    counts[kind] += len(data)
                    limit = stdout_limit if kind == "out" else CHUNK
                    if counts[kind] > limit:
                        raise BackupError("output_limit_exceeded")
                    if kind == "err":
                        raise BackupError("child_diagnostics_require_review")
                    consume(data)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BackupError("deadline_exceeded")
            try:
                result = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise BackupError("deadline_exceeded") from None
            if result != 0:
                raise BackupError("child_failed")
    except BaseException:
        _kill_join(process)
        raise
    finally:
        process.stdout.close()
        process.stderr.close()


def _capture(argv, deadline, limit=CHUNK):
    data = bytearray()
    _pump(argv, deadline, data.extend, limit)
    return bytes(data)


def _connection(settings, executable):
    return ["/usr/sbin/runuser", "-u", "postgres", "--",
            str(settings.pg_bin / executable), "--no-password",
            "--host=/var/run/postgresql", "--port=5432",
            "--dbname=" + settings.database]


def _metadata(settings, deadline):
    raw = _capture(_connection(settings, "psql") + [
        "-X", "--tuples-only", "--no-align", "--field-separator=|",
        "--set=ON_ERROR_STOP=1", "--command=SELECT "
        "pg_database_size(current_database()), "
        "current_setting('server_version_num');"], deadline)
    if not re.fullmatch(rb"[0-9]+\|[0-9]+\n?", raw):
        raise BackupError("invalid_metadata")
    size, server = map(int, raw.split(b"|"))
    if size <= 0 or not 170000 <= server < 180000:
        raise BackupError("invalid_metadata")
    versions = {"serverVersionNum": server}
    for executable in ("psql", "pg_dump", "pg_restore"):
        version = _capture([str(settings.pg_bin / executable), "--version"], deadline)
        match = re.fullmatch(
            rb"(?:psql|pg_dump|pg_restore) \(PostgreSQL\) (17(?:\.[0-9]+)*)(?: [^\r\n]*)?\n?",
            version)
        if not match:
            raise BackupError("invalid_client_version")
        versions[executable] = match.group(1).decode("ascii")
    return size, versions


def _exclusive(fd, name):
    result = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
    info = os.fstat(result)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        os.close(result)
        raise BackupError("insecure_file")
    return result


def _write(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise BackupError("write_failed")
        view = view[written:]


def _json(fd, name, value, reserve_bytes=0):
    payload = (json.dumps(value, sort_keys=True) + "\n").encode("utf-8")
    _capacity(fd, reserve_bytes + len(payload))
    output = _exclusive(fd, name)
    try:
        _write(output, payload)
        os.fsync(output)
    finally:
        os.close(output)
    os.fsync(fd)


def _utc():
    return datetime.now(timezone.utc).isoformat()


def check_backup(settings):
    """Read-only, including when some or all output directory components are absent."""
    _validate(settings)
    fd = _directory(settings.directory, False)
    try:
        size, versions = _metadata(settings, time.monotonic() + settings.max_seconds)
        required = settings.reserve_bytes + size + ALLOWANCE
        _capacity(fd, required)
        return {"database": settings.database, "directory": str(settings.directory),
                "sourceEstimatedBytes": size, "requiredBytes": required,
                "availableBytes": _available(fd), "versions": versions,
                "restoreVerified": False}
    finally:
        os.close(fd)


def create_backup(settings):
    """Create one archive; preserve newly owned partials on any failure.

    Publication uses exclusive hard links on the same filesystem, receipt last.
    A crash can leave an orphan archive: only the success JSON marks completion.
    """
    _validate(settings)
    deadline = time.monotonic() + settings.max_seconds
    fd = _directory(settings.directory, False)
    try:
        size, versions = _metadata(settings, deadline)
        _capacity(fd, settings.reserve_bytes + size + ALLOWANCE)
    finally:
        os.close(fd)
    fd = _directory(settings.directory, True)
    archive_fd = None
    partial = None
    started = _utc()
    digest = hashlib.sha256()
    count = 0
    name = "postgres-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(16)
    archive_name = name + ".dump"
    receipt_name = name + ".json"
    result = {"archive": str(settings.directory / archive_name),
              "receipt": str(settings.directory / receipt_name),
              "sha256": None, "bytes": 0, "restoreVerified": False}
    try:
        _lock_directory(fd)
        _capacity(fd, settings.reserve_bytes + size + ALLOWANCE)
        archive_fd = _exclusive(fd, archive_name + ".partial")
        partial = archive_name + ".partial"

        def consume(data):
            nonlocal count
            if time.monotonic() >= deadline:
                raise BackupError("deadline_exceeded")
            _capacity(fd, settings.reserve_bytes + len(data))
            _write(archive_fd, data)
            digest.update(data)
            count += len(data)

        _pump(_connection(settings, "pg_dump") + [
            "--format=custom", "--no-owner", "--no-acl", "--compress=9",
            "--lock-wait-timeout=15s"], deadline, consume, size + ALLOWANCE)
        if count < 5:
            raise BackupError("empty_archive")
        os.fsync(archive_fd)
        os.lseek(archive_fd, 0, os.SEEK_SET)
        if os.read(archive_fd, 5) != b"PGDMP":
            raise BackupError("invalid_archive_signature")
        # /proc path binds verification to the anchored private directory, even
        # if a directory pathname is renamed during the run.
        _pump([str(settings.pg_bin / "pg_restore"), "--list",
               f"/proc/{os.getpid()}/fd/{fd}/{partial}"],
              deadline, lambda data: None, 16 * 1024**2)
        if time.monotonic() >= deadline:
            raise BackupError("deadline_exceeded")
        result.update(sha256=digest.hexdigest(), bytes=count)
        receipt = dict(result, database=settings.database, sourceEstimatedBytes=size,
                       versions=versions, startedAt=started, completedAt=_utc(),
                       archiveListVerified=True, status="complete")
        _json(fd, receipt_name + ".partial", receipt, settings.reserve_bytes)
        os.link(partial, archive_name, src_dir_fd=fd, dst_dir_fd=fd,
                follow_symlinks=False)
        os.fsync(fd)
        os.link(receipt_name + ".partial", receipt_name, src_dir_fd=fd,
                dst_dir_fd=fd, follow_symlinks=False)
        os.fsync(fd)
        # Once the receipt is durable, cleanup failure must not relabel success
        # as failure or remove any published artifact.
        try:
            os.unlink(partial, dir_fd=fd)
            os.unlink(receipt_name + ".partial", dir_fd=fd)
            os.fsync(fd)
        except OSError:
            pass
        return result
    except BaseException as error:
        # _pump has killed and joined its producer before control reaches here.
        reason = (str(error) if isinstance(error, BackupError)
                  and str(error) in FAILURE_CODES else "backup_failed")
        if partial is not None:
            try:
                os.fsync(archive_fd)
                _json(fd, name + ".failure.json", {
                    "status": "failed", "database": settings.database,
                    "partialArchive": str(settings.directory / partial),
                    "bytes": os.fstat(archive_fd).st_size,
                    "restoreVerified": False, "startedAt": started,
                    "failedAt": _utc(), "reason": reason})
            except BaseException:
                pass  # Disk exhaustion may prevent a receipt; never remove data.
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        raise BackupError(reason) from None
    finally:
        if archive_fd is not None:
            os.close(archive_fd)
        os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--run", action="store_true")
    args = parser.parse_args(argv)
    handlers = {}

    def interrupted(signum, frame):
        raise BackupError("interrupted")

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            handlers[signum] = signal.signal(signum, interrupted)
        settings = BackupSettings(database="va_dashboard", directory=DIRECTORY)
        result = check_backup(settings) if args.check else create_backup(settings)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, BackupError) and str(error) in FAILURE_CODES else "backup_failed"
        print(f"PostgreSQL backup refused ({reason}); no restore is verified.", file=sys.stderr)
        return 1
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    sys.exit(main())
