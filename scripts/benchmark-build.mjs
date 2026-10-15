// Optional measurement wrapper; run inside the builder container with the same
// resource limits as production. A warm cache and a cold build are not comparable.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const started = performance.now();
const args = process.argv.slice(2);
const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build',
  ...(args.length ? args : ['--projects', '/projects.yaml', '--out', '/releases', '--book', '--local-worker'])],
{ stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', async (code, signal) => {
  const peak = await readFile('/sys/fs/cgroup/memory.peak', 'utf8').catch(() => null);
  console.log(JSON.stringify({
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    containerPeakMiB: peak ? Number((Number(peak.trim()) / 1024 / 1024).toFixed(2)) : null,
    exitCode: code,
    signal,
    note: 'Container peak includes build processes and filesystem cache; warm-cache runs may reuse the PDF.',
  }));
  process.exitCode = code ?? 1;
});
