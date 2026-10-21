import { isAtisCliMain, loadAtisAnalysisCliCore, runAtisAnalysisCli } from './atisAnalysisCli';

export function main(argv = process.argv.slice(2)) {
  const scriptPath = import.meta.url.endsWith('.js') ? 'dist/tools/reanalyze_all.js' : 'server/scripts/reanalyze_all.ts';
  return runAtisAnalysisCli(argv, 'all', scriptPath, {
    loadCore: loadAtisAnalysisCliCore,
  });
}

if (isAtisCliMain(import.meta.url)) {
  void main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('ATIS command failed. No automatic retry was attempted.');
    process.exitCode = 1;
  });
}
