// 两个仓库共用的纯逻辑文件必须逐字节相同。../pi-counterweight 不存在时跳过。发布前手动运行，npm test 不调用。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = ["budget.ts", "danger.ts", "scope.ts", "chronicle-event.ts"];

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const other = path.resolve(here, "..", "pi-counterweight");
if (!existsSync(other)) {
  console.log(`check:sync 跳过：${other} 不存在`);
  process.exit(0);
}
const bad = SHARED.filter((name) => {
  const mine = path.join(here, "src/core", name);
  const theirs = path.join(other, "src/core", name);
  return !existsSync(mine) || !existsSync(theirs) || !readFileSync(mine).equals(readFileSync(theirs));
});
if (bad.length > 0) {
  console.error(`check:sync 失败：两个仓库的 src/core 下这些文件不一致或缺失：${bad.join(", ")}`);
  process.exit(1);
}
console.log(`check:sync 通过：${SHARED.length} 个文件逐字节相同`);
