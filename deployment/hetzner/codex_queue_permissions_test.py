"""Synthetic Linux cross-UID proof; never opens app data or account credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'requires isolated Linux root test runner')
class QueuePermissionsTests(unittest.TestCase):
    def test_distinct_uids_exchange_only_group_transport(self):
        node = os.environ['VA_TEST_NODE']
        policy = Path(os.environ['VA_TEST_FILESYSTEM_POLICY']).resolve(strict=True)
        # These synthetic identities do not require creating or changing OS accounts.
        producer, consumer, group = 46006, 46007, 46006
        with tempfile.TemporaryDirectory(prefix='va-codex-transport-proof-') as root:
            root = Path(root)
            os.chmod(root, 0o755)
            shutil.copyfile(policy, root / 'policy.mjs')
            os.chmod(root / 'policy.mjs', 0o444)
            queue = root / 'queue'
            queue.mkdir()
            os.chown(queue, producer, group)
            os.chmod(queue, 0o2770)
            private = root / 'private'
            private.mkdir()
            os.chown(private, producer, group)
            os.chmod(private, 0o700)

            def execute(uid, groups, code, shared=True):
                env = {'PATH': '/usr/bin:/bin', 'NODE_ENV': 'test',
                       'APTLSS_CODEX_QUEUE_DIR': str(queue),
                       'APTLSS_CODEX_SHARED_QUEUE': 'true' if shared else 'false'}
                return subprocess.run(['setpriv', '--reuid', str(uid), '--regid', str(uid),
                    '--groups', groups, node, '--input-type=module', '-e', code],
                    cwd=root, env=env, capture_output=True, text=True, timeout=15)

            write = '''
import { atomicWriteQueueFile, atomicWriteLocalFile } from './policy.mjs';
process.umask(0o077);
await atomicWriteQueueFile('queue/request.json', 'synthetic request');
await atomicWriteLocalFile('private/instructions.txt', 'synthetic private instructions');
'''
            result = execute(producer, str(group), write)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((queue / 'request.json').stat().st_mode & 0o777, 0o660)
            self.assertEqual((queue / 'request.json').stat().st_gid, group)
            self.assertEqual((private / 'instructions.txt').stat().st_mode & 0o777, 0o600)

            exchange = '''
import assert from 'node:assert/strict';
import { readFile, rename, unlink } from 'node:fs/promises';
import { atomicWriteQueueFile } from './policy.mjs';
assert.equal(await readFile('queue/request.json','utf8'), 'synthetic request');
await rename('queue/request.json','queue/request.running');
process.umask(0o077);
await atomicWriteQueueFile('queue/reply.json','synthetic reply');
await unlink('queue/request.running');
await assert.rejects(readFile('private/instructions.txt','utf8'), { code: 'EACCES' });
'''
            result = execute(consumer, str(group), exchange)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((queue / 'reply.json').stat().st_gid, group)
            self.assertEqual((queue / 'reply.json').stat().st_mode & 0o777, 0o660)
            result = execute(producer, str(group), '''
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
assert.equal(await readFile('queue/reply.json','utf8'),'synthetic reply');
await unlink('queue/reply.json');
''')
            self.assertEqual(result.returncode, 0, result.stderr)
            result = execute(consumer, str(consumer), '''
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
await assert.rejects(readdir('queue'), { code: 'EACCES' });
await assert.rejects(writeFile('queue/forbidden.json','no access'), { code: 'EACCES' });
''')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(list(queue.iterdir()), [])
            os.chmod(queue, 0o770)
            result = execute(producer, str(group), '''
import assert from 'node:assert/strict';
import { atomicWriteQueueFile } from './policy.mjs';
await assert.rejects(atomicWriteQueueFile('queue/invalid.json','no'), /setgid/);
await assert.rejects(atomicWriteQueueFile('private/invalid.json','no'), /inside its queue/);
''')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((queue / 'invalid.json').exists())
        self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
