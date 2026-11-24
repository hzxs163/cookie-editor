#!/usr/bin/env node
/**
 * Cookie-Editor 简体中文汉化器。
 *
 * 把上游源码目录复制成可直接加载的扩展目录，并在复制过程中替换界面文案。
 * 词典见同目录 zh-CN.json；上游改了文案时，未命中的条目只会留在报告里，
 * 不会让构建失败（除非 --strict）。
 *
 * 用法:
 *   node localize/localize.mjs --src . --out dist
 *   node localize/localize.mjs --src . --out dist --browsers chrome,edge
 *   node localize/localize.mjs --src . --out dist --report dist/report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSERS = ['chrome', 'edge', 'firefox', 'opera'];
const HTML_ATTRS = [
  'placeholder',
  'title',
  'aria-label',
  'alt',
  'data-tooltip',
  'data-tooltip-left',
];
// 只对这些文件做 JS 字符串替换，避免误伤业务逻辑里的字面量。
const JS_FILES = [
  'interface/lib/cookie.js',
  'interface/lib/ads/activeAds.js',
  'interface/popup/cookie-list.js',
  'interface/devtools/cookieHandlerDevtools.js',
  'interface/options/options.js',
  'interface/devtools/devtools.js',
  'cookie-editor.js',
];
const COPY_ENTRIES = ['interface', 'icons', 'cookie-editor.js'];
const CJK = /[\u4e00-\u9fff]/;

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @return {object}
 */
function parseArgs(argv) {
  const args = {
    src: '.',
    out: 'dist',
    browsers: BROWSERS,
    report: null,
    zip: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--browsers') args.browsers = argv[++i].split(',');
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--zip') args.zip = true;
    else if (a === '--strict') args.strict = true;
  }
  return args;
}

const normalize = text => text.replace(/\s+/g, ' ').trim();

/**
 * 递归复制目录。
 * @param {string} from
 * @param {string} to
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 替换标签内的界面属性值。
 * @param {string} tag
 * @param {object} dict
 * @param {object} report
 * @return {string}
 */
function patchAttrs(tag, dict, report) {
  return tag.replace(
    /([a-zA-Z-]+)=("([^"]*)"|'([^']*)')/g,
    (match, name, whole, dq, sq) => {
      if (!HTML_ATTRS.includes(name)) return match;
      const raw = dq !== undefined ? dq : sq;
      const key = normalize(raw);
      const zh = dict.attrs[key];
      if (zh === undefined || !key) return match;
      report.attrs.hit.push(key);
      const quote = dq !== undefined ? '"' : "'";
      return `${name}=${quote}${zh}${quote}`;
    }
  );
}

/**
 * 逐段替换 HTML 里的文本节点与属性，保留原有缩进换行。
 * @param {string} html
 * @param {object} dict
 * @param {object} report
 * @param {string} file
 * @return {string}
 */
function patchHtml(html, dict, report, file) {
  const parts = html.split(/(<[^>]*>)/);
  const out = parts.map(part => {
    if (part.startsWith('<') && part.endsWith('>')) {
      let tag = patchAttrs(part, dict, report);
      if (/^<html(\s|>)/i.test(tag) && tag.includes('lang="en"')) {
        tag = tag.replace('lang="en"', 'lang="zh-CN"');
      }
      return tag;
    }
    const key = normalize(part);
    if (!key) return part;
    const zh = dict.text[key];
    if (zh === undefined) {
      const keep = dict.keep || [];
      if (/[A-Za-z]{2,}/.test(key) && !CJK.test(key) && !keep.includes(key)) {
        report.missing.push({ file, text: key });
      }
      return part;
    }
    report.text.hit.push(key);
    const lead = part.match(/^\s*/)[0];
    const trail = part.match(/\s*$/)[0];
    return lead + zh + trail;
  });
  return out.join('');
}

/**
 * 替换 JS 里写死的界面字符串（只处理完整的字符串字面量）。
 * @param {string} code
 * @param {object} dict
 * @param {object} report
 * @param {string} file
 * @return {string}
 */
function patchJs(code, dict, report, file) {
  const entries = Object.entries(dict.js).sort(
    (a, b) => b[0].length - a[0].length
  );
  let result = code;
  for (const [en, zh] of entries) {
    let count = 0;
    for (const quote of ['\'', '"', '`']) {
      if (en.includes(quote)) continue;
      const needle = quote + en + quote;
      const hits = result.split(needle).length - 1;
      if (hits > 0) {
        result = result.split(needle).join(quote + zh + quote);
        count += hits;
      }
    }
    report.js.push({ file, en, count });
  }
  return result;
}

/**
 * 注入浏览器原生报错的翻译函数，并把发送报错的入口改走它。
 *
 * 浏览器 cookies / permissions API 抛出的 message 是英文且无法在源码里改，
 * 所以在构建时塞一个小函数：已知文案查表，带数据的用正则，认不出来的
 * 保留原文并加中文前缀，保证不会把有用信息吞掉。
 * @param {string} code cookie-list.js 源码（已做过普通文案替换）。
 * @param {object} dict 词典。
 * @return {object} {code, sites, rules, exact}
 */
function patchBrowserErrors(code, dict) {
  const cfg = dict.errors || {};
  const exact = cfg.exact || {};
  const rules = cfg.rules || [];
  const helper = [
    '  // ==== 浏览器原生报错翻译（由 localize/zh-CN.json 的 errors 段生成）====',
    `  const CE_ZH_ERROR_EXACT = ${JSON.stringify(exact)};`,
    '  const CE_ZH_ERROR_RULES = [',
    ...rules.map(
      r =>
        `    [new RegExp(${JSON.stringify(r.re)}, ${JSON.stringify(
          r.flags || ''
        )}), ${JSON.stringify(r.zh)}],`
    ),
    '  ];',
    '  function ceZhError(error) {',
    '    const raw =',
    '      error && error.message',
    '        ? error.message',
    "        : error instanceof Error ? '' : String(error);",
    "    const text = (raw || '').trim();",
    `    if (!text) return ${JSON.stringify(
      cfg.empty || '操作失败，浏览器没有给出原因。'
    )};`,
    '    if (Object.prototype.hasOwnProperty.call(CE_ZH_ERROR_EXACT, text)) {',
    '      return CE_ZH_ERROR_EXACT[text];',
    '    }',
    '    for (const rule of CE_ZH_ERROR_RULES) {',
    '      const match = text.match(rule[0]);',
    '      if (match) {',
    "        return rule[1].replace(/\\$(\\d)/g, (_, n) => (match[Number(n)] || '').trim());",
    '      }',
    '    }',
    `    return ${JSON.stringify(cfg.prefix || '操作失败：')} + text;`,
    '  }',
    '',
  ].join('\n');

  const marker = '  function sendNotification(message) {';
  const needle = 'sendNotification(error.message || String(error))';
  const sites = code.split(needle).length - 1;
  const info = { sites, rules: rules.length, exact: Object.keys(exact).length };
  if (!code.includes(marker)) {
    return { ...info, code, sites: 0 };
  }
  let result = code.replace(marker, helper + marker);
  result = result
    .split(needle)
    .join('sendNotification(ceZhError(error))');
  return { ...info, code: result };
}

/**
 * 生成某个浏览器的扩展目录。
 * @param {string} srcRoot 上游源码根目录。
 * @param {string} outDir 该浏览器的输出目录。
 * @param {string} browser 浏览器标识。
 * @param {object} dict 词典。
 * @param {object} report 报告。
 * @return {object} 构建信息。
 */
function buildBrowser(srcRoot, outDir, browser, dict, report) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    const s = path.join(srcRoot, entry);
    const d = path.join(outDir, entry);
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }

  // 1. HTML 文案
  const htmlFiles = [];
  const collect = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith('.html')) htmlFiles.push(p);
    }
  };
  collect(path.join(outDir, 'interface'));
  for (const file of htmlFiles) {
    const rel = path.relative(outDir, file);
    const html = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, patchHtml(html, dict, report, rel));
  }

  // 2. JS 文案
  for (const rel of JS_FILES) {
    const file = path.join(outDir, rel);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, patchJs(code, dict, report, rel));
  }

  // 2b. 浏览器原生报错（只在所有界面共用的 cookie-list.js 上注入一次）
  const listFile = path.join(outDir, 'interface/popup/cookie-list.js');
  if (fs.existsSync(listFile)) {
    const patched = patchBrowserErrors(
      fs.readFileSync(listFile, 'utf8'),
      dict
    );
    fs.writeFileSync(listFile, patched.code);
    report.errors = {
      sites: patched.sites,
      rules: patched.rules,
      exact: patched.exact,
    };
    if (!patched.sites && browser === 'chrome') {
      console.log(
        '⚠️  cookie-list.js 里找不到报错提示入口（上游可能改了代码），本次未做报错翻译'
      );
    }
  }

  // 3. manifest.json
  const manifestSrc = path.join(srcRoot, `manifest.${browser}.json`);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8')
  );
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  manifest.version = pkg.version;
  if (dict.manifest?.description && manifest.description) {
    manifest.description = dict.manifest.description;
  }
  if (manifest.action?.default_title && dict.manifest?.actionTitle) {
    manifest.action.default_title = dict.manifest.actionTitle;
  }
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, '\t') + '\n'
  );

  // 4. 构建时替换 @@browser_name
  const envFile = path.join(outDir, 'interface/lib/env.js');
  if (fs.existsSync(envFile)) {
    const env = fs.readFileSync(envFile, 'utf8');
    fs.writeFileSync(envFile, env.split('@@browser_name').join(browser));
  }

  // 5. 构建信息（便于确认装的是哪一版）
  const info = {
    name: 'Cookie-Editor 简体中文汉化版',
    browser,
    version: pkg.version,
    upstream: process.env.UPSTREAM_REPO || 'Moustachauve/cookie-editor',
    upstreamSha: process.env.UPSTREAM_SHA || '',
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, 'zh-build.json'),
    JSON.stringify(info, null, 2) + '\n'
  );
  return info;
}

const args = parseArgs(process.argv.slice(2));
const dict = JSON.parse(fs.readFileSync(path.join(HERE, 'zh-CN.json'), 'utf8'));
const report = { text: { hit: [] }, attrs: { hit: [] }, js: [], missing: [] };

const srcRoot = path.resolve(args.src);
const outRoot = path.resolve(args.out);
const infos = [];
for (const browser of args.browsers) {
  if (!BROWSERS.includes(browser)) {
    throw new Error(`未知浏览器: ${browser}`);
  }
  infos.push(
    buildBrowser(srcRoot, path.join(outRoot, browser), browser, dict, report)
  );
}

// 统计：哪些词典条目一条都没命中（上游多半改了文案）
const hitSet = new Set([...report.text.hit, ...report.attrs.hit]);
const staleText = Object.keys(dict.text).filter(k => !hitSet.has(k));
const hitJs = new Set(report.js.filter(r => r.count > 0).map(r => r.en));
const staleJs = Object.keys(dict.js).filter(k => !hitJs.has(k));

const missingUnique = [
  ...new Map(
    report.missing.map(m => [m.file + '\u0000' + m.text, m])
  ).values(),
];
const coverage = {
  ok: missingUnique.length === 0,
  translated: hitSet.size + hitJs.size,
  missingCount: missingUnique.length,
  missing: missingUnique.slice(0, 60),
  staleDictionary: [...new Set([...staleText, ...staleJs])],
  errors: report.errors || null,
  builds: infos,
};

if (args.report) {
  fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  fs.writeFileSync(path.resolve(args.report), JSON.stringify(coverage, null, 2));
}

console.log(
  `汉化完成：${args.browsers.join(' / ')} → ${outRoot}（命中 ${hitSet.size} 条 HTML 文案、${hitJs.size} 条 JS 文案）`
);
if (coverage.errors) {
  console.log(
    `报错翻译：接管 ${coverage.errors.sites} 个提示入口，${coverage.errors.exact} 条常见报错 + ${coverage.errors.rules} 条规则`
  );
}
if (missingUnique.length) {
  console.log(`⚠️  还有 ${missingUnique.length} 处英文未翻译：`);
  for (const m of missingUnique.slice(0, 30)) {
    console.log(`   - ${m.file}: ${m.text}`);
  }
}
if (coverage.staleDictionary.length) {
  console.log(`ℹ️  词典里有 ${coverage.staleDictionary.length} 条未命中（上游可能改了文案）：`);
  for (const s of coverage.staleDictionary.slice(0, 15)) console.log(`   - ${s}`);
}
if (args.strict && missingUnique.length) process.exit(2);
