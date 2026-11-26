// Phase 0 spike (c): Microsoft sign-in inside an iOS home-screen PWA, reading/writing the OneDrive App Folder.
import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Client ID: CI passes VITE_ENTRA_CLIENT_ID (a GitHub Actions variable); locally it comes from the
// gitignored local/config.local.json. It isn't a secret, but it stays out of the source code.
const localConfig = resolve(__dirname, "../../local/config.local.json");
const clientId =
  process.env.VITE_ENTRA_CLIENT_ID ||
  (existsSync(localConfig) ? JSON.parse(readFileSync(localConfig, "utf8")).clientId : "");

export default defineConfig({
  root: __dirname,
  base: process.env.BASE_PATH ?? "/broadsheet/",
  define: { __CLIENT_ID__: JSON.stringify(clientId) },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), redirect: resolve(__dirname, "redirect.html") },
    },
  },
});
