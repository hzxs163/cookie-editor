/**
 * 心跳：决定这次要不要给 localize/state.json 留一次提交。
 * 公共仓库连续 60 天没有活动，GitHub 会自动停用定时工作流，
 * 所以即便上游没更新，也每 7 天提交一次（只改 zh-state 分支）。
 * 输出 1 表示已更新、需要提交；0 表示跳过。
 */
import fs from 'node:fs';

const file = new URL('./state.json', import.meta.url);
if (!fs.existsSync(file)) {
  console.log('0');
  process.exit(0);
}

const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const last = state.heartbeatAt ? Date.parse(state.heartbeatAt) : 0;
const days = (Date.now() - last) / 86400000;

if (!state.released && days < 7) {
  console.log('0');
  process.exit(0);
}

state.heartbeatAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
console.log('1');
