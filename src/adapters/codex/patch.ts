const PATH_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** apply_patch 补丁文本里所有被改动的路径，去重。 */
export function patchPaths(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const match = PATH_LINE.exec(line.replace(/\r$/, ""));
    if (match !== null && match[1]!.trim() !== "") found.add(match[1]!.trim());
  }
  return [...found];
}
