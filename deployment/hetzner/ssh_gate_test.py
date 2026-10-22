import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("va_ssh_gate", Path(__file__).with_name("ssh_gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
IMAGE = "ghcr.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:" + "a" * 64


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
        for candidate, accepted in [(b"canonical", True), (b"privileged: true", False)]:
            with self.subTest(accepted=accepted), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(gate.os, "geteuid", return_value=0, create=True))
                stack.enter_context(patch.object(gate, "trusted_assets", return_value={"docker-compose.yml": b"canonical"}))
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
                    copy.assert_called_once_with(44, ".docker-compose.yml.candidate", b"canonical", 0)
                    run.assert_called_once_with(IMAGE)
                else:
                    with self.assertRaises(gate.Refused):
                        gate.root_command(["deploy", IMAGE])
                    copy.assert_not_called()
                    run.assert_not_called()

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
        self.assertIn("va-dashboard-stage-compose < docker-compose.yml", workflow)
        self.assertIn('"va-dashboard-deploy ${APP_IMAGE}" < /dev/null', workflow)
        self.assertNotIn("scp ", workflow)
        self.assertNotIn("bash -s", workflow)
        self.assertNotIn("< deployment/hetzner/deploy.sh", workflow)
        self.assertIn("StrictHostKeyChecking=yes", workflow)
        self.assertIn("gh attestation verify", workflow)
        self.assertIn("python3 -B -I deployment/hetzner/ssh_gate_test.py", (root / ".github/workflows/ci.yml").read_text())


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
