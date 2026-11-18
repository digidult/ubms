import { css, unsafeCSS } from 'lit';

/**
 * Design tokens as CSS custom properties. They are declared on :root (document level), so they
 * pass into every shadow root. Light and dark palettes; `data-theme` on <html> forces one,
 * otherwise the OS preference decides.
 */
const LIGHT = `
  --ui-bg: #f3f5f8;
  --ui-surface: #ffffff;
  --ui-surface-2: #eef1f5;
  --ui-surface-3: #e3e8ef;
  --ui-border: #d9dfe7;
  --ui-text: #18202b;
  --ui-text-muted: #5b6878;
  --ui-text-faint: #8a96a5;
  --ui-primary: #1f6feb;
  --ui-primary-soft: #dbe8fd;
  --ui-on-primary: #ffffff;
  --ui-ok: #16834a;
  --ui-ok-soft: #dcf3e5;
  --ui-warn: #b26a00;
  --ui-warn-soft: #fdf0d5;
  --ui-danger: #c62f3b;
  --ui-danger-soft: #fbe1e3;
  --ui-info: #0a7ea4;
  --ui-info-soft: #d9f0f7;
  --ui-charge: #16834a;
  --ui-discharge: #d0611a;
  --ui-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
  --ui-scrim: rgba(15, 20, 30, 0.45);
  color-scheme: light;
`;

const DARK = `
  --ui-bg: #0e1116;
  --ui-surface: #161b22;
  --ui-surface-2: #1c232d;
  --ui-surface-3: #252e3a;
  --ui-border: #2c3644;
  --ui-text: #e6ebf1;
  --ui-text-muted: #9aa7b6;
  --ui-text-faint: #6b7787;
  --ui-primary: #4c8dff;
  --ui-primary-soft: #19305a;
  --ui-on-primary: #ffffff;
  --ui-ok: #3fbf74;
  --ui-ok-soft: #133524;
  --ui-warn: #e9a23b;
  --ui-warn-soft: #3a2a10;
  --ui-danger: #f0636f;
  --ui-danger-soft: #3f1a1f;
  --ui-info: #38b6dc;
  --ui-info-soft: #0f2f3b;
  --ui-charge: #3fbf74;
  --ui-discharge: #f08a43;
  --ui-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  --ui-scrim: rgba(0, 0, 0, 0.6);
  color-scheme: dark;
`;

const COMMON = `
  --ui-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif;
  --ui-mono: ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
  --ui-radius: 14px;
  --ui-radius-sm: 9px;
  --ui-gap: 12px;
  --ui-pad: 16px;
  --ui-nav-height: 64px;
  --ui-header-height: 56px;
  --ui-rail-width: 232px;
  --ui-touch: 44px;
`;

/** Global (document level) stylesheet: tokens, base element styles, scrollbar and selection. */
export const globalCss = `
:root { ${COMMON} ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
:root[data-theme="dark"] { ${DARK} }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--ui-bg);
  color: var(--ui-text);
  font-family: var(--ui-font);
  font-size: 15px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior-y: none;
}
::selection { background: var(--ui-primary-soft); }
`;

/** Inject the global stylesheet once. */
export function applyGlobalStyles() {
  if (typeof document === 'undefined' || document.getElementById('ui-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'ui-global-styles';
  style.textContent = globalCss;
  document.head.append(style);
}

/**
 * Apply a theme preference.
 * @param {'auto'|'light'|'dark'} mode
 */
export function applyTheme(mode) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0e1116' : '#f3f5f8');
  }
}

/**
 * Shared component styles: typography helpers, buttons, inputs, cards, chips.
 * Components include it in `static styles`.
 */
export const sharedStyles = css`
  :host {
    font-family: var(--ui-font);
    color: var(--ui-text);
  }
  [hidden] {
    display: none !important;
  }
  .muted {
    color: var(--ui-text-muted);
  }
  .faint {
    color: var(--ui-text-faint);
  }
  .mono {
    font-family: var(--ui-mono);
    font-variant-numeric: tabular-nums;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .card {
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    box-shadow: var(--ui-shadow);
  }
  h1,
  h2,
  h3 {
    margin: 0;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: 1.05rem;
  }
  h3 {
    font-size: 0.95rem;
  }
  button {
    font: inherit;
  }
  .btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: var(--ui-touch);
    padding: 0 16px;
    border-radius: var(--ui-radius-sm);
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--ui-text);
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    user-select: none;
  }
  .btn:hover {
    background: var(--ui-surface-2);
  }
  .btn:focus-visible,
  .input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 2px;
  }
  .btn[disabled] {
    opacity: 0.5;
    cursor: default;
  }
  .btn.primary {
    background: var(--ui-primary);
    border-color: var(--ui-primary);
    color: var(--ui-on-primary);
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.danger {
    color: var(--ui-danger);
  }
  .btn.danger.solid {
    background: var(--ui-danger);
    border-color: var(--ui-danger);
    color: #fff;
  }
  .btn.ghost {
    background: transparent;
    border-color: transparent;
  }
  .btn.ghost:hover {
    background: var(--ui-surface-2);
  }
  .btn.small {
    min-height: 34px;
    padding: 0 12px;
    font-size: 0.9rem;
  }
  .btn.icon {
    padding: 0;
    width: var(--ui-touch);
  }
  .input,
  select {
    appearance: none;
    font: inherit;
    min-height: var(--ui-touch);
    padding: 0 12px;
    border-radius: var(--ui-radius-sm);
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--ui-text);
    width: 100%;
  }
  select {
    padding-right: 32px;
    background-image: linear-gradient(45deg, transparent 50%, var(--ui-text-muted) 50%),
      linear-gradient(135deg, var(--ui-text-muted) 50%, transparent 50%);
    background-position: calc(100% - 18px) 55%, calc(100% - 13px) 55%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    background: var(--ui-surface-2);
    color: var(--ui-text-muted);
    white-space: nowrap;
  }
  .chip.ok {
    background: var(--ui-ok-soft);
    color: var(--ui-ok);
  }
  .chip.warn {
    background: var(--ui-warn-soft);
    color: var(--ui-warn);
  }
  .chip.danger {
    background: var(--ui-danger-soft);
    color: var(--ui-danger);
  }
  .chip.info {
    background: var(--ui-info-soft);
    color: var(--ui-info);
  }
  .chip.primary {
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
  }
  .section-title {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
    margin: 18px 4px 8px;
  }
`;

export { unsafeCSS };
