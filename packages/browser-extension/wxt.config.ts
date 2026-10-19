import { defineConfig } from "wxt";
import { browserBuildTarget } from "./scripts/build-target.ts";

const target = browserBuildTarget(process.env["OBRIGADO_BROWSER_E2E_ORIGIN"]);

export default defineConfig({
  imports: false,
  outDir: target.outDir,
  vite: () => ({
    define: { "import.meta.env.VITE_OBRIGADO_API_ORIGIN": JSON.stringify(target.origin) },
  }),
  manifest: {
    name: "Obrigado",
    description:
      "A sponsored status line beside AI chats. 70% of gross revenue funds open source maintainer grants.",
    permissions: ["storage", "alarms"],
    host_permissions: [target.permission],
    action: { default_title: "Obrigado" },
    icons: { 128: "icon.png" },
    minimum_chrome_version: "123",
  },
});
