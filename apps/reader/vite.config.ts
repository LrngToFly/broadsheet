// The Broadsheet reader: a static PWA. GitHub Pages hosts only this code; your content stays in your
// OneDrive App Folder and is read in the browser after you sign in.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { existsSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import type { Plugin } from "vite";

// Development only: `vite` serves a copy of your edition from the gitignored local/reader-data folder at
// /__local/…, so the reader can be tried without signing in (open it with ?local). Never part of a build.
const localData = (): Plugin => ({
  name: "broadsheet-local-data",
  apply: "serve",
  configureServer(server) {
    const root = resolve(import.meta.dirname, "../../local/reader-data");
    server.middlewares.use((req, res, next) => {
      const m = req.url?.match(/\/__local\/([^?]+)/);
      if (!m) return next();
      const file = normalize(resolve(root, decodeURIComponent(m[1]!)));
      if (!file.startsWith(root) || !existsSync(file)) return ((res.statusCode = 404), res.end());
      res.end(readFileSync(file));
    });
  },
});

// Client ID: CI passes VITE_ENTRA_CLIENT_ID (a GitHub Actions variable); locally it comes from the
// gitignored local/config.local.json. It isn't a secret, but it stays out of the source code.
const localConfig = resolve(import.meta.dirname, "../../local/config.local.json");
const clientId = process.env.VITE_ENTRA_CLIENT_ID || (existsSync(localConfig) ? JSON.parse(readFileSync(localConfig, "utf8")).clientId : "");

export default defineConfig({
  root: import.meta.dirname,
  base: process.env.BASE_PATH ?? "/broadsheet/",
  define: { __CLIENT_ID__: JSON.stringify(clientId) },
  plugins: [
    react(),
    localData(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-180.png"],
      manifest: {
        name: "The Broadsheet",
        short_name: "Broadsheet",
        description: "Your private newspaper, made from your newsletters.",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f7f4ee",
        theme_color: "#1d2a44",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // The app shell is cached for offline use. The sign-in bridge page must always come from the
        // network, never be swapped for the app's index page.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/redirect\.html/],
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 800, // Microsoft sign-in and the schema checker are most of it
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), redirect: resolve(import.meta.dirname, "redirect.html") },
    },
  },
});
