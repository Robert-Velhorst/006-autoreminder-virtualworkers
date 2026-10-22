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
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import time

USER = "va-dashboard-deploy"
INSTALL = Path("/usr/local/lib/va-dashboard-deploy")
HELPER = INSTALL / "root-helper"
STAGING = Path("/var/lib/va-dashboard-deploy")
APP = Path("/opt/va-dashboard")
STAGED_NAME = "compose.candidate"
LIMIT = 64 * 1024
FIREWALL_OUTPUT_LIMIT = 64 * 1024
PREFLIGHT_OUTPUT_LIMIT = 64 * 1024
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


def preflight_output(arguments):
    return bounded_output(arguments, PREFLIGHT_OUTPUT_LIMIT, "utf-8",
                          "GeneralServer private route preflight")


def firewall_output(chain):
    if chain not in {"INPUT", "VA_DASHBOARD_PG"}:
        raise Refused("Unexpected firewall inspection target")
    return bounded_output(["/usr/sbin/iptables", "-w", "5", "-S", chain],
                          FIREWALL_OUTPUT_LIMIT, "ascii", "Firewall inspection")


def bounded_output(arguments, limit, encoding, description):
    process = None
    deadline = time.monotonic() + 10
    try:
        process = subprocess.Popen(
            arguments, env=ENV,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True)
        data = bytearray()
        # Drain only a bounded stdout pipe; never retain or expose diagnostics.
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise Refused(f"{description} timed out")
                chunk = os.read(process.stdout.fileno(), min(4096, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > limit:
                    raise Refused(f"{description} output exceeds its limit")
        if process.wait(timeout=max(0, deadline - time.monotonic())) != 0:
            raise Refused(f"{description} failed")
        return data.decode(encoding)
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        raise Refused(f"{description} failed") from None
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=2)
            except (OSError, subprocess.SubprocessError):
                raise Refused(f"{description} cleanup failed") from None
            finally:
                try:
                    process.stdout.close()
                except OSError:
                    raise Refused(f"{description} cleanup failed") from None


def firewall_rules(output):
    if (not isinstance(output, str) or len(output) > FIREWALL_OUTPUT_LIMIT
            or not output.isascii() or any(ord(c) < 32 and c not in "\n\t" for c in output)):
        raise Refused("Invalid firewall inspection output")
    try:
        rules = [shlex.split(line, comments=False, posix=True) for line in output.splitlines()]
    except ValueError:
        raise Refused("Invalid firewall inspection output") from None
    if not rules or any(not rule for rule in rules):
        raise Refused("Empty firewall inspection output")
    return rules


def firewall_preflight():
    allow = ("-A VA_DASHBOARD_PG -s 172.30.6.2/32 -d 172.30.6.1/32 "
             "-i br-va-db -p tcp -m tcp --dport 15433 -j ACCEPT").split()
    if firewall_rules(firewall_output("VA_DASHBOARD_PG")) != [
            ["-N", "VA_DASHBOARD_PG"], allow, ["-A", "VA_DASHBOARD_PG", "-j", "DROP"]]:
        raise Refused("VA firewall chain differs from its exact reviewed rule order")
    hook = ("-A INPUT -d 172.30.6.1/32 -p tcp -m tcp --dport 15433 "
            "-j VA_DASHBOARD_PG").split()
    rules = firewall_rules(firewall_output("INPUT"))
    if (rules[:2] != [["-P", "INPUT", "ACCEPT"], hook]
            or any(rule[:2] != ["-A", "INPUT"] or "VA_DASHBOARD_PG" in rule for rule in rules[2:])):
        raise Refused("VA firewall hook must be the first and only INPUT reference")


def generalserver_preflight():
    # Inspect only network metadata, unit state and container labels, never env.
    networks = json.loads(preflight_output([
        "/usr/bin/docker", "network", "inspect", "va_dashboard_private"]))
    if not isinstance(networks, list) or len(networks) != 1:
        raise Refused("Expected exactly one VA private network")
    network = networks[0]
    if (network.get("Name") != "va_dashboard_private" or network.get("Driver") != "bridge"
            or network.get("Scope") != "local" or network.get("Internal") is not False
            or network.get("EnableIPv6") is not False
            or network.get("Labels", {}).get("io.va-dashboard.owner") != "va-dashboard"
            or network.get("Options", {}).get("com.docker.network.bridge.name") != "br-va-db"
            or network.get("IPAM", {}).get("Config") != [
                {"Subnet": "172.30.6.0/29", "Gateway": "172.30.6.1"}]):
        raise Refused("VA private network does not match the reviewed target")
    members = network.get("Containers")
    if not isinstance(members, dict) or len(members) > 1:
        raise Refused("VA private network has unexpected members")
    for container, endpoint in members.items():
        if (not re.fullmatch(r"[a-f0-9]{64}", container)
                or endpoint.get("IPv4Address") != "172.30.6.2/29"):
            raise Refused("VA private network address is occupied unexpectedly")
        labels = json.loads(preflight_output([
            "/usr/bin/docker", "inspect", "--format", "{{json .Config.Labels}}", container]))
        if (labels.get("com.docker.compose.project") != "va-dashboard"
                or labels.get("com.docker.compose.service") != "app"):
            raise Refused("VA private network contains another application")
    properties = dict(line.split("=", 1) for line in preflight_output([
        "/usr/bin/systemctl", "show", "va-dashboard-pg.socket",
        "--property=ActiveState,Listen,BindToDevice"]).splitlines() if "=" in line)
    if (properties.get("ActiveState") != "active"
            or properties.get("Listen") != "172.30.6.1:15433 (Stream)"
            or properties.get("BindToDevice") != "br-va-db"):
        raise Refused("VA PostgreSQL proxy socket is not available on its fixed interface")
    preflight_output(["/usr/bin/systemctl", "is-active", "--quiet", "va-dashboard-pg-firewall.service"])
    firewall_preflight()


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
            if candidate.startswith(b"# va-deployment-target: generalserver\n"):
                generalserver_preflight()
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
    except (Refused, OSError, ValueError, KeyError, TypeError, AttributeError):
        # Do not expose paths, provider output, manifests or runtime secrets.
        print("VA deployment request refused or unconfirmed; administrator review required", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
