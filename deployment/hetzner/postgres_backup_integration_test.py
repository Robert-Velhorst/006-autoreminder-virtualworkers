"""Opt-in native PG17 recovery proof using only newly owned synthetic databases."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid

ENABLED = sys.platform == 'linux' and os.geteuid() == 0 and os.environ.get('VA_BACKUP_NATIVE_TEST') == '1'
PG_BIN = Path('/usr/lib/postgresql/17/bin')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'PGCONNECT_TIMEOUT': '10', 'PGOPTIONS': '-c timezone=UTC'}


@unittest.skipUnless(ENABLED, 'explicit Linux root native fixture opt-in required')
class NativePostgresBackupTests(unittest.TestCase):
    def test_owned_database_backup_restore_values_and_sequence(self):
        token = uuid.uuid4().hex[:16]
        names = [f'va_backup_fixture_{token}', f'va_backup_restore_{token}']
        marker = 'va-dashboard-synthetic-backup-test:' + token
        created = []
        root = Path(tempfile.mkdtemp(prefix='va-pgbackup-native-', dir='/root'))

        def command(tool, *args, stdin=None):
            completed = subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', str(PG_BIN / tool),
                '--host=/var/run/postgresql', '--port=5432', *args], env=ENV, stdin=stdin,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            if completed.returncode:
                self.fail('Synthetic PostgreSQL operation failed: ' + tool)
            return completed.stdout.decode('utf8').strip()

        def sql(database, query):
            return command('psql', '--no-psqlrc', '--tuples-only', '--no-align',
                           '--set=ON_ERROR_STOP=1', '--dbname=' + database, '--command=' + query)

        try:
            self.assertTrue(all(re.fullmatch(r'va_backup_(fixture|restore)_[a-f0-9]{16}', name) for name in names))
            self.assertTrue(sql('postgres', 'SHOW server_version_num').startswith('17'))
            for name in names:
                self.assertEqual(sql('postgres', f"SELECT count(*) FROM pg_database WHERE datname='{name}'"), '0')
                command('createdb', '--template=template0', '--owner=postgres', name)
                created.append(name)
                sql('postgres', f'COMMENT ON DATABASE "{name}" IS \'{marker}\'')
            source, restored = names
            sql(source, '''
CREATE TABLE public.backup_probe (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL, amount numeric(12,2), recorded_at timestamptz,
  payload bytea, attributes jsonb, optional_note text
);
INSERT INTO public.backup_probe (label, amount, recorded_at, payload, attributes, optional_note)
SELECT U&'Synthetisch \\2014 \\65e5\\672c\\8a9e ' || g, g::numeric / 100,
  TIMESTAMPTZ '2026-10-23 00:00:00+00' + g * INTERVAL '1 minute',
  decode(md5(g::text), 'hex'), jsonb_build_object('n',g,'flag',g % 2 = 0),
  CASE WHEN g % 2 = 0 THEN NULL ELSE 'retained' END
FROM generate_series(1,20) AS g;
''')
            value_query = "SELECT md5(string_agg(row_to_json(p)::text, E'\\n' ORDER BY id)) FROM public.backup_probe p"
            schema_query = """SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' ||
              coalesce(identity_generation,''), ',' ORDER BY ordinal_position)
              FROM information_schema.columns WHERE table_schema='public' AND table_name='backup_probe'"""
            values, schema = sql(source, value_query), sql(source, schema_query)
            spec = importlib.util.spec_from_file_location('va_postgres_backup_native', Path(__file__).with_name('postgres_backup.py'))
            backup = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = backup
            spec.loader.exec_module(backup)
            receipt = backup.create_backup(backup.BackupSettings(database=source, directory=root / 'backups', max_seconds=60))
            archive = Path(receipt['archive'])
            self.assertEqual(archive.parent, root / 'backups')
            self.assertFalse(receipt['restoreVerified'])
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), receipt['sha256'])
            self.assertEqual(archive.stat().st_size, receipt['bytes'])
            manifest = Path(receipt['receipt'])
            self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)
            self.assertFalse(json.loads(manifest.read_text())['restoreVerified'])
            with archive.open('rb') as stream:
                command('pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
                        '--dbname=' + restored, stdin=stream)
            self.assertEqual(sql(restored, value_query), values)
            self.assertEqual(sql(restored, schema_query), schema)
            self.assertEqual(sql(restored, 'SELECT count(*) FROM public.backup_probe'), '20')
            next_id = sql(restored, "INSERT INTO public.backup_probe(label) VALUES ('restored identity probe') RETURNING id")
            self.assertEqual(next_id.splitlines()[0], '21')
            self.assertEqual(sql(source, 'SELECT count(*) FROM public.backup_probe'), '20')
        finally:
            for name in reversed(created):
                self.assertEqual(sql('postgres', f"SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname='{name}'"), marker)
                command('dropdb', name)
                self.assertEqual(sql('postgres', f"SELECT count(*) FROM pg_database WHERE datname='{name}'"), '0')
            self.assertEqual(root.parent, Path('/root'))
            self.assertTrue(root.name.startswith('va-pgbackup-native-'))
            self.assertTrue(stat.S_ISDIR(root.lstat().st_mode))
            # Only these owned synthetic test artifacts, never a retained real backup.
            shutil.rmtree(root)
            self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
