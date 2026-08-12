import { useEffect, useRef, type ReactNode } from 'react';
import { useUi } from '../state/ui';
import { IconClose } from './icons';

/** Small class-name joiner; avoids a dependency for something this trivial. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  full?: boolean;
};

const BUTTON_VARIANTS = {
  // The brand gradient plus a matching glow. The glow is what stops a filled
  // button from looking like a flat coloured rectangle.
  primary:
    'brand-gradient text-brand-contrast font-semibold glow-brand hover:brightness-110 active:brightness-95',
  secondary:
    'bg-surface-2 text-text border border-border hover:bg-surface-3 hover:border-border-strong',
  ghost: 'text-dim hover:text-text hover:bg-surface-2',
  danger: 'bg-danger/12 text-danger border border-danger/20 hover:bg-danger/20',
} as const;

const BUTTON_SIZES = {
  sm: 'h-9 px-3.5 text-[13px] rounded-[0.75rem]',
  md: 'h-11 px-4 text-[15px] rounded-[--radius-input]',
  lg: 'h-[3.25rem] px-6 text-[16px] rounded-[1.125rem]',
} as const;

export function Button({ variant = 'secondary', size = 'md', full, className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 select-none',
        'transition-[background-color,border-color,filter,transform,box-shadow] duration-150',
        'active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        full && 'w-full',
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'grid size-10 shrink-0 place-items-center rounded-full text-dim',
        'transition-[background-color,color,transform] duration-150',
        'hover:bg-surface-2 hover:text-text active:scale-90',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  className,
  padded = true,
  glow = false,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { padded?: boolean; glow?: boolean }) {
  return (
    <div
      {...rest}
      className={cx('panel', padded && 'p-4', glow && 'gradient-ring', className)}
    />
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between px-1.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.11em] text-faint">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Screen title. The short brand-gradient rule above it costs nothing and gives
 * each screen a deliberate top edge rather than text floating at the margin.
 */
export function ScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 pb-1">
      <div>
        <span className="brand-gradient mb-2.5 block h-[3px] w-7 rounded-full" aria-hidden="true" />
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
      </div>
      {action && <div className="pt-4">{action}</div>}
    </div>
  );
}

/**
 * Grouped list container. Rows inside get hairline separators and the group
 * gets the card's rounding, so a long list reads as one object instead of a
 * stack of full-bleed rectangles running off both edges of the screen.
 */
export function List({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx(
        'overflow-hidden rounded-[--radius-card] border border-border bg-surface',
        '[&>*+*]:border-t [&>*+*]:border-border',
        className,
      )}
    />
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx('h-px bg-border', className)} />;
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 px-6 py-12 text-center">
      {icon && (
        <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-faint">
          {icon}
        </div>
      )}
      <div>
        <p className="text-[15px] font-medium text-text">{title}</p>
        {detail && <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-faint">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[12.5px] font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11.5px] leading-[1.45] text-faint">{hint}</span>}
    </label>
  );
}

// React 19 passes `ref` as an ordinary prop to function components, so there is
// no forwardRef wrapper here.
export function Input({ className, ...rest }: React.ComponentPropsWithRef<'input'>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-11 w-full rounded-[--radius-input] border border-border bg-surface-2 px-3.5 text-[15px] text-text',
        'transition-[border-color,box-shadow] duration-150 placeholder:text-faint',
        // A softer focus treatment: the previous ring was bright enough to read
        // as an error state on a dark surface.
        'focus:border-brand/60 focus:outline-none focus:ring-[3px] focus:ring-brand/12',
        className,
      )}
    />
  );
}

export function Select({ className, ...rest }: React.ComponentPropsWithRef<'select'>) {
  return (
    <select
      {...rest}
      className={cx(
        'h-11 w-full rounded-[--radius-input] border border-border bg-surface-2 px-3.5 text-[15px] text-text',
        'transition-[border-color,box-shadow] duration-150',
        'focus:border-brand/60 focus:outline-none focus:ring-[3px] focus:ring-brand/12',
        className,
      )}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cx('flex gap-1 rounded-[--radius-input] border border-border bg-surface-2 p-1', className)}
      role="tablist"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'flex-1 rounded-[0.625rem] px-3 py-[7px] text-[13px] transition-all duration-200',
              active
                ? 'bg-surface font-semibold text-text shadow-[--shadow-e1]'
                : 'font-medium text-faint hover:text-dim',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-7 w-12 shrink-0 rounded-full border transition-all duration-200',
        checked
          ? 'brand-gradient border-transparent shadow-[0_0_12px_-2px_var(--ff-brand-glow)]'
          : 'border-border bg-surface-3',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] size-[1.125rem] rounded-full bg-white shadow-md',
          'transition-[left] duration-200 ease-[--ease-spring]',
          checked ? 'left-[1.5rem]' : 'left-[3px]',
        )}
      />
    </button>
  );
}

export function Row({
  title,
  detail,
  right,
  onClick,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-3 px-4 py-3.5 text-left',
        onClick && 'transition-colors duration-150 hover:bg-surface-2 active:bg-surface-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium text-text">{title}</div>
        {detail && <div className="mt-0.5 truncate text-[12px] text-faint">{detail}</div>}
      </div>
      {right && <div className="shrink-0 text-[14px] text-dim tnum">{right}</div>}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

/**
 * Bottom sheet. Full height on phones, a centred card on wide screens, so the
 * same component carries both the native app and the desktop site.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'tall',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'auto' | 'tall';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Prevent the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 animate-fade-in bg-[--ff-scrim] backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={cx(
          'relative flex w-full flex-col overflow-hidden bg-bg-elevated shadow-[--shadow-e3] animate-sheet-in',
          'border-t border-border sm:border',
          'rounded-t-[--radius-sheet] sm:max-w-lg sm:rounded-[--radius-sheet]',
          size === 'tall' ? 'h-[92dvh] sm:h-[86vh]' : 'max-h-[92dvh]',
        )}
      >
        {/* Drag affordance. Purely visual, but its absence is what makes a
            bottom sheet feel like a web modal instead of a native one. */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <div className="h-1 w-9 rounded-full bg-border-strong" />
        </div>

        <div className="flex items-center gap-2 border-b border-border px-2 py-2">
          <div className="min-w-0 flex-1 px-2">
            {typeof title === 'string' ? (
              <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
            ) : (
              title
            )}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <IconClose />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>

        {footer && (
          <div className="safe-b border-t border-border bg-bg-elevated p-3 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.4)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.25rem+env(safe-area-inset-bottom,0px))] z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            'pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl px-4 py-3',
            'glass border border-border-strong shadow-[--shadow-e3] animate-pop-in',
          )}
        >
          <span className={cx('flex-1 text-[14px]', toast.tone === 'danger' && 'text-danger')}>
            {toast.message}
          </span>
          {toast.action && (
            <button
              className="shrink-0 text-[14px] font-semibold text-brand"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
