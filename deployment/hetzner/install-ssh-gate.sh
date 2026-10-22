#!/usr/bin/env bash
set -Eeuo pipefail

# Run from an independently reviewed checkout; the only input is a public key file.
if [[ "$EUID" != 0 || "$#" != 1 || ! -f "$1" || -L "$1" ]]; then
  echo 'Usage (root): install-ssh-gate.sh PUBLIC_KEY_FILE' >&2
  exit 2
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$source_dir/../.." && pwd)"
installed=/usr/local/lib/va-dashboard-deploy
account=va-dashboard-deploy
home=/var/empty/va-dashboard-deploy
for command in python3 sudo visudo ssh-keygen sshd install useradd; do
  command -v "$command" >/dev/null || { echo 'Required host administration tool missing' >&2; exit 2; }
done
public_key="$(/usr/bin/python3 -I - "$1" <<'PY'
import pathlib, re, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
if len(data) > 4096 or not re.fullmatch(rb'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [\x20-\x7e]+)?\n?', data):
    raise SystemExit('Expected one Ed25519 PUBLIC key line, without SSH options')
print(data.decode('ascii').rstrip('\n'))
PY
)"
ssh-keygen -l -f "$1" >/dev/null
for file in ssh_gate.py deploy.sh; do
  [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" ]] || exit 2
done
/usr/bin/python3 -I - "$source_dir/ssh_gate.py" "$source_dir/deploy.sh" "$root/docker-compose.yml" <<'PY'
import pathlib, stat, sys
for name in sys.argv[1:]:
    path = pathlib.Path(name)
    for current in (path, *path.parents):
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('Install sources and ancestors must be root-owned and not group/other writable')
    data = path.read_bytes()
    if not data or b'\r' in data:
        raise SystemExit('Deployment sources must be nonempty exact LF files')
PY
existing=false
if id "$account" >/dev/null 2>&1; then
  existing=true
  [[ "$(getent passwd "$account" | cut -d: -f6)" == "$home" ]] || { echo 'Existing account has a different home; inspect manually' >&2; exit 2; }
  [[ "$(getent passwd "$account" | cut -d: -f7)" == /bin/sh ]] || { echo 'Existing account must use exactly /bin/sh; inspect manually' >&2; exit 2; }
  [[ "$(id -Gn "$account")" == "$account" ]] || { echo 'Existing account has unexpected group access; inspect manually' >&2; exit 2; }
fi
/usr/bin/python3 -I - "$source_dir/ssh_gate.py" "$home" "$existing" <<'PY'
import pathlib, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='va_gate_install_validation')
module['check_install_home'](pathlib.Path(sys.argv[2]), existing=sys.argv[3] == 'true')
PY
if [[ "$existing" == false ]]; then
  useradd --system --user-group --no-create-home --home-dir "$home" --shell /bin/sh "$account"
fi
install -d -o root -g root -m 0755 /var/empty "$home" "$installed" /etc/ssh/authorized_keys /etc/ssh/sshd_config.d
install -d -o "$account" -g "$account" -m 0700 /var/lib/va-dashboard-deploy
install -d -o root -g root -m 0700 /opt/va-dashboard
install -o root -g root -m 0755 "$source_dir/ssh_gate.py" "$installed/ssh_gate.py"
install -o root -g root -m 0755 "$source_dir/ssh_gate.py" "$installed/root-helper"
install -o root -g root -m 0700 "$source_dir/deploy.sh" "$installed/deploy.sh"
install -o root -g root -m 0600 "$root/docker-compose.yml" "$installed/docker-compose.yml"
/usr/bin/python3 -I - "$installed" <<'PY'
import hashlib, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in ('ssh_gate.py', 'root-helper', 'deploy.sh', 'docker-compose.yml')}
fd = os.open(root / 'installed-sha256.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write(json.dumps(manifest, sort_keys=True) + '\n')
PY
umask 077
printf 'restrict,command="/usr/bin/python3 -I %s/ssh_gate.py" %s\n' "$installed" "$public_key" > /etc/ssh/authorized_keys/va-dashboard-deploy
chown root:root /etc/ssh/authorized_keys/va-dashboard-deploy
chmod 0644 /etc/ssh/authorized_keys/va-dashboard-deploy
printf '%s\n' 'va-dashboard-deploy ALL=(root) NOPASSWD: /usr/local/lib/va-dashboard-deploy/root-helper *' > /etc/sudoers.d/va-dashboard-deploy
chmod 0440 /etc/sudoers.d/va-dashboard-deploy
visudo -cf /etc/sudoers.d/va-dashboard-deploy >/dev/null
cat > /etc/ssh/sshd_config.d/90-va-dashboard-deploy.conf <<'CONF'
Match User va-dashboard-deploy
    AuthorizedKeysFile /etc/ssh/authorized_keys/va-dashboard-deploy
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/bin/python3 -I /usr/local/lib/va-dashboard-deploy/ssh_gate.py
Match all
CONF
sshd -t
effective="$(sshd -T -C user=va-dashboard-deploy,host=localhost,addr=127.0.0.1)"
grep -Fxq 'authorizedkeysfile /etc/ssh/authorized_keys/va-dashboard-deploy' <<< "$effective"
grep -Fxq 'forcecommand /usr/bin/python3 -I /usr/local/lib/va-dashboard-deploy/ssh_gate.py' <<< "$effective"
grep -Fxq 'disableforwarding yes' <<< "$effective"
grep -Fxq 'permittty no' <<< "$effective"
echo 'VA gate installed and sshd configuration validated. Runtime secrets were not changed.'
echo 'Administrator must reload sshd, retain the current root session, and perform documented positive/negative SSH checks.'
