#!/usr/bin/env node
/**
 * 每日上游同步流水线的入口（在 GitHub Actions 里跑，也可以本地跑构建）。
 *
 * 完整流程:
 *   1. 查 Moustachauve/cookie-editor 最新提交
 *   2. 如果这个提交已经发过 Release 就直接退出
 *   3. 下载该提交的源码 → 用 localize.mjs 汉化
 *   4. 打包 zip → 建 Release 并上传资产
 *   5. 写 localize/state.json（给工作流做心跳提交）
 *
 * 本地只构建不发布:
 *   node localize/ci.mjs --build-only --src . --out dist
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.UPSTREAM_REPO || 'Moustachauve/cookie-editor';
const REPO = process.env.GITHUB_REPOSITORY || 'hzxs163/cookie-editor';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const buildOnly = flag('--build-only');
const force = flag('--force');
const wantZip = !flag('--no-zip');
const srcDir = path.resolve(value('--src', '.'));
const outDir = path.resolve(value('--out', 'dist'));
const log = (...a) => console.log(...a);

/**
 * 网络容易抖（raw.githubusercontent 偶发 503），统一加退避重试。
 * @param {string} label
 * @param {Function} fn
 * @param {number} [attempts]
 * @return {Promise<any>}
 */
async function withRetry(label, fn, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      const wait = 2000 * (i + 1);
      log(
        `⚠️  ${label} 失败（${String(error.message).slice(0, 120)}），${wait / 1000}s 后重试`
      );
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/**
 * 调 GitHub REST API。
 * @param {string} method
 * @param {string} apiPath 以 / 开头的路径。
 * @param {object} [body] JSON 请求体。
 * @return {Promise<any>}
 */
async function gh(method, apiPath, body) {
  return withRetry(`${method} ${apiPath}`, async () => {
    const res = await fetch(`${API}${apiPath}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'User-Agent': 'cookie-editor-zh-sync',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(
        `${method} ${apiPath} → ${res.status} ${text.slice(0, 300)}`
      );
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return {};
    return res.json();
  });
}

/**
 * 取纯文本（raw.githubusercontent.com 不需要鉴权）。
 * @param {string} url
 * @return {Promise<string>}
 */
async function raw(url) {
  return withRetry(`GET ${url}`, async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cookie-editor-zh-sync' },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
  });
}

/**
 * 读上游某个提交的 package.json：先走 raw，失败再退回 API。
 * @param {string} sha
 * @return {Promise<object>}
 */
async function upstreamPackage(sha) {
  try {
    return JSON.parse(
      await raw(
        `https://raw.githubusercontent.com/${UPSTREAM}/${sha}/package.json`
      )
    );
  } catch (error) {
    log(`⚠️  raw 读取 package.json 失败，改用 API：${error.message}`);
    const file = await gh(
      'GET',
      `/repos/${UPSTREAM}/contents/package.json?ref=${sha}`
    );
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }
}

/**
 * 下载文件到本地。
 * @param {string} url
 * @param {string} file
 */
async function download(url, file) {
  await withRetry(`GET ${url}`, async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cookie-editor-zh-sync' },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  });
}

/**
 * 生成 zip；没有 zip 命令时返回 null。
 * @param {string} dir
 * @param {string} zipFile
 * @return {string|null}
 */
function zipDir(dir, zipFile) {
  fs.rmSync(zipFile, { force: true });
  const r = spawnSync('zip', ['-q', '-r', zipFile, '.'], { cwd: dir });
  if (r.error) {
    log(`⚠️  没有 zip 命令，跳过 ${path.basename(zipFile)}`);
    return null;
  }
  if (r.status !== 0) throw new Error(`zip 失败: ${r.stderr}`);
  return zipFile;
}

/**
 * 调 localize.mjs 生成各浏览器目录。
 * @param {string} src
 * @param {string} out
 * @param {string} reportFile
 * @return {object} 覆盖率报告。
 */
function localize(src, out, reportFile) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(HERE, 'localize.mjs'),
      '--src',
      src,
      '--out',
      out,
      '--report',
      reportFile,
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error('汉化失败');
  return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
}

/**
 * 找出上一次汉化发版的上游 sha。
 * @return {Promise<string|null>}
 */
async function previousSha() {
  const releases = await gh('GET', `/repos/${REPO}/releases?per_page=40`);
  if (!releases) return null;
  for (const rel of releases) {
    const m = /-([0-9a-f]{7,40})$/.exec(rel.tag_name || '');
    if (m && (rel.tag_name || '').startsWith('zh-v')) return m[1];
  }
  return null;
}

/**
 * 生成 Release 说明。
 * @param {object} params
 * @return {Promise<string>}
 */
async function buildNotes({ commit, version, sha, coverage, prevSha, assets }) {
  const lines = [];
  lines.push('### Cookie-Editor 简体中文汉化版（自动构建）');
  lines.push('');
  lines.push(`- 上游版本：\`${version}\``);
  lines.push(
    `- 上游提交：[\`${sha.slice(0, 7)}\`](https://github.com/${UPSTREAM}/commit/${sha}) ${
      (commit.commit?.message || '').split('\n')[0]
    }`
  );
  lines.push(`- 构建时间：${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  lines.push(
    `- 汉化状态：已翻译 ${coverage.translated} 处界面文案${
      coverage.missingCount
        ? `，⚠️ 还有 ${coverage.missingCount} 处英文未翻译`
        : '，界面无遗漏'
    }`
  );

  if (prevSha && prevSha !== sha) {
    const cmp = await gh('GET', `/repos/${UPSTREAM}/compare/${prevSha}...${sha}`);
    const commits = (cmp?.commits || []).slice(-15).reverse();
    if (commits.length) {
      lines.push('');
      lines.push('### 上游本次变更');
      for (const c of commits) {
        const msg = (c.commit?.message || '').split('\n')[0].slice(0, 90);
        lines.push(`- \`${c.sha.slice(0, 7)}\` ${msg}`);
      }
    }
  }

  if (coverage.missingCount) {
    lines.push('');
    lines.push('### ⚠️ 未翻译的新文案（上游新增，等待补词典）');
    lines.push('```');
    for (const m of coverage.missing.slice(0, 20)) {
      lines.push(`${m.file}: ${m.text}`);
    }
    lines.push('```');
    lines.push('补法：在仓库 `localize/zh-CN.json` 的 `text` 里加一条 `"英文": "中文"`，下次运行即生效。');
  }

  lines.push('');
  lines.push('### 安装');
  lines.push('1. 下载对应浏览器的 zip 并解压到一个**固定目录**（不要放临时目录，删了扩展就没了）。');
  lines.push('2. Edge 打开 `edge://extensions`，Chrome 打开 `chrome://extensions`，右上角开启「开发人员模式」。');
  lines.push('3. 点「加载解压缩的扩展」，选择解压出来的文件夹。');
  lines.push('');
  lines.push('> 装过官方商店版的话，记得先停用官方版，否则两个图标容易搞混。');
  lines.push('');
  lines.push('### 文件');
  for (const a of assets) lines.push(`- \`${a}\``);

  return lines.join('\n');
}

/**
 * 写同步状态文件，供工作流做心跳提交。
 * @param {object} state
 */
function writeState(state) {
  const file = path.join(HERE, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  if (buildOnly) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-zh-'));
    const report = localize(srcDir, outDir, path.join(tmp, 'report.json'));
    if (wantZip) {
      for (const b of fs.readdirSync(outDir)) {
        const dir = path.join(outDir, b);
        if (fs.statSync(dir).isDirectory()) {
          zipDir(dir, path.join(outDir, `cookie-editor-zh-${b}.zip`));
        }
      }
    }
    log(
      `\n构建完成：${outDir}\n未翻译：${report.missingCount} 处\n词典里失效条目：${report.staleDictionary.length} 条`
    );
    return;
  }

  if (!TOKEN) throw new Error('缺少 GH_TOKEN / GITHUB_TOKEN');

  const commit = await gh('GET', `/repos/${UPSTREAM}/commits/master`);
  const sha = commit.sha;
  const pkg = await upstreamPackage(sha);
  const version = pkg.version;
  const tag = `zh-v${version}-${sha.slice(0, 7)}`;
  log(`上游 ${UPSTREAM} @ ${sha.slice(0, 7)}，版本 ${version}`);

  const existing = await gh('GET', `/repos/${REPO}/releases/tags/${tag}`);
  if (existing && !force) {
    log(`已存在 Release ${tag}，今天不用干活`);
    writeState({
      checkedAt: new Date().toISOString(),
      upstreamSha: sha,
      version,
      tag,
      released: false,
    });
    return;
  }
  if (existing && force) {
    log(`--force：删除已有 Release ${tag}`);
    await gh('DELETE', `/repos/${REPO}/releases/${existing.id}`);
    await gh('DELETE', `/repos/${REPO}/git/refs/tags/${tag}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-zh-'));
  const tarball = path.join(tmp, 'upstream.tar.gz');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src, { recursive: true });
  log('下载上游源码…');
  await download(
    `https://codeload.github.com/${UPSTREAM}/tar.gz/${sha}`,
    tarball
  );
  const untar = spawnSync('tar', [
    '-xzf',
    tarball,
    '-C',
    src,
    '--strip-components=1',
  ]);
  if (untar.status !== 0) throw new Error(`解压失败: ${untar.stderr}`);

  process.env.UPSTREAM_SHA = sha;
  const report = localize(src, path.join(tmp, 'build'), path.join(tmp, 'report.json'));

  const assets = [];
  for (const browser of fs.readdirSync(path.join(tmp, 'build'))) {
    const dir = path.join(tmp, 'build', browser);
    if (!fs.statSync(dir).isDirectory()) continue;
    const name = `cookie-editor-zh-${version}-${browser}.zip`;
    if (zipDir(dir, path.join(tmp, name))) assets.push(name);
  }
  const sums = assets
    .map(n => {
      const h = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(tmp, n)))
        .digest('hex');
      return `${h}  ${n}`;
    })
    .join('\n');
  fs.writeFileSync(path.join(tmp, 'SHA256SUMS.txt'), sums + '\n');
  assets.push('SHA256SUMS.txt');

  const prevSha = await previousSha();
  const body = await buildNotes({
    commit,
    version,
    sha,
    coverage: report,
    prevSha,
    assets,
  });

  log(`创建 Release ${tag}…`);
  const release = await gh('POST', `/repos/${REPO}/releases`, {
    tag_name: tag,
    name: `汉化版 v${version}（${sha.slice(0, 7)}）`,
    body,
    draft: false,
    prerelease: false,
  });

  for (const name of assets) {
    const file = path.join(tmp, name);
    const buf = fs.readFileSync(file);
    await withRetry(`上传 ${name}`, async () => {
      const res = await fetch(
        `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(
          name
        )}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buf.length),
            'User-Agent': 'cookie-editor-zh-sync',
          },
          body: buf,
        }
      );
      if (!res.ok) {
        throw new Error(
          `上传 ${name} 失败: ${res.status} ${(await res.text()).slice(0, 200)}`
        );
      }
    });
    log(`已上传 ${name}`);
  }

  writeState({
    checkedAt: new Date().toISOString(),
    upstreamSha: sha,
    version,
    tag,
    released: true,
  });
  log(`\n完成：https://github.com/${REPO}/releases/tag/${tag}`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
