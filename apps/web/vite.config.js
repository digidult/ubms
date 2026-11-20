import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** @param {string} cmd */
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Commit of the build: the full hash for links, the short one for display. A build from a working
 * tree with uncommitted changes to tracked files gets a "-dirty" suffix, so a build always tells
 * whether it matches a commit.
 */
function buildCommit() {
  const full = process.env.GITHUB_SHA || git('rev-parse HEAD');
  if (!full) return { full: '', short: 'dev' };
  const dirty = !process.env.GITHUB_SHA && git('status --porcelain --untracked-files=no') !== '';
  return { full, short: `${full.slice(0, 7)}${dirty ? '-dirty' : ''}` };
}

const repoUrl = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');

/**
 * Next to dist/index.html (what static hosts such as Vercel and the desktop app serve) the build
 * writes the same file as dist/ubms.html, the name used for downloads and releases.
 */
const appFileCopy = {
  name: 'ubms-app-file-copy',
  apply: /** @type {'build'} */ ('build'),
  enforce: /** @type {'post'} */ ('post'),
  closeBundle() {
    const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
    if (existsSync(`${dist}index.html`)) copyFileSync(`${dist}index.html`, `${dist}ubms.html`);
  },
};

/**
 * The production build is ONE self-contained HTML file, dist/index.html, copied to
 * dist/ubms.html (scripts, styles, icons and translations inlined), that works offline from disk,
 * from any static host and inside the Tauri webview. Set UBMS_MULTIFILE=1 to get a regular multi-file build (useful for debugging
 * bundle size).
 */
export default defineConfig(({ command }) => {
  const commit = command === 'build' ? buildCommit() : { full: '', short: 'dev' };
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_REVISION__: JSON.stringify(commit.short),
      __APP_COMMIT__: JSON.stringify(commit.full),
      __APP_REPOSITORY__: JSON.stringify(repoUrl),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    },
    plugins: [...(process.env.UBMS_MULTIFILE ? [] : [viteSingleFile({ removeViteModuleLoader: true })]), appFileCopy],
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
  };
});
