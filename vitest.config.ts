import { defineConfig } from "vitest/config";

// 角色提示 md 在包里是 esbuild 的文本 loader；直接导入 src 的测试需要同样的处理。
export default defineConfig({
  plugins: [{
    name: "md-text",
    transform: (code, id) => id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null,
  }],
});
