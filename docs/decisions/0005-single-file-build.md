# 0005. Single self-contained HTML build and hash routing

Status: accepted, 2026-11-18

Note, 2026-11-22: two consequences below changed. The hosted build (https) has a web app
manifest and a network-first service worker (`apps/web/public/sw.js`, copied next to
`index.html` and registered only over https; a `file://` page is unchanged). The desktop plugin
loader imports each plugin from a Blob URL (`apps/web/src/plugins.js`), the one dynamic import;
it creates no extra build files.

## Context

The app must work without internet access, including on phones in a garage or on a boat, and be
easy to pass around. Web Bluetooth and Web Serial need a secure context; `file://` pages count as
secure in Chromium browsers.

## Decision

Vite with `vite-plugin-singlefile` produces `dist/index.html` with all JavaScript, CSS, icons
(inline SVG) and translations inlined. No external fonts or CDNs; the system font stack is used.
Routing uses the URL hash, which works from `file://`, from any static host and in Tauri.

## Consequences

- One file to copy, open or host.
- No service worker in the single file; hosting it as an installable PWA is an optional later
  addition.
- Dynamic imports are not used, because they would create extra files.
