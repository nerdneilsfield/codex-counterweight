# 多仓库工作区支持

Plan readiness: ready。

## 结果和范围

在工作区 A 里（`A/B`、`A/C`、`A/D`）以 B 为主仓库工作，需要改 C、D 时，保护、范围、回合基线、审查、结束检查都覆盖 C、D。五个宿主（Codex、Claude Code、OpenCode、Kimi、Hermes）在本仓库实现，`pi-counterweight` 同步实现。

现状（已读代码确认）：仓库外路径在 `toRepoRelative` 返回 null，保护检查跳过；PAUSE 不触发；范围锁定生效时仓库外一律拒绝；基线、diff、结束检查只看 B。

不包括：把 C、D 自动发现为仓库；bash 里的写入（和现状一样不拦）；多个主仓库同时有 `[check]` 的修复额度拆分（全体共用一次修复）。

授权：已授权实现和本地提交，推送等验收。

## 设计

### `.cw/repos.txt`

主仓库 `.cw/repos.txt`，每行一个路径，相对主仓库根或绝对路径，`#` 开头和空行忽略。不在 `project.toml` 里加字段（schema 是 `additionalProperties:false` 且要和 pi 兼容）。没有文件、没有有效行时，所有行为和现在完全一致。

新文件 `src/core/repos.ts`，两个仓库字节一致，纯函数，不引用宿主，加入 `check:sync`：

- `readRepos(root): Promise<string[]>`：解析并 `realpath`；不存在、不是目录、没有 `.git`、等于主仓库、嵌套在主仓库内的条目丢弃；去重。
- `ownerOf(root, extras, absolute): { repo: string; relative: string } | null`：先 `realpath` 目标（目标不存在时 realpath 最深的已有祖先再拼剩余段），属于哪个仓库就返回该仓库根和相对路径（`/` 分隔）；都不属于返回 null。主仓库优先。
- `REPOS_FILE = ".cw/repos.txt"`。

`.cw/repos.txt` 加入始终保护的文件（和 `goal.md`、`scope.txt` 同级，包括没有 `project.toml` 时的最小保护）：它扩大模型的写入范围，模型不能自己改。

### 保护、范围

`checkPaths`、`checkGoalPaths`、`checkScopePaths`（`src/core/flow.ts`）签名不变。每个原始路径先 `ownerOf`：

- 属于主仓库：和现在一样。
- 属于额外仓库 X：用 X 的根和 X 的配置判断。`checkPaths` 用 X 的 `loadProject(X)`（没有配置就只做 goal/scope 最小保护）。`checkGoalPaths` 用 X 的 `.cw/goal.md`、`scope.txt`、`repos.txt` 的最小保护。`checkScopePaths` 读 X 的 `scope.txt`，不是主仓库的。X 没有 `scope.txt` 就不限制。
- 都不属于：保护检查跳过（现状）；范围锁定生效时仍然拒绝（现状）。

主仓库的 `scope.txt` 只管主仓库内的路径；额外仓库的范围由它自己的 `scope.txt` 管。额外仓库内的 `.cw/` 下写入同样受 X 的受保护列表管。

`pausePlan`：目标路径用 `ownerOf` 解析，额外仓库里的源码编辑也算首次改源码；目标在 planner 消息里带仓库名前缀（额外仓库的用仓库目录名，如 `C/src/a.ts`）。

### 回合基线、审查

`auto.ts` 里的 `snapshotTree(root)` 签名不变，内部读 `readRepos(root)`：没有额外仓库时返回单个树哈希（和现在字节一致）；有时返回 JSON 字符串 `{"<abs repo>":"<tree>",…}`，主仓库也是其中一项。存储（`saveBase`/`loadBase`）按字符串存，不用改。`workingDiff(root, base)`、`changedFiles(root, base)` 识别 JSON 基线，对每个仓库用各自的树算 diff，合并输出：额外仓库的 diff 前加一行 `# repo: <目录名>`，文件名前加 `<目录名>/`。单仓库路径不变。某个仓库快照失败就跳过该仓库，不影响其他。

### 结束检查

`endCheck` 把检查部分改成对「有改动的仓库」循环：主仓库照旧（有 `[check]` 就跑）；额外仓库 X 若相对其基线有改动，且 `loadProject(X)` 有 `[check]`，就在 X 里跑它自己的检查。规则：

- 所有仓库的结果合在一起：全部通过才算通过。报告每段前标仓库名（只在有额外仓库参与时标）。
- 修复额度全回合共用一次（`claim("repair")`）；任何一个失败且领到额度就把所有失败报告合并续跑。
- `settled.outcome`：任何失败为 `failed`，否则按现有规则；`evidence.text` 是合并后的报告。
- 有改动的判定：基线 JSON 中该仓库的树与当前工作树不同。取不到基线时不跑额外仓库的检查。
- meter 事件仍写主仓库，`check` 事件的 `detail` 增加 `repo` 字段（额外仓库的目录名；主仓库不写，保持兼容）。
- 额外仓库的 `[check]` 超时同样受 `MAX_CHECK_TIMEOUT_S` 和宿主 `limits` 约束；检查总耗时仍受宿主 hook 预算限制，超出预算的额外仓库检查记 `gap` 并在报告里说明。

pending、chronicle、meter、目标注入、danger 仍只属于主仓库。chronicle 报告里的文件清单包含额外仓库的文件（带目录名前缀）。

### 宿主

`flow.ts`/`auto.ts` 内部实现，签名不变，所以五个宿主的适配器基本不改。适配器需要核对的只有：写工具路径传入的是绝对路径或相对 cwd 的路径（已是 `cwd` + `paths`）；Hermes、Kimi 的 hook 在子进程里按主仓库根运行，不变。

### pi

pi 没有 `flow.ts`，保护、范围、基线、结束检查在 `src/adapters/pi/index.ts` 和 `src/core/{protect,scope,auto,check,pause,gitstate}.ts`。在 pi 里用同一个 `repos.ts`（字节一致）实现同样的语义。pi 不加任何新依赖。

## 验收

每个仓库：`tsc`、全部测试、`check:sync`（含 `repos.ts`）通过。新测试用临时目录里的三个真实 git 仓库 A/B、A/C、A/D，不依赖宿主：

- 没有 `repos.txt` 时，保护、范围、基线、diff 行为与旧行为一致（现有测试全部不改仍通过）。
- 写 C 的受保护路径被拒绝（用 C 自己的 `project.toml`）；写 C 的普通文件放行；C 有 `scope.txt` 时范围外被拒绝。
- 经符号链接从 B 指向 C 的路径按 C 归属判断；`repos.txt` 条目是 `..`、嵌套在 B 内、不存在、不是 git 仓库时被丢弃。
- 改了 C 之后 `workingDiff` 含 `# repo: C` 段和 `C/` 前缀文件名，`changedFiles` 含 C 的文件；B、C 都没改时为空。
- C 有失败的 `[check]` 且 C 有改动：`endCheck` 续跑一次，报告带仓库名；C 没改动时不跑。
- 模型写 `.cw/repos.txt` 被拒绝，没有 `project.toml` 时也是。

真实宿主复验（由我在隔离的 HOME/配置下用最便宜模型做，不由实现者做）：Codex、Claude Code、OpenCode 各一次：B 为 cwd，让模型改 C 的受保护文件被拒绝；改 C 的普通文件后回合结束，C 的 `[check]` 运行，审查看到 C 的 diff。Kimi、Hermes 复跑测试，必要时各做一次真实运行。

## 进度

- [x] 1 本仓库：`repos.ts`、保护/范围/PAUSE、基线/diff、结束检查、测试、`check:sync`
- [ ] 2 pi：同步实现和测试
- [ ] 3 文档：两个 README（中英）、`/cw-setup` 提示
- [ ] 4 真实宿主复验
