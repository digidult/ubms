import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function gitRevision() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

/**
 * The production build is ONE self-contained HTML file (scripts, styles, icons and translations
 * inlined) that works offline from disk, from any static host, and later inside a Tauri webview.
 * Set UBMS_MULTIFILE=1 to get a regular multi-file build (useful for debugging bundle size).
 */
export default defineConfig(({ command }) => ({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REVISION__: JSON.stringify(command === 'build' ? gitRevision() : 'dev'),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: process.env.UBMS_MULTIFILE ? [] : [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: '../../dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: {
    host: 'localhost',
    port: 5173,
  },
}));
