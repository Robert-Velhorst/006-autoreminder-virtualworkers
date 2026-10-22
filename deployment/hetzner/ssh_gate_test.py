import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

spec = importlib.util.spec_from_file_location("va_ssh_gate", Path(__file__).with_name("ssh_gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
IMAGE = "ghcr.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:" + "a" * 64
FIREWALL_CHAIN = ("-N VA_DASHBOARD_PG\n"
                  "-A VA_DASHBOARD_PG -s 172.30.6.2/32 -d 172.30.6.1/32 -i br-va-db -p tcp -m tcp --dport 15433 -j ACCEPT\n"
                  "-A VA_DASHBOARD_PG -j DROP\n")
FIREWALL_INPUT = ("-P INPUT ACCEPT\n"
                  "-A INPUT -d 172.30.6.1/32 -p tcp -m tcp --dport 15433 -j VA_DASHBOARD_PG\n")


class CommandTests(unittest.TestCase):
    def test_install_home_rejects_startup_files_and_untrusted_ownership(self):
        def home(info=None, children=()):
            info = info or SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
            return SimpleNamespace(lstat=lambda: info, parents=(), iterdir=lambda: iter(children))
        gate.check_install_home(home(), existing=True)
        for name in [".bashrc", ".profile", ".ssh", ".ssh/rc", "anything"]:
            with self.subTest(name=name), self.assertRaises(gate.Refused):
                gate.check_install_home(home(children=[name]), existing=True)
        for mode, uid in [(stat.S_IFDIR | 0o777, 0), (stat.S_IFDIR | 0o755, 123), (stat.S_IFLNK | 0o755, 0)]:
            with self.subTest(mode=mode, uid=uid), self.assertRaises(gate.Refused):
                gate.check_install_home(home(SimpleNamespace(st_uid=uid, st_mode=mode)), existing=True)
        missing = SimpleNamespace(lstat=lambda: (_ for _ in ()).throw(FileNotFoundError()))
        gate.check_install_home(missing)
        with self.assertRaises(gate.Refused):
            gate.check_install_home(missing, existing=True)

    def test_installer_rejects_reused_shell_and_checks_home_before_changes(self):
        installer = Path(__file__).with_name("install-ssh-gate.sh").read_text()
        self.assertIn('cut -d: -f7)" == /bin/sh', installer)
        self.assertIn("module['check_install_home']", installer)
        self.assertLess(installer.index("module['check_install_home']"), installer.index("useradd --system"))
        self.assertLess(installer.index("module['check_install_home']"), installer.index("install -d -o root"))
        self.assertIn('--no-create-home', installer)

    def test_exact_commands(self):
        self.assertEqual(gate.parse_command("va-dashboard-stage-compose"), ("stage", None))
        self.assertEqual(gate.parse_command("va-dashboard-status"), ("status", None))
        self.assertEqual(gate.parse_command("va-dashboard-deploy " + IMAGE), ("deploy", IMAGE))

    def test_other_commands_and_injection_are_refused(self):
        for command in ["", "bash", "sh -c id", "scp -t /opt/va-dashboard", "internal-sftp",
                        "va-dashboard-status\n", " va-dashboard-status", "va-dashboard-status;id",
                        "va-dashboard-deploy " + IMAGE + ";id", "va-dashboard-deploy " + IMAGE + " extra",
                        "va-dashboard-deploy " + IMAGE.replace("a" * 64, "A" * 64),
                        "va-dashboard-deploy " + IMAGE.replace("006-autoreminder-virtualworkers", "other"),
                        "va-dashboard-deploy ghcr.io/robert-velhorst/006-autoreminder-virtualworkers:latest"]:
            with self.subTest(command=command), self.assertRaises(gate.Refused):
                gate.parse_command(command)

    def test_upload_bound(self):
        self.assertEqual(gate.bounded_input(io.BytesIO(b"x" * gate.LIMIT)), b"x" * gate.LIMIT)
        for data in [b"", b"x" * (gate.LIMIT + 1)]:
            with self.assertRaises(gate.Refused):
                gate.bounded_input(io.BytesIO(data))

    def test_metadata_rejects_links_wrong_owner_and_permissions(self):
        safe = dict(st_mode=stat.S_IFREG | 0o600, st_uid=12, st_nlink=1)
        gate.check_regular(SimpleNamespace(**safe), 12, True)
        for changed in [dict(st_uid=13), dict(st_nlink=2), dict(st_mode=stat.S_IFLNK | 0o600),
                        dict(st_mode=stat.S_IFIFO | 0o600), dict(st_mode=stat.S_IFREG | 0o640)]:
            with self.subTest(changed=changed), self.assertRaises(gate.Refused):
                gate.check_regular(SimpleNamespace(**{**safe, **changed}), 12, True)

    def test_deploy_uses_only_fixed_sudo_helper_with_clean_environment(self):
        with patch.object(gate, "pwd", SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=123))), \
                patch.object(gate.os, "geteuid", return_value=123, create=True), \
                patch.object(gate.subprocess, "call", return_value=0) as call:
            self.assertEqual(gate.gate_command("va-dashboard-deploy " + IMAGE, io.BytesIO(b"ignored")), 0)
            self.assertEqual(call.call_args.args[0], ["/usr/bin/sudo", "-n", "--", str(gate.HELPER), "deploy", IMAGE])
            self.assertEqual(call.call_args.kwargs["stdin"], gate.subprocess.DEVNULL)
            self.assertEqual(call.call_args.kwargs["env"], gate.ENV)
            self.assertNotIn("shell", call.call_args.kwargs)

    def test_wrong_gate_user_is_refused(self):
        with patch.object(gate, "pwd", SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=123))), \
                patch.object(gate.os, "geteuid", return_value=0, create=True), \
                patch.object(gate.subprocess, "call") as call, self.assertRaises(gate.Refused):
            gate.gate_command("va-dashboard-status", io.BytesIO())
        call.assert_not_called()

    def test_root_helper_rejects_arbitrary_arguments_before_reading_files(self):
        with patch.object(gate, "trusted_assets") as read:
            for arguments in [[], ["bash"], ["status", "extra"], ["deploy", IMAGE, "extra"],
                              ["deploy", IMAGE + "\n"], ["deploy", ":latest"]]:
                with self.subTest(arguments=arguments), self.assertRaises(gate.Refused):
                    gate.root_command(arguments)
            read.assert_not_called()

    def test_root_helper_requires_root(self):
        with patch.object(gate.os, "geteuid", return_value=123, create=True), self.assertRaises(gate.Refused):
            gate.root_command(["status"])

    def test_installed_manifest_pins_all_four_exact_assets(self):
        files = {name: name.encode() for name in ["ssh_gate.py", "root-helper", "deploy.sh", "docker-compose.yml"]}
        manifest = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
        def read(_fd, name, _owner, **_kwargs):
            return json.dumps(manifest).encode() if name == "installed-sha256.json" else files[name]
        with patch.object(gate, "checked_directory", return_value=44), patch.object(gate.os, "close"), \
                patch.object(gate, "read_at", side_effect=read):
            self.assertEqual(gate.trusted_assets(), files)
            for name in list(files):
                original = files[name]
                files[name] = b"changed source"
                with self.subTest(name=name), self.assertRaises(gate.Refused):
                    gate.trusted_assets()
                files[name] = original
            for invalid in [{**manifest, "generalserver.compose.yml": "a" * 64},
                            {name: value for name, value in manifest.items() if name != "docker-compose.yml"}]:
                with patch.object(gate, "read_at", return_value=json.dumps(invalid).encode()), \
                        self.assertRaises(gate.Refused):
                    gate.trusted_assets()

    def test_status_reports_no_application_or_public_acceptance_and_never_runs_docker(self):
        output = io.StringIO()
        with patch.object(gate.os, "geteuid", return_value=0, create=True), \
                patch.object(gate, "trusted_assets", return_value={"docker-compose.yml": b"canonical"}), \
                patch.object(gate, "checked_directory", return_value=44), patch.object(gate.os, "close"), \
                patch.object(gate, "env_ready", return_value=False), patch.object(gate.subprocess, "Popen") as run, \
                contextlib.redirect_stdout(output):
            gate.root_command(["status"])
        status = json.loads(output.getvalue())
        self.assertEqual(status["gate"], "ready")
        self.assertFalse(status["runtime_env_ready"])
        self.assertEqual(status["application"], "not_checked")
        self.assertEqual(status["public_dns_tls"], "not_checked")
        run.assert_not_called()

    def test_frozen_candidate_must_match_before_copy_or_execution(self):
        target = b"# va-deployment-target: generalserver\nservices: {}\n"
        for candidate, canonical, accepted, blocked in [
                (b"canonical", b"canonical", True, False),
                (b"privileged: true", b"canonical", False, False),
                (target, target, True, False), (target, target, False, True)]:
            with self.subTest(accepted=accepted), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(gate.os, "geteuid", return_value=0, create=True))
                stack.enter_context(patch.object(gate, "trusted_assets", return_value={"docker-compose.yml": canonical}))
                preflight = stack.enter_context(patch.object(gate, "generalserver_preflight",
                    side_effect=gate.Refused("not ready") if blocked else None))
                stack.enter_context(patch.object(gate, "checked_directory", return_value=44))
                stack.enter_context(patch.object(gate, "env_ready", return_value=True))
                stack.enter_context(patch.object(gate.os, "open", return_value=55))
                stack.enter_context(patch.object(gate.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True))
                stack.enter_context(patch.object(gate.os, "close"))
                stack.enter_context(patch.object(gate, "check_regular"))
                stack.enter_context(patch.object(gate.os, "fstat", return_value=object()))
                stack.enter_context(patch.dict(sys.modules, {"fcntl": SimpleNamespace(flock=lambda *_: None, LOCK_EX=2, LOCK_NB=4)}))
                stack.enter_context(patch.object(gate, "pwd", SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=123))))
                stack.enter_context(patch.object(gate, "read_at", return_value=candidate))
                copy = stack.enter_context(patch.object(gate, "atomic_write"))
                run = stack.enter_context(patch.object(gate, "run_installed_deploy"))
                if accepted:
                    gate.root_command(["deploy", IMAGE])
                    copy.assert_called_once_with(44, ".docker-compose.yml.candidate", candidate, 0)
                    run.assert_called_once_with(IMAGE)
                else:
                    with self.assertRaises(gate.Refused):
                        gate.root_command(["deploy", IMAGE])
                    copy.assert_not_called()
                    run.assert_not_called()
                self.assertEqual(preflight.call_count, int(candidate == target))

    def test_only_installed_script_executes_without_stdin_or_ssh_environment(self):
        with patch.object(gate.subprocess, "Popen") as popen, contextlib.redirect_stdout(io.StringIO()):
            popen.return_value.wait.return_value = 0
            gate.run_installed_deploy(IMAGE)
        self.assertEqual(popen.call_args.args[0], ["/bin/bash", str(gate.INSTALL / "deploy.sh")])
        self.assertEqual(popen.call_args.kwargs["env"], {**gate.ENV, "APP_DIR": str(gate.APP),
            "APP_IMAGE": IMAGE, "COMPOSE_CANDIDATE": str(gate.APP / ".docker-compose.yml.candidate")})
        self.assertEqual(popen.call_args.kwargs["stdin"], gate.subprocess.DEVNULL)

    def test_workflow_and_actual_ci_are_wired_without_uploading_shell(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/deploy-hetzner.yml").read_text()
        self.assertIn("va-dashboard-stage-compose < deployment/hetzner/generalserver.compose.yml", workflow)
        self.assertIn("ref: ${{ needs.validate-production-gate.outputs.release_commit }}", workflow)
        self.assertNotIn("ref: ${{ needs.validate-production-gate.outputs.release_tag }}", workflow)
        self.assertIn('"va-dashboard-deploy ${APP_IMAGE}" < /dev/null', workflow)
        self.assertNotIn("scp ", workflow)
        self.assertNotIn("bash -s", workflow)
        self.assertNotIn("< deployment/hetzner/deploy.sh", workflow)
        self.assertIn("StrictHostKeyChecking=yes", workflow)
        self.assertIn("gh attestation verify", workflow)
        self.assertIn("python3 -B -I deployment/hetzner/ssh_gate_test.py", (root / ".github/workflows/ci.yml").read_text())


class GeneralServerTests(unittest.TestCase):
    def setUp(self):
        firewall = patch.object(gate, "firewall_output", side_effect=lambda chain:
                                FIREWALL_INPUT if chain == "INPUT" else FIREWALL_CHAIN)
        firewall.start()
        self.addCleanup(firewall.stop)

    def test_target_compose_and_templates_keep_the_private_boundary(self):
        source = Path(__file__).with_name("generalserver.compose.yml").read_bytes()
        self.assertTrue(source.startswith(b"# va-deployment-target: generalserver\n"))
        for expected in [b"ipv4_address: 172.30.6.2", b"127.0.0.1:3025:3000",
                         b"noodzakelijkonline-01:172.30.6.1", b"DATABASE_POOL_MAX: ${DATABASE_POOL_MAX:-2}",
                         b"external: true", b"name: va_dashboard_private", b"replicas: 1",
                         b"source: /etc/ssl/certs/ssl-cert-snakeoil.pem", b"read_only: true",
                         b"create_host_path: false", b"target: /run/va-postgres-root.crt"]:
            self.assertIn(expected, source)
        for forbidden in [b"docker.sock", b"network_mode:", b"host-gateway", b"sslkey", b"build:", b"DATABASE_URL:"]:
            self.assertNotIn(forbidden, source)
        root = Path(__file__).parent
        for file in [root / "generalserver.compose.yml", root / "ssh_gate.py", root / "install-ssh-gate.sh",
                     *sorted((root / "systemd").iterdir())]:
            self.assertNotIn(b"\r", file.read_bytes(), str(file))
        pg_socket = (root / "systemd/va-dashboard-pg.socket").read_text()
        self.assertIn("BindToDevice=br-va-db", pg_socket)
        self.assertIn("DefaultDependencies=no", pg_socket)
        pg_service = (root / "systemd/va-dashboard-pg.service").read_text()
        self.assertIn("--connections-max=4 127.0.0.1:5432", pg_service)
        self.assertNotIn("PrivateNetwork=yes", pg_service)
        firewall = (root / "systemd/va-dashboard-pg-firewall.service").read_text()
        self.assertIn("-i br-va-db -s 172.30.6.2/32 -d 172.30.6.1/32", firewall)
        self.assertIn("-A VA_DASHBOARD_PG -j DROP", firewall)
        self.assertNotIn(" -F", firewall)
        http = (root / "systemd/va-dashboard-http.socket").read_text()
        self.assertIn("/var/lib/docker/volumes/sharet_caddy-data/_data/va-dashboard-http.sock", http)
        self.assertIn("SocketMode=0600", http)

    def network(self):
        return {"Name": "va_dashboard_private", "Driver": "bridge", "Scope": "local",
                "Internal": False, "EnableIPv6": False,
                "Labels": {"io.va-dashboard.owner": "va-dashboard"},
                "Options": {"com.docker.network.bridge.name": "br-va-db"},
                "IPAM": {"Config": [{"Subnet": "172.30.6.0/29", "Gateway": "172.30.6.1"}]},
                "Containers": {}}

    def output(self, network, labels=None, socket=None):
        def call(arguments):
            if arguments[1:3] == ["network", "inspect"]:
                return json.dumps([network])
            if arguments[1] == "inspect":
                return json.dumps(labels or {"com.docker.compose.project": "va-dashboard",
                                             "com.docker.compose.service": "app"})
            if arguments[1] == "show":
                return socket or "ActiveState=active\nListen=172.30.6.1:15433 (Stream)\nBindToDevice=br-va-db\n"
            return ""
        return call

    def test_empty_or_existing_va_only_network_passes_read_only_preflight(self):
        for members in [{}, {"a" * 64: {"IPv4Address": "172.30.6.2/29"}}]:
            network = self.network()
            network["Containers"] = members
            with patch.object(gate, "preflight_output", side_effect=self.output(network)) as read:
                gate.generalserver_preflight()
                for call in read.call_args_list:
                    args = call.args[0]
                    self.assertNotIn(".env", str(args))
                    self.assertNotIn("start", args)
                    self.assertNotIn("-A", args)
                    self.assertNotIn("-I", args)
                    self.assertNotIn("up", args)

    def test_wrong_network_identity_address_or_members_fail(self):
        changes = [{"Name": "other"}, {"Driver": "host"}, {"Scope": "swarm"},
                   {"Internal": True}, {"EnableIPv6": True}, {"Labels": {}}, {"Options": {}},
                   {"IPAM": {"Config": [{"Subnet": "172.17.0.0/16", "Gateway": "172.17.0.1"}]}},
                   {"Containers": {"a" * 64: {"IPv4Address": "172.30.6.3/29"}}},
                   {"Containers": {"bad-id": {"IPv4Address": "172.30.6.2/29"}}},
                   {"Containers": {"a" * 64: {}, "b" * 64: {}}}]
        for changed in changes:
            with self.subTest(changed=changed), patch.object(gate, "preflight_output",
                    side_effect=self.output({**self.network(), **changed})), self.assertRaises(gate.Refused):
                gate.generalserver_preflight()

    def test_another_app_cannot_occupy_static_ip(self):
        network = self.network()
        network["Containers"] = {"a" * 64: {"IPv4Address": "172.30.6.2/29"}}
        with patch.object(gate, "preflight_output", side_effect=self.output(network,
                labels={"com.docker.compose.project": "other", "com.docker.compose.service": "app"})), \
                self.assertRaises(gate.Refused):
            gate.generalserver_preflight()

    def test_inactive_wrong_bind_or_wrong_port_socket_fails(self):
        for socket in ["ActiveState=inactive\n", "ActiveState=active\nListen=0.0.0.0:15433 (Stream)\nBindToDevice=br-va-db\n",
                       "ActiveState=active\nListen=172.30.6.1:15433 (Stream)\nBindToDevice=docker0\n"]:
            with patch.object(gate, "preflight_output", side_effect=self.output(self.network(), socket=socket)), \
                    self.assertRaises(gate.Refused):
                gate.generalserver_preflight()

    def test_missing_commands_units_or_firewall_rules_fail_without_output_leak(self):
        for failure in [OSError("sensitive diagnostic"), gate.subprocess.CalledProcessError(1, "inspect"),
                        gate.subprocess.TimeoutExpired("inspect", 10)]:
            with patch.object(gate.subprocess, "Popen", side_effect=failure), self.assertRaises(gate.Refused) as caught:
                gate.preflight_output(["/usr/bin/docker", "network", "inspect", "va_dashboard_private"])
            self.assertNotIn("sensitive", str(caught.exception))
        output = self.output(self.network())
        for fail_command in ["is-active"]:
            def fail(arguments):
                if fail_command in arguments:
                    raise gate.Refused("unavailable")
                return output(arguments)
            with patch.object(gate, "preflight_output", side_effect=fail), self.assertRaises(gate.Refused):
                gate.generalserver_preflight()
        with patch.object(gate, "preflight_output", side_effect=output), \
                patch.object(gate, "firewall_output", side_effect=gate.Refused("unavailable")), \
                self.assertRaises(gate.Refused):
            gate.generalserver_preflight()

    def test_installer_has_only_two_fixed_choices_and_retains_canonical_name(self):
        installer = Path(__file__).with_name("install-ssh-gate.sh").read_text()
        self.assertIn('"$#" != 2', installer)
        self.assertIn('default) canonical_compose="$root/docker-compose.yml"', installer)
        self.assertIn('generalserver) canonical_compose="$source_dir/generalserver.compose.yml"', installer)
        self.assertIn("Unknown deployment target; no installation performed", installer)
        self.assertLess(installer.index('case "$2"'), installer.index('public_key='))
        self.assertIn('"$source_dir/deploy.sh" "$canonical_compose"', installer)
        self.assertIn('install -o root -g root -m 0600 "$canonical_compose" "$installed/docker-compose.yml"', installer)
        self.assertIn("('ssh_gate.py', 'root-helper', 'deploy.sh', 'docker-compose.yml')", installer)

    def test_actual_installer_target_case_rejects_paths_and_shell_text(self):
        bash = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
                if os.name == "nt" else shutil.which("bash"))
        if not bash or not Path(bash).is_file():
            self.skipTest("Bash is not installed")
        installer = Path(__file__).with_name("install-ssh-gate.sh").read_text()
        start = installer.index('case "$2" in')
        selection = installer[start:installer.index("esac", start) + 4]
        script = 'root=/reviewed; source_dir=/reviewed/deployment/hetzner\n' + selection + '\nprintf "%s\\n" "$canonical_compose"'
        for target, expected in [("default", "/reviewed/docker-compose.yml"),
                                 ("generalserver", "/reviewed/deployment/hetzner/generalserver.compose.yml"),
                                 ("../generalserver", None), ("/tmp/compose.yml", None),
                                 ("generalserver;id", None), ("$(id)", None), ("", None)]:
            with self.subTest(target=target):
                result = gate.subprocess.run([bash, "--noprofile", "--norc", "-c", script, "test", "public.pub", target],
                                             stdin=gate.subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0 if expected else 2, result.stderr)
                self.assertEqual(result.stdout.strip(), expected or "")


class FirewallTests(unittest.TestCase):
    def check(self, chain=FIREWALL_CHAIN, input_rules=FIREWALL_INPUT):
        with patch.object(gate, "firewall_output", side_effect=lambda name:
                          input_rules if name == "INPUT" else chain):
            gate.firewall_preflight()

    def test_exact_canonical_rules_pass_and_later_unrelated_input_rules_are_preserved(self):
        self.check()
        self.check(input_rules=FIREWALL_INPUT + '-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT\n')

    def test_extra_accept_duplicate_rules_and_reordered_chain_are_refused(self):
        lines = FIREWALL_CHAIN.splitlines(keepends=True)
        for changed in [FIREWALL_CHAIN + "-A VA_DASHBOARD_PG -j ACCEPT\n",
                        lines[0] + "-A VA_DASHBOARD_PG -j ACCEPT\n" + ''.join(lines[1:]),
                        lines[0] + lines[1] + lines[1] + lines[2],
                        FIREWALL_CHAIN + lines[2],
                        lines[0] + lines[2] + lines[1],
                        FIREWALL_CHAIN.replace('172.30.6.2/32', '172.30.6.0/29'),
                        FIREWALL_CHAIN.replace('br-va-db', 'docker0'),
                        FIREWALL_CHAIN.replace('-j DROP', '-j RETURN'),
                        FIREWALL_CHAIN.replace('-i br-va-db ', '')]:
            with self.subTest(changed=changed), self.assertRaises(gate.Refused):
                self.check(chain=changed)

    def test_input_bypass_before_hook_missing_or_duplicate_hook_are_refused(self):
        policy, hook = FIREWALL_INPUT.splitlines(keepends=True)
        for changed in [policy + '-A INPUT -j ACCEPT\n' + hook,
                        policy + '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n' + hook,
                        policy, hook, FIREWALL_INPUT + hook,
                        FIREWALL_INPUT + '-A INPUT -j VA_DASHBOARD_PG\n',
                        FIREWALL_INPUT.replace('--dport 15433', '--dport 5432'),
                        FIREWALL_INPUT.replace('-P INPUT ACCEPT', '-P INPUT DROP')]:
            with self.subTest(changed=changed), self.assertRaises(gate.Refused):
                self.check(input_rules=changed)

    def test_malformed_non_ascii_control_and_oversized_output_are_refused(self):
        for output in ['', '\n', FIREWALL_CHAIN + '\n', FIREWALL_CHAIN + '# comment\n',
                       FIREWALL_CHAIN + '"unterminated\n', FIREWALL_CHAIN + '\x00',
                       FIREWALL_CHAIN + '\r', FIREWALL_CHAIN + '\u00e9',
                       'x' * (gate.FIREWALL_OUTPUT_LIMIT + 1)]:
            with self.subTest(output=output[:40]), self.assertRaises(gate.Refused):
                self.check(chain=output)

    def runner(self, chunks, ready=True, status=0, running=False):
        process = SimpleNamespace(stdout=SimpleNamespace(fileno=lambda: 11, close=Mock()),
                                  wait=Mock(return_value=status), poll=Mock(return_value=None if running else status),
                                  kill=Mock())
        selector = MagicMock()
        selector.__enter__.return_value = selector
        selector.select.return_value = [(object(), 1)] if ready else []
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        popen = stack.enter_context(patch.object(gate.subprocess, 'Popen', return_value=process))
        stack.enter_context(patch.object(gate.selectors, 'DefaultSelector', return_value=selector))
        read = stack.enter_context(patch.object(gate.os, 'read', side_effect=chunks))
        return process, popen, read

    def test_firewall_reader_uses_only_fixed_read_command_and_discards_stderr(self):
        process, popen, read = self.runner([FIREWALL_CHAIN.encode('ascii'), b''])
        self.assertEqual(gate.firewall_output('VA_DASHBOARD_PG'), FIREWALL_CHAIN)
        self.assertEqual(popen.call_args.args[0], ['/usr/sbin/iptables', '-w', '5', '-S', 'VA_DASHBOARD_PG'])
        self.assertEqual(popen.call_args.kwargs['stderr'], gate.subprocess.DEVNULL)
        self.assertEqual(popen.call_args.kwargs['env'], gate.ENV)
        self.assertEqual(popen.call_args.kwargs['stdin'], gate.subprocess.DEVNULL)
        process.stdout.close.assert_called_once()
        with self.assertRaises(gate.Refused):
            gate.firewall_output('INPUT;id')
        self.assertEqual(popen.call_count, 1)

    def test_metadata_reader_preserves_arguments_and_discards_stderr(self):
        arguments = ['/usr/bin/docker', 'network', 'inspect', 'va_dashboard_private']
        process, popen, _ = self.runner([b'{"Name":"va_dashboard_private"}', b''])
        self.assertEqual(gate.preflight_output(arguments), '{"Name":"va_dashboard_private"}')
        self.assertEqual(popen.call_args.args[0], arguments)
        self.assertEqual(popen.call_args.kwargs, dict(env=gate.ENV,
            stdin=gate.subprocess.DEVNULL, stdout=gate.subprocess.PIPE,
            stderr=gate.subprocess.DEVNULL, close_fds=True))
        process.stdout.close.assert_called_once()
        process.kill.assert_not_called()

    def test_metadata_reader_accepts_empty_success_and_split_utf8(self):
        for chunks, expected in [([b''], ''), ([b'\xc3', b'\xa9', b''], '\u00e9')]:
            with self.subTest(chunks=chunks):
                self.runner(chunks)
                self.assertEqual(gate.preflight_output(['/usr/bin/systemctl', 'is-active', '--quiet',
                    'va-dashboard-pg-firewall.service']), expected)

    def test_metadata_reader_enforces_byte_limit_before_decoding(self):
        self.runner([b'x' * 4096] * 16 + [b''])
        self.assertEqual(len(gate.preflight_output(['/usr/bin/docker'])), gate.PREFLIGHT_OUTPUT_LIMIT)
        process, _, read = self.runner([b'x' * 4096] * 16 + [b'x'], running=True)
        with self.assertRaises(gate.Refused):
            gate.preflight_output(['/usr/bin/docker'])
        self.assertEqual(read.call_args.args[1], 1)
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)
        process.stdout.close.assert_called_once()

    def test_metadata_timeout_nonzero_exit_and_invalid_utf8_fail_closed(self):
        for settings in [dict(chunks=[], ready=False, running=True),
                         dict(chunks=[b''], status=1), dict(chunks=[b'\xff', b''])]:
            with self.subTest(settings=settings):
                process, _, _ = self.runner(**settings)
                with self.assertRaises(gate.Refused) as caught:
                    gate.preflight_output(['/usr/bin/docker'])
                self.assertNotIn('sensitive', str(caught.exception))
                if settings.get('running'):
                    process.kill.assert_called_once()
                process.stdout.close.assert_called_once()

    def test_metadata_deadline_is_shared_by_reads_and_process_wait(self):
        process, _, read = self.runner([b'{}', b''])
        with patch.object(gate.time, 'monotonic', side_effect=[100, 101, 104, 108]):
            self.assertEqual(gate.preflight_output(['/usr/bin/docker']), '{}')
        process.wait.assert_called_once_with(timeout=2)
        self.assertEqual(read.call_count, 2)
        process, _, read = self.runner([b'{}'], running=True)
        with patch.object(gate.time, 'monotonic', side_effect=[100, 101, 111]), \
                self.assertRaises(gate.Refused):
            gate.preflight_output(['/usr/bin/docker'])
        self.assertEqual(read.call_count, 1)
        process.kill.assert_called_once()

    def test_metadata_read_wait_kill_and_close_failures_are_sanitized(self):
        for operation in ['read', 'wait', 'kill', 'close']:
            with self.subTest(operation=operation):
                process, _, read = self.runner([b''], running=True)
                failure = OSError('sensitive metadata diagnostic')
                if operation == 'read':
                    read.side_effect = failure
                elif operation == 'wait':
                    process.wait.side_effect = gate.subprocess.TimeoutExpired('sensitive command', 2)
                elif operation == 'kill':
                    read.side_effect = failure
                    process.kill.side_effect = failure
                else:
                    process.stdout.close.side_effect = failure
                with self.assertRaises(gate.Refused) as caught:
                    gate.preflight_output(['/usr/bin/docker'])
                self.assertNotIn('sensitive', str(caught.exception))
                process.stdout.close.assert_called_once()

    def test_reader_accepts_limit_but_kills_on_overflow(self):
        self.runner([b'x' * 4096] * 16 + [b''])
        self.assertEqual(len(gate.firewall_output('INPUT')), gate.FIREWALL_OUTPUT_LIMIT)
        process, _, read = self.runner([b'x' * 4096] * 16 + [b'x'], running=True)
        with self.assertRaises(gate.Refused):
            gate.firewall_output('INPUT')
        self.assertEqual(read.call_args.args[1], 1)
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()

    def test_reader_timeout_nonzero_exit_and_non_ascii_are_refused(self):
        for settings in [dict(chunks=[], ready=False, running=True),
                         dict(chunks=[b''], status=1), dict(chunks=[b'\xff', b''])]:
            with self.subTest(settings=settings):
                process, _, _ = self.runner(**settings)
                with self.assertRaises(gate.Refused):
                    gate.firewall_output('INPUT')
                process.stdout.close.assert_called_once()

    def test_reader_command_read_wait_and_cleanup_failures_are_sanitized(self):
        with patch.object(gate.subprocess, 'Popen', side_effect=OSError('sensitive diagnostic')), \
                self.assertRaises(gate.Refused) as caught:
            gate.firewall_output('INPUT')
        self.assertNotIn('sensitive', str(caught.exception))
        process, _, read = self.runner([], running=True)
        read.side_effect = OSError('sensitive read diagnostic')
        with self.assertRaises(gate.Refused) as caught:
            gate.firewall_output('INPUT')
        self.assertNotIn('sensitive', str(caught.exception))
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()
        process, _, _ = self.runner([b''], running=True)
        process.wait.side_effect = gate.subprocess.TimeoutExpired('sensitive command', 2)
        with self.assertRaises(gate.Refused) as caught:
            gate.firewall_output('INPUT')
        self.assertNotIn('sensitive', str(caught.exception))
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()


@unittest.skipUnless(os.name == "posix", "Linux filesystem security checks run in CI, not Windows")
class FilesystemTests(unittest.TestCase):
    def test_atomic_stage_mode_and_old_content_preserved_on_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            with patch.object(gate, "checked_directory", return_value=fd), contextlib.redirect_stdout(io.StringIO()):
                gate.stage(io.BytesIO(b"canonical"), os.getuid())
            file = Path(directory) / gate.STAGED_NAME
            self.assertEqual(file.read_bytes(), b"canonical")
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            with self.assertRaises(gate.Refused):
                gate.stage(io.BytesIO(b"x" * (gate.LIMIT + 1)), os.getuid())
            self.assertEqual(file.read_bytes(), b"canonical")
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), [gate.STAGED_NAME])

    def test_linked_candidate_never_read_or_overwritten(self):
        for kind in ["symbolic", "hard"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "target"
                target.write_bytes(b"retained")
                target.chmod(0o600)
                candidate = Path(directory) / gate.STAGED_NAME
                if kind == "symbolic":
                    candidate.symlink_to(target)
                else:
                    os.link(target, candidate)
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises((gate.Refused, OSError)):
                        gate.read_at(fd, gate.STAGED_NAME, os.getuid(), private=True)
                    with self.assertRaises(gate.Refused):
                        gate.atomic_write(fd, gate.STAGED_NAME, b"changed", os.getuid())
                    self.assertEqual(target.read_bytes(), b"retained")
                finally:
                    os.close(fd)

    def test_fifo_candidate_is_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            os.mkfifo(Path(directory) / gate.STAGED_NAME, 0o600)
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(gate.Refused):
                    gate.read_at(fd, gate.STAGED_NAME, os.getuid(), private=True)
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
