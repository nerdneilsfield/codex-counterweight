/**
 * 读取并校验 `.cw/project.toml`。校验规则与 pi 版一致；`[models]`、`[timeouts]`、`[auto]`、`[router]` 接受但第一版不使用。
 * 文件和每个小节都可选。解析或校验失败一律抛错，不返回半套配置。
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

export interface ProjectConfig {
  version: 1;
  /** 结束检查；未配置时为 null。 */
  check: CheckConfig | null;
  /** 受保护路径，仓库内相对路径或目录前缀。 */
  protect: { paths: string[] };
  /** `[auto]` 有任何一项打开；第一版不实现，只用来提示。 */
  autoRequested: boolean;
}

/** 文件不存在返回 null。存在但不可读或非法时抛错。 */
export async function loadProjectConfig(repo: string): Promise<ProjectConfig | null> {
  let text: string;
  try {
    text = await readFile(path.join(repo, ".cw", "project.toml"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  return parseProjectConfig(text);
}

export function parseProjectConfig(text: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unparsable"}`);
  }
  rejectUnknown(projectSchema, parsed, "project.toml");
  const value = parsed as {
    check?: { cmd: string[]; timeout_s?: number; env?: Record<string, string> };
    protect?: { paths: string[] };
    auto?: { review?: boolean; chronicle?: boolean; pause?: boolean };
  };
  return {
    version: 1,
    check: value.check === undefined ? null : {
      cmd: value.check.cmd,
      timeout_s: value.check.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.check.env ?? {},
    },
    protect: { paths: (value.protect?.paths ?? []).map(normalizeProtectedPath) },
    autoRequested: Object.values(value.auto ?? {}).some((flag) => flag === true),
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
