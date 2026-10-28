#!/usr/bin/python3 -I
"""Prepare an isolated, inactive VA bridge host. Never copy account credentials."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import tarfile
import urllib.request

BASE = Path('/opt/va-dashboard-codex')
WORK = Path('/srv/va-dashboard-bridge')
HOME = Path('/var/lib/va-dashboard-codex')
CONFIG = Path('/etc/va-dashboard-codex')
UNIT = Path('/etc/systemd/system/va-dashboard-codex.service')
ACCOUNT = 'va-dashboard-codex'
IDENTITY = 16006
IMAGE = ('ghcr.io/robert-velhorst/006-autoreminder-virtualworkers@'
         'sha256:30990b106ca3b22ee7c1353fd1c3a826a2804f6fdc064a8fb25614bb108fd7a3')
NODE_URL = 'https://nodejs.org/dist/v26.12.0/node-v26.12.0-linux-x64.tar.xz'
NODE_SHA = 'fd47865ecd6391ebb431fc815e01b9135bf83ded5cf373247e9331e196b7aded'
CODEX_URL = ('https://github.com/openai/codex/releases/download/rust-v0.164.0/'
             'codex-x86_64-unknown-linux-musl.tar.gz')
CODEX_SHA = '90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4'
BUNDLES = ('run-codex-bridge.js', 'run-manager-codex.js', 'run-codex-llm.js',
           'manager-codex-supervisor.js')


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def trusted_parent(path):
    for item in (path.parent, *path.parent.parents):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Installation ancestors must be trusted root directories')


def exclusive(path, data, mode=0o644):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, mode)


def directory(path, mode):
    path.mkdir(mode=mode)
    os.chmod(path, mode)


def download(url, destination, expected):
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(url, timeout=60) as response:
        if not response.url.startswith('https://'):
            raise RuntimeError('Download redirected outside TLS')
        with destination.open('xb') as stream:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 180 * 1024 * 1024:
                    raise RuntimeError('Download exceeded its bound')
                digest.update(chunk)
                stream.write(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError('Official distribution checksum mismatch; nothing executed')


def binary(archive_path, member_name, destination):
    with tarfile.open(archive_path) as archive:
        member = archive.getmember(member_name)
        if not member.isfile() or member.size > 500 * 1024 * 1024:
            raise RuntimeError('Expected a bounded regular executable')
        source = archive.extractfile(member)
        if source is None:
            raise RuntimeError('Executable unavailable')
        with source:
            exclusive(destination, source.read(member.size + 1), 0o755)


def main():
    if os.geteuid() != 0 or run('uname', '-m') != 'x86_64':
        raise RuntimeError('This preparation requires the approved x86_64 root host')
    if os.statvfs('/opt').f_bavail * os.statvfs('/opt').f_frsize < 2 * 1024 ** 3:
        raise RuntimeError('Less than 2 GiB free; preserve existing data and stop')
    for path in (BASE, WORK, HOME, CONFIG, UNIT):
        trusted_parent(path)
        if path.exists() or path.is_symlink():
            raise RuntimeError('Dedicated target already exists; inspect rather than overwrite: ' + str(path))
    for lookup, value in ((pwd.getpwnam, ACCOUNT), (grp.getgrnam, ACCOUNT),
                          (pwd.getpwuid, IDENTITY), (grp.getgrgid, IDENTITY)):
        try:
            lookup(value)
        except KeyError:
            continue
        raise RuntimeError('Dedicated account/name/ID already exists; no reuse permitted')
    current = json.loads(run('docker', 'inspect', 'va-dashboard-app-1'))[0]
    if current['Config']['Image'] != IMAGE:
        raise RuntimeError('Running app does not match the accepted extraction source')
    seal = json.loads(run('docker', 'exec', 'va-dashboard-app-1', 'cat', '/app/dist/aptlss-build.json'))
    directory(BASE, 0o755)
    for name in ('downloads', 'node', 'bin', 'bridge'):
        directory(BASE / name, 0o700 if name == 'downloads' else 0o755)
    download(NODE_URL, BASE / 'downloads/node.tar.xz', NODE_SHA)
    binary(BASE / 'downloads/node.tar.xz', 'node-v26.12.0-linux-x64/bin/node', BASE / 'node/node')
    download(CODEX_URL, BASE / 'downloads/codex.tar.gz', CODEX_SHA)
    binary(BASE / 'downloads/codex.tar.gz', 'codex-x86_64-unknown-linux-musl', BASE / 'bin/codex')
    for name in BUNDLES:
        source = 'dist/bridge/' + name
        data = subprocess.check_output(['docker', 'exec', 'va-dashboard-app-1', 'cat', '/app/' + source])
        if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != seal['toolBundleHashes'][source]:
            raise RuntimeError('Accepted bridge bundle integrity mismatch')
        exclusive(BASE / 'bridge' / name, data)
    if run(str(BASE / 'node/node'), '--version') != 'v26.12.0':
        raise RuntimeError('Unexpected isolated Node version')
    if run(str(BASE / 'bin/codex'), '--version') != 'codex-cli 0.164.0':
        raise RuntimeError('Unexpected isolated Codex version')
    run('groupadd', '--gid', str(IDENTITY), ACCOUNT)
    run('useradd', '--system', '--uid', str(IDENTITY), '--gid', ACCOUNT, '--no-create-home',
        '--home-dir', str(HOME), '--shell', '/usr/sbin/nologin', ACCOUNT)
    for path in (WORK, HOME, HOME / 'auth', WORK / 'queue', WORK / 'manager-private', WORK / 'conversation-private'):
        mode = 0o2770 if path == WORK / 'queue' else 0o700
        directory(path, 0o700)
        os.chown(path, IDENTITY, IDENTITY)
        os.chmod(path, mode)
    for child in ('requests', 'replies', 'llm-v1', 'llm-v1/requests', 'llm-v1/replies', 'llm-v1/dispatch'):
        path = WORK / 'queue' / child
        directory(path, 0o700)
        os.chown(path, IDENTITY, IDENTITY)
        os.chmod(path, 0o2770)
    directory(CONFIG, 0o700)
    exclusive(HOME / 'auth/config.toml', b'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n', 0o600)
    os.chown(HOME / 'auth/config.toml', IDENTITY, IDENTITY)
    environment = ('HOME=' + str(HOME) + '\nCODEX_HOME=' + str(HOME / 'auth') + '\n'
        'PATH=/opt/va-dashboard-codex/node:/usr/bin:/bin\n'
        'APTLSS_CODEX_EXECUTABLE=/opt/va-dashboard-codex/bin/codex\n'
        'APTLSS_CODEX_BRIDGE_ROOT=/srv/va-dashboard-bridge\n'
        'APTLSS_CODEX_QUEUE_DIR=/srv/va-dashboard-bridge/queue\n'
        'APTLSS_CODEX_PRIVATE_DIR=/srv/va-dashboard-bridge/manager-private\n'
        'APTLSS_CODEX_LLM_PRIVATE_DIR=/srv/va-dashboard-bridge/conversation-private\n')
    exclusive(CONFIG / 'bridge.env', environment.encode(), 0o600)
    unit = '''[Unit]
Description=Isolated VA Dashboard Codex subscription bridge
Wants=network-online.target
After=network-online.target
ConditionPathExists=/var/lib/va-dashboard-codex/auth/auth.json

[Service]
Type=simple
User=va-dashboard-codex
Group=va-dashboard-codex
WorkingDirectory=/srv/va-dashboard-bridge
EnvironmentFile=/etc/va-dashboard-codex/bridge.env
ExecStart=/opt/va-dashboard-codex/node/node /opt/va-dashboard-codex/bridge/manager-codex-supervisor.js
UMask=0007
Restart=no
KillMode=control-group
TimeoutStopSec=45
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/srv/va-dashboard-bridge /var/lib/va-dashboard-codex
MemoryHigh=256M
MemoryMax=384M
CPUQuota=50%
TasksMax=96

[Install]
WantedBy=multi-user.target
'''
    exclusive(UNIT, unit.encode())
    run('systemd-analyze', 'verify', str(UNIT))
    run('systemctl', 'daemon-reload')
    print(json.dumps({'prepared': True, 'serviceStarted': False, 'serviceEnabled': False,
        'credentialsCopied': False, 'appChanged': False, 'image': IMAGE,
        'node': '26.12.0', 'codex': '0.164.0', 'accountUid': IDENTITY,
        'next': 'Owner completes dedicated ChatGPT login; app queue wiring remains separate'}))


if __name__ == '__main__':
    main()
