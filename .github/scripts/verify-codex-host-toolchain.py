"""Owned hosted binary proof; never run host preparation or access real data."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('GITHUB_REPOSITORY') == 'Robert-Velhorst/006-autoreminder-virtualworkers'
assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
assert sys.platform == 'linux' and platform.machine() == 'x86_64' and os.getuid() != 0
root=Path(__file__).resolve().parents[2]
out=root/'HOST_TOOLCHAIN_EVIDENCE';out.mkdir(exist_ok=True)

def source_identity():
    files={}
    for row in subprocess.check_output(['git','ls-tree','-rz','HEAD'],cwd=root).split(b'\0'):
        if not row:continue
        left,name=row.split(b'\t');mode,kind,blob=left.decode().split();assert kind=='blob'
        path=root/os.fsdecode(name);payload=os.readlink(path).encode() if mode=='120000' else path.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(payload)).encode()+b'\0'+payload).hexdigest()==blob
        files[os.fsdecode(name)]={'mode':mode,'blob':blob,'sha256':hashlib.sha256(payload).hexdigest()}
    return {'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'tree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=root,text=True).strip(),'payloads':files}

before=source_identity();(out/'source-before.json').write_text(json.dumps(before,indent=2)+'\n')
record={'original_cases_modified':False,'host_preparation_main_called':False,'operator_data_or_credentials_used':False,'live_deployment':False,'full_original_vendor_SDK_qualification':False,'binary_checks':[]}
try:
    test=subprocess.run(['python3','-B','-I','deployment/hetzner/prepare_codex_host_test.py'],cwd=root,capture_output=True,text=True,timeout=120)
    (out/'original-prepare-cases.log').write_text(test.stdout+test.stderr);record['original_prepare_cases_exit_code']=test.returncode
    assert test.returncode==0,test.stderr
    spec=importlib.util.spec_from_file_location('host_preparation',root/'deployment/hetzner/prepare-codex-host.py');host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
    pins=json.loads((root/'deployment/hetzner/codex-host-toolchain.json').read_text())
    assert host.NODE_URL==pins['node']['url'] and host.NODE_SHA==pins['node']['archive_sha256']
    assert host.CODEX_URL==pins['codex']['url'] and host.CODEX_SHA==pins['codex']['archive_sha256']
    with tempfile.TemporaryDirectory(prefix='va-host-native-proof-') as temporary:
        space=Path(temporary);os.chmod(space,0o755);home=space/'home';home.mkdir();os.chmod(home,0o700)
        env={'HOME':str(home),'CODEX_HOME':str(home/'codex'),'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}
        for name,pin in pins.items():
            archive=space/(name+'.archive');executable=space/name
            host.download(pin['url'],archive,pin['archive_sha256'])
            assert hashlib.sha256(archive.read_bytes()).hexdigest()==pin['archive_sha256']
            host.binary(archive,pin['member'],executable)
            wrapper='''import json,os,pathlib,socket,subprocess,sys
assert os.getuid()!=0 and os.getgroups()==[]
status=pathlib.Path('/proc/self/status').read_text(); fields=dict(line.split(':',1) for line in status.splitlines() if ':' in line)
assert fields['NoNewPrivs'].strip()=='1'
for cap in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']:assert int(fields[cap].strip(),16)==0
assert [name for _,name in socket.if_nameindex()]==['lo']
probe=socket.socket();probe.settimeout(1)
try:probe.connect(('1.1.1.1',443))
except OSError as error:assert error.errno==101
else:raise AssertionError('Network namespace permits external connections')
finally:probe.close()
result=subprocess.run([sys.argv[1],'--version'],capture_output=True,text=True,timeout=30,check=True)
print(json.dumps({'stdout':result.stdout.strip(),'stderr':result.stderr.strip(),'uid':os.getuid(),'groups':os.getgroups(),'NoNewPrivs':True,'capabilities_zero':True,'external_network_denied':True,'network_namespace':os.readlink('/proc/self/ns/net')}))
'''
            args=['sudo','unshare','--net','--','setpriv','--reuid',str(os.getuid()),'--regid',str(os.getgid()),'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all',sys.executable,'-I','-B','-c',wrapper,str(executable)]
            result=subprocess.run(args,cwd=space,env=env,capture_output=True,text=True,timeout=60)
            assert result.returncode==0,result.stderr
            observed=json.loads(result.stdout);assert observed['stdout']==('v'+pin['version'] if name=='node' else 'codex-cli '+pin['version'])
            assert observed['network_namespace']!=os.readlink('/proc/self/ns/net')
            record['binary_checks'].append({'name':name,**pin,'actual':observed,'executable_sha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'archive_size':archive.stat().st_size})
    record['component_acceptance']=True
except BaseException as error:
    record['failure']=repr(error);record['component_acceptance']=False
    raise
finally:
    after=source_identity();(out/'source-after.json').write_text(json.dumps(after,indent=2)+'\n')
    record['all_tracked_payloads_unchanged']=before==after
    record['SDK_python']=platform.python_version()
    (out/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
    assert before==after,'Tracked source changed during proof.'
    print(json.dumps({'component_acceptance':record.get('component_acceptance'),'source_payloads':len(before['payloads']),'failure':record.get('failure')}))
