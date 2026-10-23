"""Offline unittest suite. Linux/root tests use only private temporary fixtures."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
from dataclasses import replace
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location(
    "postgres_backup", Path(__file__).with_name("postgres_backup.py"))
backup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backup
spec.loader.exec_module(backup)
LINUX_ROOT = sys.platform == "linux" and os.geteuid() == 0
PAYLOAD = b"PGDMP" + b"synthetic fixture only\x00" * 20
REAL_PUMP = backup._pump


class ContractTests(unittest.TestCase):
    def test_default_settings(self):
        settings = backup.BackupSettings("va_dashboard", backup.DIRECTORY)
        self.assertEqual(settings.reserve_bytes, 3 * 1024**3)
        self.assertEqual(settings.max_seconds, 1800)
        self.assertEqual(settings.pg_bin.as_posix(), "/usr/lib/postgresql/17/bin")

    def test_cli_is_fixed_and_check_is_distinct(self):
        for argument, function in (("--check", "check_backup"), ("--run", "create_backup")):
            with self.subTest(argument=argument), \
                    patch.object(backup, function, return_value={}) as action, \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(backup.main([argument]), 0)
                settings = action.call_args.args[0]
                self.assertEqual(settings.database, "va_dashboard")
                self.assertEqual(settings.directory, backup.DIRECTORY)

    def test_cli_rejects_overrides_and_missing_mode(self):
        for args in ([], ["--run", "--database=other"], ["--run", "--directory=/tmp"],
                     ["--check", "--run"]):
            with self.subTest(args=args), redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit):
                backup.main(args)

    def test_cli_diagnostics_never_include_exception(self):
        with patch.object(backup, "create_backup", side_effect=OSError("PASSWORD secret")), \
                redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(backup.main(["--run"]), 1)
        self.assertNotIn("secret", errors.getvalue())
        self.assertNotIn("PASSWORD", errors.getvalue())

    def test_cli_reports_only_fixed_safe_failure_codes(self):
        for diagnostic, expected in [('insufficient_capacity', 'insufficient_capacity'),
                                     ('PASSWORD secret', 'backup_failed')]:
            with self.subTest(diagnostic=diagnostic), \
                    patch.object(backup, 'check_backup', side_effect=backup.BackupError(diagnostic)), \
                    redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(backup.main(['--check']), 1)
                self.assertIn('(' + expected + ')', errors.getvalue())
                self.assertNotIn('secret', errors.getvalue())

    def test_fixed_metadata_query_and_version_validation(self):
        settings = backup.BackupSettings("fixture", Path("/private"))
        with patch.object(backup, "_capture", side_effect=[
            b"123|170006\n", b"psql (PostgreSQL) 17.6 (Debian)\n",
            b"pg_dump (PostgreSQL) 17.6\n", b"pg_restore (PostgreSQL) 17.6\n"
        ]) as capture:
            size, versions = backup._metadata(settings, 123)
        self.assertEqual(size, 123)
        self.assertEqual(versions["serverVersionNum"], 170006)
        command = capture.call_args_list[0].args[0]
        self.assertIn("--command=SELECT pg_database_size(current_database()), "
                      "current_setting('server_version_num');", command)
        self.assertIn("-X", command)
        self.assertEqual(command[:5], ["/usr/sbin/runuser", "-u", "postgres", "--",
                                      str(settings.pg_bin / "psql")])

    def test_invalid_metadata_and_wrong_versions(self):
        settings = backup.BackupSettings("fixture", Path("/private"))
        for raw in (b"secret", b"1|160000\n", b"0|170000\n", b"1|170000\nextra"):
            with self.subTest(raw=raw), patch.object(backup, "_capture", return_value=raw), \
                    self.assertRaises(backup.BackupError):
                backup._metadata(settings, 123)
        with patch.object(backup, "_capture", side_effect=[b"1|170000\n", b"psql (PostgreSQL) 16.9\n"]), \
                self.assertRaisesRegex(backup.BackupError, "invalid_client_version"):
            backup._metadata(settings, 123)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux signals")
    def test_kill_join_owns_only_child_group(self):
        child = MagicMock(pid=12345)
        with patch.object(backup.os, "killpg", create=True) as kill:
            backup._kill_join(child)
        kill.assert_called_once_with(12345, signal.SIGKILL if hasattr(signal, "SIGKILL") else 9)
        child.wait.assert_called_once_with()

    def test_non_root_or_non_linux_refused(self):
        with patch.object(backup.sys, "platform", "win32"), \
                self.assertRaisesRegex(backup.BackupError, "linux_root_required"):
            backup.create_backup(backup.BackupSettings("fixture", Path("/private")))


@unittest.skipUnless(LINUX_ROOT, "requires local Linux root descriptor semantics")
class FilesystemTests(unittest.TestCase):
    def setUp(self):
        # /tmp itself is intentionally not trusted by production path validation.
        self.temp = tempfile.TemporaryDirectory(prefix="backup-unit-")
        self.root = Path(self.temp.name)
        self.settings = backup.BackupSettings("synthetic_fixture", self.root / "backups", reserve_bytes=4096)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)
        self.real_verify = backup._verify_directory

        def verified(fd, private=False):
            if os.readlink(f"/proc/self/fd/{fd}") == "/tmp" and not private:
                return
            return self.real_verify(fd, private)

        self.stack.enter_context(patch.object(backup, "_verify_directory", side_effect=verified))
        self.stack.enter_context(patch.object(backup, "_metadata", return_value=(1024, {"pg_dump": "17.6"})))
        self.stack.enter_context(patch.object(backup, "_available", return_value=10**12))
        self.pump = self.stack.enter_context(patch.object(backup, "_pump", side_effect=self.produce))

    def produce(self, command, deadline, consume, limit):
        if "--format=custom" in command:
            consume(PAYLOAD)

    def receipts(self):
        return list(self.settings.directory.glob("*.failure.json"))

    def assert_private(self, path):
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        self.assertEqual(path.stat().st_uid, 0)

    def test_check_missing_directory_never_mutates(self):
        target = self.root / "missing" / "backups"
        with patch.object(backup.os, "mkdir", side_effect=AssertionError("mutation")), \
                patch.object(backup, "_exclusive", side_effect=AssertionError("file creation")):
            result = backup.check_backup(replace(self.settings, directory=target))
        self.assertFalse(target.parent.exists())
        self.assertEqual(result["requiredBytes"], 4096 + 1024 + backup.ALLOWANCE)
        self.pump.assert_not_called()

    def test_success_hash_signature_receipt_and_private_publication(self):
        result = backup.create_backup(self.settings)
        self.assertEqual(set(result), {"archive", "receipt", "sha256", "bytes", "restoreVerified"})
        self.assertEqual(result["sha256"], hashlib.sha256(PAYLOAD).hexdigest())
        self.assertEqual(result["bytes"], len(PAYLOAD))
        self.assertIs(result["restoreVerified"], False)
        for key in ("archive", "receipt"):
            self.assertTrue(Path(result[key]).is_absolute())
            self.assert_private(Path(result[key]))
        self.assert_private(self.settings.directory)
        receipt = json.loads(Path(result["receipt"]).read_text())
        self.assertEqual(receipt["sourceEstimatedBytes"], 1024)
        self.assertEqual(receipt["database"], "synthetic_fixture")
        self.assertFalse(receipt["restoreVerified"])
        self.assertTrue(receipt["archiveListVerified"])
        self.assertEqual(Path(result["archive"]).read_bytes(), PAYLOAD)
        self.assertEqual(len(list(self.settings.directory.iterdir())), 2)
        dump_command = self.pump.call_args_list[0].args[0]
        for flag in ("--no-password", "--host=/var/run/postgresql", "--port=5432",
                     "--no-owner", "--no-acl", "--lock-wait-timeout=15s", "--compress=9"):
            self.assertIn(flag, dump_command)
        self.assertIn("--list", self.pump.call_args_list[1].args[0])

    def test_repeated_backups_do_not_prune(self):
        first = backup.create_backup(self.settings)
        second = backup.create_backup(self.settings)
        self.assertNotEqual(first["archive"], second["archive"])
        self.assertEqual(Path(first["archive"]).read_bytes(), PAYLOAD)
        self.assertEqual(len(list(self.settings.directory.iterdir())), 4)

    def test_concurrent_directory_lock_refuses_before_dump(self):
        self.settings.directory.mkdir(mode=0o700)
        fd = backup._directory(self.settings.directory, False)
        try:
            backup._lock_directory(fd)
            with patch.object(backup, "_kill_join") as kill, self.assertRaises(backup.BackupError):
                backup.create_backup(self.settings)
            self.pump.assert_not_called()
            kill.assert_not_called()
            self.assertEqual(list(self.settings.directory.iterdir()), [])
        finally:
            os.close(fd)
        backup.create_backup(self.settings)

    def test_exclusive_file_creation_and_link_targets(self):
        self.settings.directory.mkdir(mode=0o700)
        fd = backup._directory(self.settings.directory, False)
        try:
            file_fd = backup._exclusive(fd, "owned")
            os.close(file_fd)
            for name in ("owned", "symlink"):
                if name == "symlink":
                    (self.settings.directory / name).symlink_to("owned")
                with self.assertRaises(FileExistsError):
                    backup._exclusive(fd, name)
        finally:
            os.close(fd)

    def test_publication_collision_does_not_overwrite(self):
        real_link = os.link

        def collide(source, destination, **kwargs):
            if destination.endswith(".json"):
                (self.settings.directory / destination).write_bytes(b"existing receipt")
            return real_link(source, destination, **kwargs)

        with patch.object(backup.os, "link", side_effect=collide), self.assertRaises(backup.BackupError):
            backup.create_backup(self.settings)
        existing = [p for p in self.settings.directory.glob("*.json") if not p.name.endswith("failure.json")]
        self.assertEqual(len(existing), 1)
        self.assertEqual(existing[0].read_bytes(), b"existing receipt")
        self.assertEqual(len(list(self.settings.directory.glob("*.dump.partial"))), 1)
        self.assertEqual(len(self.receipts()), 1)

    def test_insecure_existing_target_not_chmodded(self):
        self.settings.directory.mkdir(mode=0o755)
        with patch.object(backup.os, "chmod", side_effect=AssertionError("chmod")), \
                self.assertRaises(backup.BackupError):
            backup.create_backup(self.settings)
        self.assertEqual(stat.S_IMODE(self.settings.directory.stat().st_mode), 0o755)

    def test_symlink_target_and_ancestor_rejected(self):
        for target in (self.root / "linked", self.root / "linked" / "child"):
            if not (self.root / "linked").exists():
                (self.root / "linked").symlink_to(self.root, target_is_directory=True)
            with self.subTest(target=target), self.assertRaises(OSError):
                backup.create_backup(replace(self.settings, directory=target))

    def test_writable_and_foreign_owned_ancestors_rejected(self):
        for mode, uid in ((0o777, 0), (0o700, 12345)):
            with self.subTest(mode=mode, uid=uid), \
                    patch.object(backup.os, "fstat", return_value=MagicMock(st_mode=stat.S_IFDIR | mode, st_uid=uid)), \
                    self.assertRaises(backup.BackupError):
                self.real_verify(123)

    def test_preflight_capacity_refuses_before_creation(self):
        with patch.object(backup, "_available", return_value=4096 + 1024 + backup.ALLOWANCE - 1), \
                self.assertRaises(backup.BackupError):
            backup.create_backup(self.settings)
        self.assertFalse(self.settings.directory.exists())
        self.pump.assert_not_called()

    def test_midstream_capacity_refuses_before_chunk_write(self):
        with patch.object(backup, "_available", side_effect=[10**12, 10**12, 4096 + len(PAYLOAD) - 1, 10000]), \
                self.assertRaises(backup.BackupError):
            backup.create_backup(self.settings)
        partial = next(self.settings.directory.glob("*.dump.partial"))
        self.assertEqual(partial.stat().st_size, 0)
        self.assertEqual(len(self.receipts()), 1)
        self.assert_private(partial)
        self.assert_private(self.receipts()[0])

    def test_empty_bad_signature_or_list_failure_never_publish(self):
        for kind in ("empty", "signature", "list"):
            with self.subTest(kind=kind):
                settings = replace(self.settings, directory=self.root / kind)

                def produce(command, deadline, consume, limit):
                    if "--list" in command:
                        raise backup.BackupError("child_failed")
                    if kind != "empty":
                        consume(b"BAD!!" if kind == "signature" else PAYLOAD)

                with patch.object(backup, "_pump", side_effect=produce), self.assertRaises(backup.BackupError):
                    backup.create_backup(settings)
                self.assertFalse(list(settings.directory.glob("*.dump")))
                self.assertEqual(len(list(settings.directory.glob("*.failure.json"))), 1)

    def test_producer_failure_retains_partial_without_secrets(self):
        def fail(command, deadline, consume, limit):
            consume(PAYLOAD)
            raise RuntimeError("SECRET database content password=private")

        with patch.object(backup, "_pump", side_effect=fail), self.assertRaises(backup.BackupError) as error:
            backup.create_backup(self.settings)
        self.assertEqual(str(error.exception), "backup_failed")
        partial = next(self.settings.directory.glob("*.dump.partial"))
        self.assertEqual(partial.read_bytes(), PAYLOAD)
        receipt = self.receipts()[0].read_text()
        self.assertNotIn("SECRET", receipt)
        self.assertNotIn("password", receipt)
        self.assertEqual(json.loads(receipt)["bytes"], len(PAYLOAD))

    def test_real_producer_failure_timeout_warning_join_before_failure_receipt(self):
        for kind, tail, reason in (
            ("exit", "raise SystemExit(7)", "child_failed"),
            ("warning", "os.write(2,b'SECRET warning')", "child_diagnostics_require_review"),
            ("timeout", "time.sleep(30)", "deadline_exceeded"),
        ):
            with self.subTest(kind=kind):
                settings = replace(self.settings, directory=self.root / kind, max_seconds=0.3)
                code = f"import os,time; os.write(1,{PAYLOAD!r}); time.sleep(0.02); {tail}"

                def producer(command, deadline, consume, limit):
                    return REAL_PUMP([sys.executable, "-c", code], deadline, consume, limit)

                actual_json = backup._json
                actual_join = backup._kill_join
                with patch.object(backup, "_kill_join", wraps=actual_join) as joined:
                    def receipt_after_join(*args, **kwargs):
                        self.assertTrue(joined.called)
                        self.assertIsNotNone(joined.call_args.args[0].returncode)
                        return actual_json(*args, **kwargs)

                    with patch.object(backup, "_pump", side_effect=producer), \
                            patch.object(backup, "_json", side_effect=receipt_after_join), \
                            self.assertRaisesRegex(backup.BackupError, reason):
                        backup.create_backup(settings)
                partial = next(settings.directory.glob("*.dump.partial"))
                self.assertEqual(partial.read_bytes(), PAYLOAD)
                receipt = next(settings.directory.glob("*.failure.json"))
                self.assert_private(receipt)
                self.assertNotIn("SECRET", receipt.read_text())
                self.assertEqual(json.loads(receipt.read_text())["reason"], reason)
                self.assertFalse(list(settings.directory.glob("*.dump")))

    def test_real_producer_archive_size_cap(self):
        def producer(command, deadline, consume, limit):
            self.assertEqual(limit, 1032)
            return REAL_PUMP([sys.executable, "-c", "import os; os.write(1,b'PGDMP'+b'x'*2000)"],
                             deadline, consume, limit)

        with patch.object(backup, "ALLOWANCE", 8), \
                patch.object(backup, "_pump", side_effect=producer), \
                self.assertRaisesRegex(backup.BackupError, "output_limit_exceeded"):
            backup.create_backup(self.settings)
        self.assertFalse(list(self.settings.directory.glob("*.dump")))
        self.assertEqual(len(self.receipts()), 1)

    def test_settings_reject_traversal_and_unbounded_deadline(self):
        for settings in (replace(self.settings, directory=Path("/safe/../unsafe")),
                         replace(self.settings, directory=Path("/")),
                         replace(self.settings, database="--other"),
                         replace(self.settings, max_seconds=float("inf")),
                         replace(self.settings, reserve_bytes=-1)):
            with self.subTest(settings=settings), self.assertRaises(backup.BackupError):
                backup.create_backup(settings)


@unittest.skipUnless(LINUX_ROOT, "requires local Linux process groups and pipe selectors")
class ProcessTests(unittest.TestCase):
    def run_child(self, code, consume=None, limit=backup.CHUNK, seconds=3):
        output = bytearray()
        backup._pump([sys.executable, "-c", code], time.monotonic() + seconds,
                     consume or output.extend, limit)
        return bytes(output)

    def test_real_clean_pipes(self):
        self.assertEqual(self.run_child("import os; os.write(1,b'PGDMP')"), b"PGDMP")

    def test_exit_zero_warning_is_not_silently_accepted(self):
        with self.assertRaisesRegex(backup.BackupError, "^child_diagnostics_require_review$"):
            self.run_child("import os; os.write(2,b'SECRET warning'); os.write(1,b'PGDMP')")

    def test_environment_is_allowlisted_and_shell_disabled(self):
        actual = subprocess.Popen
        with patch.dict(os.environ, {"DATABASE_URL": "SECRET", "PGPASSWORD": "SECRET"}), \
                patch.object(backup.subprocess, "Popen", wraps=actual) as popen:
            self.run_child("import os; assert 'PGPASSWORD' not in os.environ; assert 'DATABASE_URL' not in os.environ")
        kwargs = popen.call_args.kwargs
        self.assertFalse(kwargs["shell"])
        self.assertTrue(kwargs["start_new_session"])
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(kwargs["env"]["PGPASSFILE"], "/nonexistent/va-dashboard-backup.pgpass")
        self.assertEqual(kwargs["env"]["PGSERVICEFILE"], "/nonexistent/va-dashboard-backup.pg_service.conf")
        self.assertEqual(kwargs["cwd"], "/")

    def test_nonzero_secret_stderr_is_not_exposed(self):
        with self.assertRaisesRegex(backup.BackupError, "^child_diagnostics_require_review$"):
            self.run_child("import os; os.write(2,b'SECRET'); raise SystemExit(7)")
        with self.assertRaisesRegex(backup.BackupError, "^child_failed$"):
            self.run_child("raise SystemExit(7)")

    def test_stdout_and_stderr_floods_are_bounded(self):
        for descriptor in (1, 2):
            with self.subTest(descriptor=descriptor), \
                    self.assertRaisesRegex(backup.BackupError, "output_limit_exceeded|child_diagnostics_require_review"):
                self.run_child(f"import os; os.write({descriptor},b'x'*200000)", limit=100)

    def test_timeout_kills_and_joins_even_with_closed_pipes(self):
        actual = backup._kill_join
        for code in ("import time; time.sleep(30)",
                     "import os,time; os.close(1); os.close(2); time.sleep(30)"):
            with self.subTest(code=code), patch.object(backup, "_kill_join", wraps=actual) as joined, \
                    self.assertRaisesRegex(backup.BackupError, "deadline_exceeded"):
                self.run_child(code, seconds=0.15)
            child = joined.call_args.args[0]
            self.assertIsNotNone(child.returncode)
            with self.assertRaises(ProcessLookupError):
                os.kill(child.pid, 0)

    def test_consumer_failure_joins_before_return(self):
        def refuse(data):
            raise backup.BackupError("insufficient_capacity")

        actual = backup._kill_join
        with patch.object(backup, "_kill_join", wraps=actual) as joined, \
                self.assertRaisesRegex(backup.BackupError, "insufficient_capacity"):
            self.run_child("import os,time; os.write(1,b'PGDMP'); time.sleep(30)", consume=refuse)
        self.assertIsNotNone(joined.call_args.args[0].returncode)

    def test_expired_deadline_does_not_spawn(self):
        with patch.object(backup.subprocess, "Popen") as popen, \
                self.assertRaisesRegex(backup.BackupError, "deadline_exceeded"):
            backup._pump(["unused"], time.monotonic() - 1, lambda data: None, 100)
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
