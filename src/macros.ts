import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/configmacros/ConfigMacrosConfiguration.js';
import 'mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';

/** The deliberately shared subset used by MathJax and the PDF template. */
export type MacroConfig = Record<string, string | [string, number]>;

// No autoload, require, newcommand, HTML, URL, or extension packages. An unknown
// command must be a build error rather than loading code or printing red text.
export const MATHJAX_PACKAGES = ['base', 'ams', 'configmacros', 'textmacros', 'boldsymbol'] as const;
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const forbidden = new Set([
  'input', 'include', 'includeonly', 'includegraphics', 'graphicspath',
  'openin', 'openout', 'closein', 'closeout', 'read', 'readline', 'write', 'immediate',
  'special', 'usepackage', 'RequirePackage', 'documentclass', 'LoadClass',
  'catcode', 'mathcode', 'lccode', 'uccode', 'delcode', 'endlinechar', 'escapechar',
  'csname', 'endcsname', 'expandafter', 'noexpand', 'unexpanded', 'expanded',
  'def', 'edef', 'gdef', 'xdef', 'let', 'futurelet', 'global', 'long', 'outer',
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand',
  'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'DeclareMathSymbol',
  'newcount', 'newdimen', 'newskip', 'newtoks', 'newread', 'newwrite', 'newif',
  'count', 'dimen', 'skip', 'toks', 'advance', 'multiply', 'divide',
  'loop', 'repeat', 'if', 'ifx', 'ifcat', 'ifnum', 'ifdim', 'ifdefined', 'ifcsname',
  'iftrue', 'iffalse', 'else', 'fi', 'afterassignment', 'aftergroup',
  'everymath', 'everydisplay', 'everyjob', 'everypar', 'everyeof',
  'require', 'href', 'url', 'class', 'style', 'cssId',
  'htmlClass', 'htmlId', 'htmlStyle', 'htmlData', 'html',
  'verb', 'Verb', 'verbatim', 'scantokens', 'detokenize', 'string', 'meaning',
  'jobname', 'font', 'fontname', 'shipout', 'dump', 'endinput',
  'pdfobj', 'pdfxform', 'pdfliteral', 'pdfcatalog', 'pdfinfo',
  'directlua', 'latelua', 'luaexec', 'XeTeXpicfile', 'XeTeXpdffile',
]);
const protectedNames = new Set([...forbidden, 'begin', 'end', 'left', 'right']);

function failure(source: string, message: string, input?: string, offset?: number): never {
  let position = '';
  if (input !== undefined && offset !== undefined) {
    const before = input.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    position = `:${line}:${column}`;
  }
  throw new Error(`${source}${position}：${message}`);
}

/** Remove comments without treating an escaped percent sign as a comment. */
function withoutComments(input: string): string {
  let result = '';
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\' && i + 1 < input.length) {
      result += input[i] + input[++i];
    } else if (input[i] === '%') {
      while (i + 1 < input.length && input[i + 1] !== '\n') i++;
    } else {
      result += input[i];
    }
  }
  return result;
}

function commandTokens(clean: string): { name: string; end: number }[] {
  const result: { name: string; end: number }[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '\\') continue;
    const start = ++i;
    if (/[A-Za-z]/.test(clean[i] ?? '')) {
      while (i + 1 < clean.length && /[A-Za-z]/.test(clean[i + 1])) i++;
      result.push({ name: clean.slice(start, i + 1), end: i + 1 });
    } else if (i < clean.length) {
      result.push({ name: clean[i], end: i + 1 });
    }
  }
  return result;
}

function commands(input: string): string[] {
  return commandTokens(withoutComments(input)).map(token => token.name);
}

function checkSafe(input: string, source: string): void {
  const clean = withoutComments(input);
  if (clean.includes('^^')) failure(source, '不支持 TeX 的 ^^ 字符编码，请直接使用对应字符。');
  if (clean.includes('\u0000')) failure(source, '公式含有无效的 NUL 字符。');
  for (const name of commands(clean)) {
    if (forbidden.has(name)) {
      failure(source, `不允许命令 \\${name}；公式只能使用固定的数学命令，公共宏请在 math/macros.tex 中声明。`);
    }
  }
}

function makeInput(macros: MacroConfig): TeX<any, any, any> {
  return new TeX({
    packages: [...MATHJAX_PACKAGES],
    macros,
    maxBuffer: 256 * 1024,
    maxMacros: 1000,
    formatError: (_jax: unknown, error: Error) => { throw error; },
  });
}

function checkKnownCommands(input: string, jax: TeX<any, any, any>, source: string): void {
  const handlers = jax.parseOptions.handlers.get('macro');
  const textHandlers = jax.parseOptions.packageData.get('textmacros').parseOptions.handlers.get('macro');
  const clean = withoutComments(input);
  for (const { name: command, end } of commandTokens(clean)) {
    if (!handlers.contains(command) && !handlers.contains(`\\${command}`) && !textHandlers.contains(command)) {
      failure(source, `数学公式无法解析：未知数学命令 \\${command}；请修正拼写或在 math/macros.tex 中声明。`);
    }
    if (command === 'begin' || command === 'end') {
      const environment = /^\s*\{([^{}\\]*)\}/.exec(clean.slice(end));
      if (!environment || !jax.parseOptions.handlers.get('environment').contains(environment[1].trim())) {
        failure(source, `数学公式无法解析：\\${command} 只能指定固定的数学环境；${environment ? environment[1] : '该环境名称'} 不受支持。`);
      }
    }
  }
}

/** Parse declarations only. Nested braces and comments are understood. */
export function parseMacros(input: string): MacroConfig {
  const source = 'math/macros.tex';
  if (input.length > 128 * 1024) failure(source, '宏文件超过 128 KiB 的限制。');
  let cursor = 0;
  const macros: MacroConfig = Object.create(null) as MacroConfig;
  const skip = () => {
    while (cursor < input.length) {
      if (/\s/.test(input[cursor]) || (cursor === 0 && input[cursor] === '\uFEFF')) cursor++;
      else if (input[cursor] === '%') {
        while (cursor < input.length && input[cursor] !== '\n') cursor++;
      } else break;
    }
  };
  const group = (): string => {
    skip();
    if (input[cursor] !== '{') failure(source, '此处应为花括号包围的内容。', input, cursor);
    const start = ++cursor;
    let depth = 1;
    while (cursor < input.length) {
      const character = input[cursor++];
      if (character === '\\') cursor++; // Escaped braces and percent signs are literal.
      else if (character === '%') {
        while (cursor < input.length && input[cursor] !== '\n') cursor++;
      } else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return input.slice(start, cursor - 1);
    }
    failure(source, '宏声明的花括号未闭合。', input, start - 1);
  };
  while (true) {
    skip();
    if (cursor >= input.length) break;
    const start = cursor;
    const declaration = /^\\(newcommand|renewcommand)(?![A-Za-z])/.exec(input.slice(cursor));
    if (!declaration) failure(source, '只允许 \\newcommand 或 \\renewcommand 声明；发现声明外的内容。', input, cursor);
    cursor += declaration[0].length;
    if (input[cursor] === '*') cursor++;
    skip();
    let rawName: string;
    if (input[cursor] === '{') rawName = withoutComments(group()).trim();
    else {
      const name = /^\\[A-Za-z]+/.exec(input.slice(cursor));
      if (!name) failure(source, '宏名应写成 {\\RR} 或 \\RR。', input, cursor);
      rawName = name[0];
      cursor += rawName.length;
    }
    if (!/^\\[A-Za-z]+$/.test(rawName)) failure(source, '宏名必须是反斜线后跟英文字母。', input, start);
    const name = rawName.slice(1);
    if (protectedNames.has(name)) failure(source, `不能重定义保留命令 \\${name}。`, input, start);
    if (declaration[1] === 'newcommand' && Object.hasOwn(macros, name)) {
      failure(source, `宏 \\${name} 已声明；更新定义请使用 \\renewcommand。`, input, start);
    }
    skip();
    let count = 0;
    if (input[cursor] === '[') {
      const end = input.indexOf(']', cursor + 1);
      if (end < 0) failure(source, '宏参数数量的方括号未闭合。', input, cursor);
      const value = withoutComments(input.slice(cursor + 1, end)).trim();
      if (!/^[0-9]$/.test(value)) failure(source, '宏只支持 0～9 个固定参数。', input, cursor);
      count = Number(value);
      cursor = end + 1;
      skip();
      if (input[cursor] === '[') failure(source, '不支持带默认值的可选宏参数，请改为固定参数。', input, cursor);
    }
    const body = group();
    checkSafe(body, `${source} 中的 \\${name}`);
    macros[name] = count ? [body, count] : body;
  }
  validateMacroConfig(macros, source);
  return macros;
}

const validatedConfigurations = new Set<string>();

/** Validate externally loaded configuration as well as parsed macros.tex data. */
export function validateMacroConfig(macros: MacroConfig, source = 'math/macros.tex'): void {
  if (!macros || typeof macros !== 'object' || Array.isArray(macros)) failure(source, '宏配置必须是对象。');
  const entries = Object.entries(macros);
  if (entries.length > 256) failure(source, '宏数量超过 256 个的限制。');
  const key = JSON.stringify(entries);
  if (key.length > 128 * 1024) failure(source, '宏配置超过 128 KiB 的限制。');
  if (validatedConfigurations.has(key)) return;
  const dependency = new Map<string, string[]>();
  for (const [name, value] of entries) {
    if (!/^[A-Za-z]+$/.test(name) || protectedNames.has(name)) failure(source, `宏名 ${name} 无效或属于保留命令。`);
    if (!(typeof value === 'string' || (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]) && value[1] >= 0 && value[1] <= 9))) {
      failure(source, `宏 \\${name} 的值应为字符串，或 [字符串, 0～9 的参数数量]。`);
    }
    const body = typeof value === 'string' ? value : value[0];
    const count = typeof value === 'string' ? 0 : value[1];
    const clean = withoutComments(body);
    checkSafe(body, `${source} 中的 \\${name}`);
    let braceDepth = 0;
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '\\') i++;
      else if (clean[i] === '{') braceDepth++;
      else if (clean[i] === '}' && --braceDepth < 0) failure(source, `宏 \\${name} 有多余的右花括号。`);
      else if (clean[i] === '#') {
        const parameter = clean[++i];
        if (!/[1-9]/.test(parameter ?? '') || Number(parameter) > count) {
          failure(source, `宏 \\${name} 引用了未声明的参数 #${parameter ?? ''}；该宏有 ${count} 个固定参数。`);
        }
      }
    }
    if (braceDepth !== 0) failure(source, `宏 \\${name} 的花括号未闭合。`);
    dependency.set(name, commands(body).filter(command => Object.hasOwn(macros, command)));
  }
  const completed = new Set<string>();
  const active: string[] = [];
  const visit = (name: string): void => {
    const cycle = active.indexOf(name);
    if (cycle >= 0) failure(source, `不允许递归宏：${[...active.slice(cycle), name].map(item => `\\${item}`).join(' → ')}。`);
    if (completed.has(name)) return;
    active.push(name);
    for (const next of dependency.get(name) ?? []) visit(next);
    active.pop();
    completed.add(name);
  };
  for (const name of dependency.keys()) visit(name);

  // Check the parser's registered commands, not an ad-hoc TeX vocabulary. Do
  // not invent dummy arguments: a valid macro may alias \widehat or open a
  // delimiter which a second macro closes. Full syntax is checked at each use.
  const input = makeInput(macros);
  for (const [name, value] of entries) {
    const body = typeof value === 'string' ? value : value[0];
    checkKnownCommands(body, input, `${source} 中的 \\${name}`);
  }
  if (validatedConfigurations.size >= 32) validatedConfigurations.clear();
  validatedConfigurations.add(key);
}

function convertMath(expression: string, display: boolean, macros: MacroConfig, source: string): void {
  // Check text-mode tokens as well: plain MathJax's default text parser otherwise
  // accepts unknown control sequences literally, unlike the PDF TeX engine.
  const input = makeInput(macros);
  checkKnownCommands(expression, input, source);
  try {
    // A fresh TeX parser per expression avoids order-dependent labels and state.
    const document = mathjax.document('', {
      InputJax: input,
      OutputJax: new SVG({ fontCache: 'none' }),
      compileError: (_document: unknown, _math: unknown, error: Error) => { throw error; },
      typesetError: (_document: unknown, _math: unknown, error: Error) => { throw error; },
    });
    document.convert(expression, { display });
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
    failure(source, `数学公式无法解析：${message}`);
  }
}

export function validateMath(expression: string, display: boolean, macros: MacroConfig, source: string): void {
  if (expression.length > 256 * 1024) failure(source, '单个公式超过 256 KiB 的限制。');
  validateMacroConfig(macros);
  checkSafe(expression, source);
  convertMath(expression, display, macros, source);
}

/** Emit a validated preamble without copying arbitrary source-file contents. */
export function canonicalMacros(macros: MacroConfig): string {
  validateMacroConfig(macros);
  return Object.entries(macros).map(([name, value]) => {
    const body = typeof value === 'string' ? value : value[0];
    const count = typeof value === 'string' ? 0 : value[1];
    return `\\providecommand{\\${name}}{}\n\\renewcommand{\\${name}}${count ? `[${count}]` : ''}{${body}\n}`;
  }).join('\n');
}
