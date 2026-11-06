/**
 * 读取并校验 `.cw/project.toml`（与 pi 版共用，校验规则一致）和可选的宿主文件
 * `.cw/codex.toml`、`.cw/claude.toml`、`.cw/opencode.toml`、`.cw/kimi.toml` 或 `.cw/hermes.toml`（各自的模型；Codex 另有沙箱）。
 * `project.toml` 的 `[models]` 在所有宿主下都忽略。文件和每个小节都可选。解析或校验失败一律抛错，不返回半套配置。
 * 旧的 `[explorer]`、`[observe]` 是未知字段，会让整份配置失败，检查和保护一起停。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { isNotFound, relativeParts } from "./paths.js";
import { rejectUnknown } from "./schema.js";

/** 结束检查：`cmd` 按 argv 直接 spawn，不经 shell。 */
export interface CheckConfig {
  cmd: string[];
  timeout_s: number;
  env: Record<string, string>;
}

/**
 * 配置的 JSON Schema，直接写字面量而不用 `Type` 构造器：OMP 把 `typebox` 换成自己的 shim，
 * shim 会丢掉 `pattern`，导致 `provider/model` 的校验静默失效。
 * `provider/model`：第一个斜杠分开两边，model 里可以再有斜杠，两侧非空，不含空白。Pi 也是按第一个斜杠切的。
 *
 * The config as a literal JSON Schema, not `Type` builders: OMP swaps `typebox` for a shim
 * that drops `pattern`, which silently disables the `provider/model` check.
 */
const ModelName = { type: "string", minLength: 1, pattern: "^[^/\\s]+/[^\\s]+$" };

/** Codex 模型 slug、Claude Code 别名或完整 id：非空且不含空白。 */
const PlainModel = { type: "string", minLength: 1, pattern: "^[^\\s]+$" };

const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { const: 1 },
    check: {
      type: "object",
      additionalProperties: false,
      required: ["cmd"],
      properties: {
        cmd: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        timeout_s: { type: "integer", minimum: 1 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    protect: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: { paths: { type: "array", items: { type: "string", minLength: 1 } } },
    },
    router: {
      type: "object",
      additionalProperties: false,
      required: ["url", "model"],
      properties: {
        url: { type: "string", pattern: "^https?://[^\\s]+$" },
        api_key_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        model: { type: "string", minLength: 1 },
        timeout_ms: { type: "integer", minimum: 1 },
        skip_below: { type: "number", minimum: 0, maximum: 1 },
        audit_rate: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    models: {
      type: "object",
      additionalProperties: false,
      properties: {
        explorer: ModelName,
        review: ModelName,
        over_review: ModelName,
        research: ModelName,
        historian: ModelName,
        planner: ModelName,
      },
    },
    timeouts: {
      type: "object",
      additionalProperties: false,
      properties: {
        explorer: { type: "integer", minimum: 300, maximum: 1800 },
        review: { type: "integer", minimum: 300, maximum: 1800 },
        over_review: { type: "integer", minimum: 300, maximum: 1800 },
        research: { type: "integer", minimum: 300, maximum: 1800 },
        historian: { type: "integer", minimum: 300, maximum: 1800 },
        planner: { type: "integer", minimum: 300, maximum: 1800 },
      },
    },
    auto: {
      type: "object",
      additionalProperties: false,
      properties: {
        review: { type: "boolean" },
        chronicle: { type: "boolean" },
        pause: { type: "boolean" },
      },
    },
  },
};

const DEFAULT_TIMEOUT_S = 600;

type RoleKey = "explorer" | "review" | "over_review" | "research" | "historian" | "planner";

export interface RouterConfig {
  url: string;
  api_key_env: string | null;
  model: string;
  timeout_ms: number;
  skip_below: number;
  audit_rate: number;
}

const roleModels = (model: object) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    explorer: model, review: model, over_review: model, research: model, historian: model, planner: model,
  },
});

/** 五个宿主文件 schema 相同，`[roles] sandbox` 只有 Codex 接受；OpenCode 的模型是 `provider/model`。 */
const hostSchemas = {
  "codex.toml": {
    type: "object",
    additionalProperties: false,
    properties: {
      models: roleModels(PlainModel),
      roles: {
        type: "object",
        additionalProperties: false,
        properties: { sandbox: { enum: ["read-only", "none"] } },
      },
    },
  },
  "claude.toml": {
    type: "object", additionalProperties: false, properties: { models: roleModels(PlainModel) },
  },
  "opencode.toml": {
    type: "object", additionalProperties: false, properties: { models: roleModels(ModelName) },
  },
  // Kimi Code 的模型是 config.toml 里的别名；Hermes 是 `provider/model`，没有斜杠时只传模型名。两者都不含空白。
  "kimi.toml": {
    type: "object", additionalProperties: false, properties: { models: roleModels(PlainModel) },
  },
  "hermes.toml": {
    type: "object", additionalProperties: false, properties: { models: roleModels(PlainModel) },
  },
};

export type HostFile = keyof typeof hostSchemas;

export interface ProjectConfig {
  version: 1;
  /** 结束检查；未配置时为 null。 */
  check: CheckConfig | null;
  /** 受保护路径，仓库内相对路径或目录前缀。 */
  protect: { paths: string[] };
  /** 六个角色的模型，来自宿主文件；没配为 null。 */
  models: Record<RoleKey, string | null>;
  /** 各角色在调用方没传 `timeout_s` 时的超时（秒）。 */
  timeouts: Partial<Record<RoleKey, number>>;
  /** 实际生效的 `[auto]`：打开但缺模型的项视为关闭。 */
  auto: { review: boolean; chronicle: boolean; pause: boolean };
  /** 打开了但因缺模型被关闭的 `[auto]` 项，用于提示。 */
  autoSkipped: string[];
  router: RouterConfig | null;
  /** 角色子进程的沙箱。 */
  sandbox: "read-only" | "none";
}

/** project.toml 不存在返回 null，即使宿主文件存在。宿主文件可以缺。任一存在但不可读或非法时抛错。 */
export async function loadProjectConfig(repo: string, hostFile: HostFile): Promise<ProjectConfig | null> {
  const project = await readOptional(repo, "project.toml");
  const host = await readOptional(repo, hostFile);
  if (project === null) return null;
  return parseProjectConfig(project, host ?? "", hostFile);
}

async function readOptional(repo: string, name: string): Promise<string | null> {
  try {
    return await readFile(path.join(repo, ".cw", name), "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`${name}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

export function parseProjectConfig(text: string, hostText = "", hostFile: HostFile = "codex.toml"): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unparsable"}`);
  }
  rejectUnknown(projectSchema, parsed, "project.toml");
  let hostParsed: unknown;
  try {
    hostParsed = parse(hostText);
  } catch (error) {
    throw new Error(`${hostFile}: ${error instanceof Error ? error.message : "unparsable"}`);
  }
  rejectUnknown(hostSchemas[hostFile], hostParsed, hostFile);
  const value = parsed as {
    check?: { cmd: string[]; timeout_s?: number; env?: Record<string, string> };
    protect?: { paths: string[] };
    router?: {
      url: string; api_key_env?: string; model: string;
      timeout_ms?: number; skip_below?: number; audit_rate?: number;
    };
    timeouts?: Partial<Record<RoleKey, number>>;
    auto?: { review?: boolean; chronicle?: boolean; pause?: boolean };
  };
  const host = hostParsed as {
    models?: Partial<Record<RoleKey, string>>;
    roles?: { sandbox?: "read-only" | "none" };
  };
  const models = {
    explorer: host.models?.explorer ?? null,
    review: host.models?.review ?? null,
    over_review: host.models?.over_review ?? null,
    research: host.models?.research ?? null,
    historian: host.models?.historian ?? null,
    planner: host.models?.planner ?? null,
  };
  // 与 pi 版不同：[auto] 缺模型不算配置错误，该项视为关闭，否则共用文件里合法的 [auto] 会让检查和保护一起停。
  const wants = { review: false, chronicle: false, pause: false, ...value.auto };
  const auto = {
    review: wants.review && models.review !== null && models.over_review !== null,
    chronicle: wants.chronicle && models.historian !== null,
    pause: wants.pause && models.planner !== null,
  };
  const autoSkipped = (["review", "chronicle", "pause"] as const).filter((key) => wants[key] && !auto[key]);
  return {
    version: 1,
    check: value.check === undefined ? null : {
      cmd: value.check.cmd,
      timeout_s: value.check.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.check.env ?? {},
    },
    protect: { paths: (value.protect?.paths ?? []).map(normalizeProtectedPath) },
    models,
    timeouts: { ...value.timeouts },
    auto,
    autoSkipped,
    router: value.router === undefined ? null : {
      url: value.router.url,
      api_key_env: value.router.api_key_env ?? null,
      model: value.router.model,
      timeout_ms: value.router.timeout_ms ?? 5000,
      skip_below: value.router.skip_below ?? 0.1,
      audit_rate: value.router.audit_rate ?? 0.1,
    },
    sandbox: host.roles?.sandbox ?? "read-only",
  };
}

/** 去掉 `./` 和结尾 `/`。拒绝空路径、通配符、绝对路径、`..` 和 `.cw` 下的路径。 */
function normalizeProtectedPath(value: string): string {
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "") throw new Error(`project.toml: protect.paths 为空路径 ${value}`);
  if (normalized.includes("*")) throw new Error(`project.toml: protect.paths 不支持通配符 ${value}`);
  try {
    relativeParts(normalized);
  } catch (error) {
    throw new Error(`project.toml: protect.paths 非法路径 ${value}（${
      error instanceof Error ? error.message : "无效"}）`);
  }
  if (normalized === ".cw" || normalized.startsWith(".cw/")) {
    throw new Error(`project.toml: protect.paths 不接受 .cw 下的路径 ${value}`);
  }
  return normalized;
}
