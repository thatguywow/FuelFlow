/**
 * Icon set.
 *
 * Hand-rolled inline SVG rather than an icon package: there are eighteen of
 * them, they all share one stroke weight and one 24-unit grid, and shipping a
 * dependency for that would cost more than the icons do.
 */

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({ size = 20, className, strokeWidth = 1.75, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconFlame = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3c.6 3 2.4 4.2 3.8 5.7A7 7 0 0 1 19 13.5 7 7 0 1 1 5 13.5c0-2 .9-3.4 2-4.6.4 1 1.1 1.7 2 2 0-2.6.9-5.6 3-7.9Z" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 20h18" />
    <path d="M6 16v-5M11 16V6M16 16v-8M21 16v-3" />
  </Svg>
);

export const IconBody = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2.3" />
    <path d="M5.5 10.5 12 9l6.5 1.5M12 9v6M9 21l3-6 3 6" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const IconBarcode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H7M17 4h2.5A1.5 1.5 0 0 1 21 5.5V7M21 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H4.5A1.5 1.5 0 0 1 3 18.5V17" />
    <path d="M7 8v8M10.5 8v8M14 8v8M17 8v8" />
  </Svg>
);

/**
 * Scanning, as the act rather than the object.
 *
 * `IconBarcode` draws the bars themselves, which is right for a field labelled
 * with a barcode number but wrong for the action: four corner brackets and a
 * reading line say "point the camera at this" and match the viewfinder the
 * scanner actually puts on screen.
 */
export const IconScan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" />
    <path d="M4 12h16" />
  </Svg>
);

/** A nutrition panel: the ruled table, not a book. */
export const IconLabel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="3.5" width="14" height="17" rx="2.4" />
    <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
  </Svg>
);

/**
 * The app's mark: the 270° gauge the Today screen opens with.
 *
 * Same artwork as the launcher icon and the launch screen, so the thing on the
 * home screen, the thing while it loads and the thing at the top of onboarding
 * are one shape. Drawn rather than stroked from `currentColor` because the
 * two-tone track-and-progress reading is the whole point.
 */
export const IconMark = ({ size = 32, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="ff-mark-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="var(--ff-brand)" />
        <stop offset="55%" stopColor="var(--ff-brand-2)" />
        <stop offset="100%" stopColor="var(--ff-brand-3)" />
      </linearGradient>
    </defs>
    <path
      d="M17.86 46.14A20 20 0 1 1 46.14 46.14"
      stroke="var(--color-surface-3)"
      strokeWidth="7.5"
      strokeLinecap="round"
    />
    <path
      d="M17.86 46.14A20 20 0 0 1 44.98 16.79"
      stroke="url(#ff-mark-g)"
      strokeWidth="7.5"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * Writing a meal out in words.
 *
 * Not a sparkle: that glyph has become shorthand for "an AI did this", and this
 * feature is a deterministic parser — it reads quantities and units, it does not
 * guess. Lines and a pencil say what it is.
 */
export const IconCompose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h13M4 11h13M4 15.5h6" />
    <path d="m13.4 19.8 5.3-5.3a1.7 1.7 0 0 0-2.4-2.4l-5.3 5.3-.4 2.8z" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6.5 7 7 19a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 19l.5-12" />
  </Svg>
);

export const IconScale = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M8 11a4 4 0 0 1 8 0" />
    <path d="m12 11 2.5-2.5" />
  </Svg>
);

export const IconDroplet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c3 3.8 5.5 6.4 5.5 9.4a5.5 5.5 0 1 1-11 0c0-3 2.5-5.6 5.5-9.4Z" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
);

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8Z" />
  </Svg>
);

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4c.7 3.6 1.7 4.6 5.3 5.3-3.6.7-4.6 1.7-5.3 5.3-.7-3.6-1.7-4.6-5.3-5.3C10.3 8.6 11.3 7.6 12 4Z" />
    <path d="M18 16c.3 1.4.7 1.8 2 2-1.3.3-1.7.7-2 2-.3-1.4-.7-1.8-2-2 1.3-.3 1.7-.7 2-2Z" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" />
  </Svg>
);

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 1 4 16Z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 0 20 16Z" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
  </Svg>
);

/**
 * Meal glyphs, drawn on the same 24-unit grid and stroke weight as everything
 * else. Emoji were standing in here and looked cheap next to a line-icon set —
 * they render in the system emoji font, so they carry a different colour
 * palette, a different weight, and a different look on every device.
 */
export const IconSunrise = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v3M5.6 9.6l2.1 2.1M2.5 16h3M18.4 9.6l-2.1 2.1M21.5 16h-3" />
    <path d="M8 16a4 4 0 0 1 8 0" />
    <path d="M3 20h18" />
  </Svg>
);

export const IconBowl = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11h18a9 9 0 0 1-18 0Z" />
    <path d="M9.5 7.5c0-1.2 1-1.6 1-2.6 0-.7-.5-1.2-.5-1.2M14 7.5c0-1.2 1-1.6 1-2.6 0-.7-.5-1.2-.5-1.2" />
  </Svg>
);

export const IconCutlery = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3v7a2 2 0 0 0 4 0V3M8 12v9" />
    <path d="M17.5 3c-1.4 1-2 2.6-2 4.5s.6 3 2 3.5V3Zm0 8v10" />
  </Svg>
);

export const IconApple = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 8.2c-1-.9-2.2-1.2-3.4-1C6.6 7.5 5 9.4 5 12.2c0 3.6 2.6 8 4.7 8 .9 0 1.5-.5 2.3-.5s1.4.5 2.3.5c2.1 0 4.7-4.4 4.7-8 0-2.8-1.6-4.7-3.6-5-1.2-.2-2.4.1-3.4 1Z" />
    <path d="M12 8.2V6a3 3 0 0 1 3-3" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 3 5.5 13.5H11l-1 7.5L18.5 10H13Z" />
  </Svg>
);

export const IconFlash = (p: IconProps & { off?: boolean }) => (
  <Svg {...p}>
    <path d="M13 3 5.5 13.5H11l-1 7.5L18.5 10H13Z" />
    {p.off && <path d="M3 3l18 18" />}
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.4" />
  </Svg>
);
