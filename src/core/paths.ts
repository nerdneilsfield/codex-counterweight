/**
 * 路径护栏：把外部输入解析成仓库内相对路径，并拒绝 `..`、绝对路径与符号链接逃逸。
 *
 * Path guardrails: external input is resolved to a repo-relative path that
 * stays inside the repository. `..` and absolute paths are rejected lexically,
 * never normalized away, and every symlink target is re-checked against the
 * repo root. Every failure throws — nothing here fails open.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * 仓库内相对路径的分段；`.`、`..` 与空段一律拒绝，而不是规范化掉。
 *
 * Repo-relative segments. `.`, `..`, and empty segments are rejected, not normalized away.
 */
export function relativeParts(value: string): string[] {
  if (value === "" || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`path: must be repo-relative ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`path: refuses . or .. segment ${value}`);
  }
  return parts;
}

/**
 * 判断 `candidate` 是否等于 `root` 或落在 `root` 之下；纯字符串运算，不访问文件系统。
 *
 * Whether `candidate` is `root` itself or lives below it. Purely lexical — both
 * arguments are expected to be absolute, already-realpathed paths, so callers
 * must resolve symlinks before asking.
 */
export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 解析写入目标在仓库内的真实相对路径。目标本身存在时走 `realpath`；目标缺失时从最近的现存祖先解析，
 * 这样 `alias -> tests` 下尚不存在的 `alias/new.ts` 仍落到 `tests/new.ts`，指向仓库外的目录链接同样拦得住。
 * 祖先不可解析、解析结果逃出仓库，或路径上没有任何现存节点时抛错。
 *
 * Real repo-relative path of a write target. An existing target uses `realpath`.
 * A missing target walks up to the nearest existing ancestor, so `alias/new.ts`
 * under `alias -> tests` still lands on `tests/new.ts`, and a directory link
 * pointing outside the repo is caught the same way. Throws when an ancestor
 * cannot be resolved, the result escapes the repo, or nothing on the path exists.
 */
export async function resolveWriteTarget(root: string, relative: string): Promise<string> {
  const parts = relativeParts(relative);
  const absolute = path.join(root, ...parts);
  let leaf;
  try {
    leaf = await lstat(absolute);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    leaf = null;
  }
  if (leaf !== null) {
    if (leaf.isSymbolicLink()) {
      try {
        return await containedRelative(root, absolute, relative);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`path: dangling symlink ${relative}`);
        throw error;
      }
    }
    return await containedRelative(root, absolute, relative);
  }
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const ancestor = path.join(root, ...parts.slice(0, length));
    let stat;
    try {
      stat = await lstat(ancestor);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      const realAncestor = await containedRelative(root, ancestor, relative);
      const rest = parts.slice(length);
      return realAncestor === "" ? rest.join("/") : [realAncestor, ...rest].join("/");
    }
    throw new Error(`path: write target is not a directory ${relative}`);
  }
  return relative;
}

/**
 * `candidate` 的 realpath 必须落在 `root` 内，返回仓库内相对路径。
 *
 * The realpath of `candidate` must stay inside `root`; returns the repo-relative form.
 */
async function containedRelative(root: string, candidate: string, label: string): Promise<string> {
  const target = await realpath(candidate);
  if (!pathInside(root, target)) throw new Error(`path: symlink escapes repository ${label}`);
  const relative = path.relative(root, target);
  return relative === "" ? "" : relative.split(path.sep).join("/");
}

/**
 * 解析成真实路径；目标不可解析时退回原值。调用方（适配层与工具）需要同一份把仓库根交给后续
 * 符号链接核对的口径。
 *
 * Realpath with a fallback to the raw value when it cannot be resolved. Callers
 * (the adapter and the tools) need one consistent repo-root value for the
 * later symlink containment checks.
 */
export async function realpathOr(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

/**
 * 判断抛出的值是否为 ENOENT 错误，让调用方把“文件不存在”与真正的 IO 失败区分开。
 *
 * Whether an unknown thrown value is an ENOENT error, so callers can tell a
 * missing file apart from a genuine I/O failure. ENOTDIR is not covered here;
 * callers that must treat it as missing check separately.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
