import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_codex', Path(__file__).with_name('prepare-codex-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Response(io.BytesIO):
    url = 'https://official.example/distribution'


class HostPreparationTests(unittest.TestCase):
    def test_directory_mode_survives_restrictive_umask(self):
        with tempfile.TemporaryDirectory() as root:
            previous = host.os.umask(0o077)
            try:
                target = Path(root) / 'queue'
                host.directory(target, 0o770)
                self.assertEqual(target.stat().st_mode & 0o777, 0o770)
                with self.assertRaises(FileExistsError):
                    host.directory(target, 0o700)
            finally:
                host.os.umask(previous)

    def test_exclusive_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'binary'
            host.exclusive(target, b'verified', 0o755)
            self.assertEqual(target.read_bytes(), b'verified')
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)

    def test_existing_files_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'retained'
            target.write_bytes(b'original')
            with self.assertRaises(FileExistsError):
                host.exclusive(target, b'replacement')
            self.assertEqual(target.read_bytes(), b'original')

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'retained'
            target.write_bytes(b'original')
            link = Path(directory) / 'link'
            link.symlink_to(target)
            with self.assertRaises(OSError):
                host.exclusive(link, b'replacement')
            self.assertEqual(target.read_bytes(), b'original')

    def test_checksum_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'download'
            with patch.object(host.urllib.request, 'urlopen', return_value=Response(b'official')):
                host.download('https://official.example/distribution', target, hashlib.sha256(b'official').hexdigest())
            self.assertEqual(target.read_bytes(), b'official')

    def test_checksum_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(host.urllib.request, 'urlopen', return_value=Response(b'tampered')):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    host.download('https://official.example/distribution', Path(directory) / 'download', '0' * 64)

    def test_non_tls_redirect_refused(self):
        response = Response(b'data')
        response.url = 'http://insecure.example/distribution'
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'download'
            with patch.object(host.urllib.request, 'urlopen', return_value=response):
                with self.assertRaisesRegex(RuntimeError, 'outside TLS'):
                    host.download('https://official.example/distribution', target, '0' * 64)
            self.assertFalse(target.exists())

    def test_extracts_only_expected_regular_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / 'source.tar'
            with tarfile.open(archive_path, 'w') as archive:
                member = tarfile.TarInfo('official-binary')
                member.size = 4
                archive.addfile(member, io.BytesIO(b'code'))
                other = tarfile.TarInfo('../not-extracted')
                other.size = 4
                archive.addfile(other, io.BytesIO(b'junk'))
            target = Path(directory) / 'binary'
            host.binary(archive_path, 'official-binary', target)
            self.assertEqual(target.read_bytes(), b'code')
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['binary', 'source.tar'])

    def test_archive_link_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / 'source.tar'
            with tarfile.open(archive_path, 'w') as archive:
                member = tarfile.TarInfo('official-binary')
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                archive.addfile(member)
            with self.assertRaisesRegex(RuntimeError, 'regular executable'):
                host.binary(archive_path, 'official-binary', Path(directory) / 'binary')

    def test_non_root_preflight_does_not_run_commands(self):
        with patch.object(host.os, 'geteuid', return_value=1234), patch.object(host, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'requires the approved'):
                host.main()
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
