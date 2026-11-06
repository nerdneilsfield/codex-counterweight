/**
 * 角色子进程的递归保护。宿主的 hook 和插件在子进程里无法都靠命令行关掉（Kimi Code 没有关 hook 的参数，
 * Hermes 的 gateway 不继承环境变量），所以 runner 给子进程设 `CW_ROLE=1`，hook 和 MCP 入口看到它就直接退出。
 * 这是产品机制：角色里不能再起角色，也不能再跑一遍检查。
 */
export const ROLE_ENV = "CW_ROLE";

/** 当前进程是不是某个角色子进程的后代。 */
export const inRole = (env: NodeJS.ProcessEnv = process.env): boolean => env[ROLE_ENV] === "1";

/** 角色子进程的环境：继承当前环境，再标上角色。 */
export const roleEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, [ROLE_ENV]: "1" });
