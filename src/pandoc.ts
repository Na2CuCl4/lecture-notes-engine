import { spawn } from 'node:child_process';
import type { PandocDocument } from './types.js';

/** Invoke the fixed Pandoc executable without a shell; callers supply stdin. */
export function runPandoc(args: string[], input: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PANDOC_BIN || 'pandoc', args, {
      cwd: options.cwd, windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', completed = false;
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Pandoc 超时（${options.timeoutMs ?? 30000} ms）`));
    }, options.timeoutMs ?? 30000);
    child.on('error', error => finish(new Error(`无法运行 Pandoc：${error.message}`)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 32 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('Pandoc 输出超过 32 MiB 限制'));
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16000); });
    child.stdin.on('error', () => { /* close/error reports the failure with stderr */ });
    child.on('close', code => finish(code === 0 ? undefined : new Error(`Pandoc 失败 (${code})：${errors.trim()}`)));
    child.stdin.end(input, 'utf8');
  });
}

export async function parseMarkdown(markdown: string): Promise<PandocDocument> {
  const json = await runPandoc([
    '--from=markdown-latex_macros+fenced_divs+bracketed_spans+tex_math_single_backslash+raw_tex+raw_html',
    '--to=json', '--wrap=none',
  ], markdown);
  return JSON.parse(json) as PandocDocument;
}

export async function renderHtml(ast: PandocDocument): Promise<string> {
  return runPandoc(['--from=json', '--to=html5', '--mathjax', '--wrap=none'], JSON.stringify(ast));
}
