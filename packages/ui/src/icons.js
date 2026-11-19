import { html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';

/**
 * Inline stroke icons (24x24 grid, drawn for this project). Static markup only, never user input.
 * @type {Record<string, string>}
 */
const ICONS = {
  bluetooth: '<path d="M7 7l10 10-5 5V2l5 5L7 17"/>',
  usb: '<path d="M9 2v5M15 2v5M6 7h12v5a6 6 0 0 1-12 0zM12 18v4"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3"/>',
  cell: '<rect x="7" y="4.5" width="10" height="17" rx="2"/><path d="M10 2.5h4"/><path d="M10 13h4"/>',
  cells: '<rect x="2.5" y="6" width="5" height="14" rx="1.2"/><rect x="9.5" y="6" width="5" height="14" rx="1.2"/><rect x="16.5" y="6" width="5" height="14" rx="1.2"/><path d="M4 4h2M11 4h2M18 4h2"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4.5-5.5"/><circle cx="12" cy="17" r="1.2"/>',
  chart: '<path d="M3.5 3.5v17h17"/><path d="M7 15.5l3.5-4.5 3 2.5L19.5 6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  power: '<path d="M12 3v9"/><path d="M17.7 6.8a8 8 0 1 1-11.4 0"/>',
  warning: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V8M7 13l5-5 5 5M4 4h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  thermometer: '<path d="M14 14.5V5a2 2 0 1 0-4 0v9.5a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  bolt: '<path d="M13 2.5L4.5 14H11l-1 7.5L19.5 10H13z"/>',
  current: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.8 6.8 0 0 0 11 11z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  unlink: '<path d="M15.5 13.5l3.2-3.2a4 4 0 0 0-5.7-5.7L10 7.5M8.5 10.5l-3.2 3.2a4 4 0 0 0 5.7 5.7L14 16.5M3 3l18 18"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  balance: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  tag: '<path d="M3 12V3.5h8.5L21 13l-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  ruler: '<path d="M3 16.5L16.5 3 21 7.5 7.5 21z"/><path d="M7 12.5l2 2M10 9.5l2 2M13 6.5l2 2"/>',
  cable: '<path d="M5 3v4M9 3v4M4 7h6v3a3 3 0 0 1-6 0zM7 13v2a5 5 0 0 0 10 0V9a3 3 0 0 1 6 0"/>',
  wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 0 5.8 5.8l-8.1 8.1a2.1 2.1 0 0 1-3-3l8.1-8.1z"/><path d="M14.5 6.5l3-3a4.5 4.5 0 0 0-3 3z"/>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-9-1.5 2-2 3.5-2 5-1-1-2-2-2.5-3.5C7.5 9.5 6 12 6 15a6 6 0 0 0 6 6z"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  save: '<path d="M5 3h11l4 4v12.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3z"/><path d="M8 3v5h7M8 21v-7h8v7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cycle: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/><path d="M20 4v4.5h-4.5M4 20v-4.5h4.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  device: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
};

/**
 * Render an icon.
 * @param {string} name
 * @param {{ size?: number, label?: string, stroke?: number }} [opts]
 */
export function icon(name, { size = 22, label, stroke = 1.8 } = {}) {
  const body = ICONS[name] ?? ICONS.dot;
  return html`<svg
    class="icon"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${stroke}
    stroke-linecap="round"
    stroke-linejoin="round"
    role=${label ? 'img' : 'presentation'}
    aria-hidden=${label ? 'false' : 'true'}
    aria-label=${label ?? ''}
  >${unsafeSVG(body)}</svg>`;
}

export const iconNames = Object.keys(ICONS);
