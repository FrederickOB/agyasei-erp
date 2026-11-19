/**
 * The icon set, inline and dependency-free.
 *
 * WHY NOT AN ICON PACKAGE. This app is precached whole and expected to run for
 * days without a network (§8.1). Every kilobyte in the service worker's atomic
 * precache is a kilobyte a till in a weak-signal town has to fetch before it
 * can be installed at all, and an icon library ships thousands of glyphs to
 * use the handful this interface needs. These are that handful, drawn on one
 * 24px grid with one stroke weight, so nothing in the interface is
 * stylistically out of family.
 *
 * WHY NOT TEXT GLYPHS, which is what this replaced. The status bar drew its
 * connection state with typographic characters (a filled circle, a triangle).
 * They render at the mercy of whatever font the device has, they cannot take a
 * stroke weight, and at 14px in daylight they are indistinguishable from each
 * other. Colour and shape both have to carry meaning here (§2.6 of the brief:
 * colour is never the only channel), which needs real shapes.
 *
 * Every icon is `aria-hidden`: an icon in this interface always sits beside
 * its own words, or inside a control that carries an accessible name. None of
 * them is ever the only thing saying what something is.
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'search'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'cart'
  | 'receipt'
  | 'check'
  | 'clock'
  | 'alert'
  | 'cloud-off'
  | 'sync'
  | 'live'
  | 'back'
  | 'close'
  | 'download'
  | 'pin'
  | 'tag'
  | 'undo'
  | 'edit'
  // The back office's rail (features/office). Same grid, same weight.
  | 'grid'
  | 'chart'
  | 'box'
  | 'truck'
  | 'building'
  | 'book';

/** Paths only — every icon shares the same 24px box, caps, joins and weight. */
const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M10 4h4M9 7v12M15 7v12" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  cart: (
    <>
      <path d="M3 5h2.2l2.3 10.5h9.6L19 8H7" />
      <circle cx="9" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6L8.4 20.5 6 18.9z" />
      <path d="M9.5 8.5h5M9.5 12.5h5" />
    </>
  ),
  check: <path d="M4.5 12.5l5 5 10-11" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.4l3.4 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.8L2.8 20h18.4z" />
      <path d="M12 9.5v4.7M12 17.2v.1" />
    </>
  ),
  'cloud-off': (
    <>
      <path d="M17.6 17.5H7a4.2 4.2 0 01-.6-8.36" />
      <path d="M9.4 6.6A5 5 0 0118.3 9.2a3.9 3.9 0 012.4 5.7" />
      <path d="M3.5 3.5l17 17" />
    </>
  ),
  sync: (
    <>
      <path d="M20 12a8 8 0 01-13.7 5.6M4 12a8 8 0 0113.7-5.6" />
      <path d="M4 6.5V12h5.5M20 17.5V12h-5.5" />
    </>
  ),
  live: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M17.3 6.7a7.5 7.5 0 010 10.6M6.7 17.3a7.5 7.5 0 010-10.6" />
    </>
  ),
  back: <path d="M11 5l-7 7 7 7M4 12h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  download: (
    <>
      <path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-6.1 6.5-11a6.5 6.5 0 10-13 0C5.5 14.9 12 21 12 21z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  tag: (
    <>
      <path d="M11.4 3.5H20v8.6l-8.9 8.9-8.6-8.6z" />
      <circle cx="16" cy="8" r="1.4" />
    </>
  ),
  undo: (
    <>
      <path d="M4 9h10.5a5 5 0 010 10H9" />
      <path d="M7.5 5L4 9l3.5 4" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  chart: <path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6" />,
  box: <path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10" />,
  truck: (
    <>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17" cy="18" r="1.6" />
    </>
  ),
  building: <path d="M4 21V9l8-5 8 5v12M9 21v-6h6v6" />,
  book: <path d="M4 4h16v16H4zM4 9h16M9 9v11" />,
  edit: (
    <>
      <path d="M4 20h4l10.5-10.5a2.6 2.6 0 00-3.7-3.7L4.3 16.3z" />
      <path d="M14.5 6.5l3.7 3.7" />
    </>
  ),
};

export function Icon({
  name,
  size = 24,
  className,
}: {
  readonly name: IconName;
  /** Sizes come from the icon tokens (--icon-sm/md/lg), never ad-hoc values. */
  readonly size?: number;
  readonly className?: string;
}): ReactNode {
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
