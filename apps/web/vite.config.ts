import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Content Security Policy for the built SPA. Everything the app loads or calls
 * is same-origin. Added only to production builds: Vite's dev server injects
 * inline scripts that this policy would block. frame-ancestors cannot be set
 * from a <meta> tag, so it lives in the netlify.toml headers instead.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "issue-pipeline:csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ],
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],

  // The shared package ships TypeScript source, so let Vite compile it in the
  // graph rather than prebundling it as a dependency.
  optimizeDeps: {
    exclude: ["@issue-pipeline/shared"],
  },

  // In development `netlify dev` proxies this server and the functions onto one
  // origin (http://localhost:8888), so cookies and OAuth redirects behave as in
  // production. Open that URL, not Vite's own port.
  server: {
    port: 5173,
    strictPort: true,
  },
});
