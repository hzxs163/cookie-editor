/**
 * 心跳：决定这次要不要在 zh-state 分支留一次提交。
 *
 * 公共仓库连续 60 天没有活动，GitHub 会自动停用定时工作流，所以即使上游没更新，
 * 也每 7 天留一次心跳提交。用法：
 *
 *   node localize/heartbeat.mjs "<上一次心跳的 ISO 时间，没有就留空>"
 *
 * 输出 1 表示已写入 localize/heartbeat.json、需要提交；0 表示跳过。
 */
import fs from 'node:fs';

const lastHeartbeat = process.argv[2] || '';
const stateFile = new URL('./state.json', import.meta.url);

let released = false;
if (fs.existsSync(stateFile)) {
  released = JSON.parse(fs.readFileSync(stateFile, 'utf8')).released === true;
}

const days = lastHeartbeat
  ? (Date.now() - Date.parse(lastHeartbeat)) / 86400000
  : Infinity;

if (!released && days < 7) {
  console.log('0');
  process.exit(0);
}

fs.writeFileSync(
  new URL('./heartbeat.json', import.meta.url),
  JSON.stringify({ at: new Date().toISOString() }, null, 2) + '\n'
);
console.log('1');
