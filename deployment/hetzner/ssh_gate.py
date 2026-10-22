#!/usr/bin/python3 -I
"""Installed twice: an unprivileged SSH gate and the sole sudo root helper."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
try:
    import pwd
except ImportError:  # Portable parser tests; the installed gate requires Linux.
    pwd = None
import re
import secrets
import signal
import stat
import subprocess
import sys

USER = "va-dashboard-deploy"
INSTALL = Path("/usr/local/lib/va-dashboard-deploy")
HELPER = INSTALL / "root-helper"
STAGING = Path("/var/lib/va-dashboard-deploy")
APP = Path("/opt/va-dashboard")
STAGED_NAME = "compose.candidate"
LIMIT = 64 * 1024
DIGEST = r"ghcr\.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:[a-f0-9]{64}"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C", "LC_ALL": "C"}


class Refused(Exception):
    pass


def check_install_home(home, existing=False):
    try:
        home.lstat()
    except FileNotFoundError:
        if existing:
            raise Refused("An existing deployment account must have a verified empty home")
        return
    for path in (home, *home.parents):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refused("Deployment home and ancestors must be root-owned, non-writable directories")
    if any(home.iterdir()):
        raise Refused("Deployment home must be empty; startup files require administrator review")


def parse_command(command):
    if command == "va-dashboard-stage-compose":
        return "stage", None
    if command == "va-dashboard-status":
        return "status", None
    match = re.fullmatch(r"va-dashboard-deploy (" + DIGEST + r")", command)
    if match:
        return "deploy", match.group(1)
    raise Refused("Only the three documented VA deployment commands are allowed")


def checked_directory(path, owner):
    """Walk every ancestor without following links, including the final directory."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise Refused("Unsafe deployment directory")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(path.parts[1:]):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            expected = owner if index == len(path.parts) - 2 else 0
            if info.st_uid != expected or info.st_mode & 0o022:
                raise Refused("Deployment directories must have trusted ownership and permissions")
        return fd
    except BaseException:
        os.close(fd)
        raise


def check_regular(info, owner, private=False):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1
            or info.st_mode & (0o077 if private else 0o022)):
        raise Refused("Deployment file ownership, links or permissions are unsafe")


def read_at(directory, name, owner, limit=LIMIT, private=False):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        check_regular(info, owner, private)
        if info.st_size > limit:
            raise Refused("Deployment input exceeds its size limit")
        data = stream.read(limit + 1)
        if not data or len(data) > limit:
            raise Refused("Deployment input is empty or oversized")
        return data


def atomic_write(directory, name, data, owner):
    try:
        check_regular(os.stat(name, dir_fd=directory, follow_symlinks=False), owner, True)
    except FileNotFoundError:
        pass
    temporary = ".upload-" + secrets.token_hex(16)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory)


def bounded_input(stream):
    data = stream.read(LIMIT + 1)
    if not data or len(data) > LIMIT:
        raise Refused("Compose must contain 1 to 65536 bytes")
    return data


def stage(stream, uid):
    data = bounded_input(stream)
    directory = checked_directory(STAGING, uid)
    try:
        atomic_write(directory, STAGED_NAME, data, uid)
    finally:
        os.close(directory)
    print("VA Compose staged; no deployment performed")


def trusted_assets():
    directory = checked_directory(INSTALL, 0)
    try:
        manifest = json.loads(read_at(directory, "installed-sha256.json", 0))
        names = {"ssh_gate.py", "root-helper", "deploy.sh", "docker-compose.yml"}
        if not isinstance(manifest, dict) or set(manifest) != names:
            raise Refused("Installed deployment manifest is invalid")
        assets = {}
        for name in names:
            expected = manifest[name]
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
                raise Refused("Installed deployment manifest is invalid")
            data = read_at(directory, name, 0, limit=128 * 1024)
            if hashlib.sha256(data).hexdigest() != expected:
                raise Refused("Installed deployment source does not match its pinned manifest")
            assets[name] = data
        if len(assets["docker-compose.yml"]) > LIMIT:
            raise Refused("Canonical Compose exceeds the staging limit")
        return assets
    finally:
        os.close(directory)


def env_ready(directory):
    try:
        fd = os.open(".env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return False
    try:
        info = os.fstat(fd)
        check_regular(info, 0, True)
        return info.st_size > 0
    finally:
        os.close(fd)  # Never read or print runtime secrets.


def run_installed_deploy(digest):
    environment = {**ENV, "APP_DIR": str(APP), "APP_IMAGE": digest,
                   "COMPOSE_CANDIDATE": str(APP / ".docker-compose.yml.candidate")}
    process = subprocess.Popen(["/bin/bash", str(INSTALL / "deploy.sh")], cwd=str(APP),
                               env=environment, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True, close_fds=True)
    try:
        code = process.wait(timeout=900)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise Refused("Deployment timed out; outcome unconfirmed, operator review required")
    if code != 0:
        raise Refused("Deployment unsuccessful or unconfirmed; inspect the host as administrator")
    print("VA deployment completed its local health checks; public acceptance is not implied")


def root_command(arguments):
    if arguments == ["status"]:
        action, digest = "status", None
    elif len(arguments) == 2 and arguments[0] == "deploy" and re.fullmatch(DIGEST, arguments[1]):
        action, digest = "deploy", arguments[1]
    else:
        raise Refused("Invalid root-helper command")
    if os.geteuid() != 0:
        raise Refused("The root helper requires its fixed sudo entrypoint")
    assets = trusted_assets()
    app = checked_directory(APP, 0)
    try:
        ready = env_ready(app)
        if action == "status":
            print(json.dumps({"gate": "ready", "runtime_env_ready": ready,
                              "canonical_compose_sha256": hashlib.sha256(assets["docker-compose.yml"]).hexdigest(),
                              "application": "not_checked", "public_dns_tls": "not_checked"}))
            return
        if not ready:
            raise Refused("The root-owned runtime environment is not ready")
        import fcntl
        lock = os.open(".connection.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW,
                       0o600, dir_fd=app)
        try:
            check_regular(os.fstat(lock), 0, True)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            uid = pwd.getpwnam(USER).pw_uid
            directory = checked_directory(STAGING, uid)
            try:
                candidate = read_at(directory, STAGED_NAME, uid, private=True)
            finally:
                os.close(directory)
            if hashlib.sha256(candidate).digest() != hashlib.sha256(assets["docker-compose.yml"]).digest():
                raise Refused("Staged Compose differs from the root-installed canonical release")
            atomic_write(app, ".docker-compose.yml.candidate", candidate, 0)
            run_installed_deploy(digest)
        finally:
            os.close(lock)
    finally:
        os.close(app)


def gate_command(command, stream):
    action, digest = parse_command(command)
    uid = pwd.getpwnam(USER).pw_uid
    if os.geteuid() != uid or uid == 0:
        raise Refused("The SSH gate must run as the dedicated deployment user")
    if action == "stage":
        def upload_timeout(*_):
            raise Refused("Compose upload timed out")
        signal.signal(signal.SIGALRM, upload_timeout)
        signal.alarm(30)
        try:
            stage(stream, uid)
        finally:
            signal.alarm(0)
        return 0
    arguments = [action] + ([digest] if digest else [])
    return subprocess.call(["/usr/bin/sudo", "-n", "--", str(HELPER), *arguments],
                           stdin=subprocess.DEVNULL, env=ENV, cwd="/", close_fds=True)


def main():
    os.umask(0o077)
    try:
        if len(sys.argv) > 1:
            root_command(sys.argv[1:])
            return 0
        return gate_command(os.environ.get("SSH_ORIGINAL_COMMAND", ""), sys.stdin.buffer)
    except (Refused, OSError, ValueError, KeyError, TypeError):
        # Do not expose paths, provider output, manifests or runtime secrets.
        print("VA deployment request refused or unconfirmed; administrator review required", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
