import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

/* ===== Button ===== */
export function Button({
  variant = 'default',
  size,
  icon,
  loading,
  children,
  ...rest
}: {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  icon?: ReactNode;
  loading?: boolean | undefined;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  if (size === 'sm') classes.push('btn--sm');
  const { disabled, ...buttonProps } = rest;
  return (
    <button className={classes.join(' ')} disabled={loading || disabled} {...buttonProps}>
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  ...rest
}: {
  label: string;
  icon: ReactNode;
  variant?: 'default' | 'ghost' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn', 'btn--icon'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  return (
    <button className={classes.join(' ')} title={label} aria-label={label} {...rest}>
      {icon}
    </button>
  );
}

/* ===== Badge ===== */
type BadgeTone = 'amber' | 'teal' | 'sky' | 'violet' | 'coral' | 'muted';

export function Badge({ tone = 'muted', dot, children }: PropsWithChildren<{ tone?: BadgeTone; dot?: boolean }>) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <Badge tone={enabled ? 'teal' : 'muted'} dot>{enabled ? 'Enabled' : 'Disabled'}</Badge>;
}

export function HealthBadge({ status }: { status?: string | null | undefined }) {
  const value = (status ?? 'unknown').toLowerCase();
  const tone: BadgeTone = value === 'healthy' ? 'teal' : value === 'unknown' ? 'muted' : 'coral';
  return <Badge tone={tone} dot>{value}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const value = outcome.toUpperCase();
  const tone: BadgeTone =
    value === 'SUCCEEDED' ? 'teal' : value === 'DENIED' ? 'amber' : value.includes('FAIL') ? 'coral' : 'sky';
  return <Badge tone={tone}>{outcome.toLowerCase()}</Badge>;
}

/* ===== Stat card ===== */
export function StatCard({
  label,
  value,
  sub,
  accent = 'amber',
  emphasize,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: 'amber' | 'teal' | 'sky' | 'violet' | 'coral';
  emphasize?: boolean;
}) {
  const accentVar: Record<string, string> = {
    amber: 'var(--amber)',
    teal: 'var(--teal)',
    sky: 'var(--sky)',
    violet: 'var(--violet)',
    coral: 'var(--coral)',
  };
  return (
    <div className="stat-card" style={{ ['--card-accent' as string]: accentVar[accent] }}>
      <span className="stat-label">{label}</span>
      <span className={emphasize ? 'stat-value accent' : 'stat-value'}>{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/* ===== Panel ===== */
export function Panel({
  title,
  eyebrow,
  actions,
  children,
  style,
}: PropsWithChildren<{ title: string; eyebrow?: string; actions?: ReactNode; style?: React.CSSProperties }>) {
  return (
    <section className="panel" style={style}>
      <div className="panel-header">
        <div>
          {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
          <h3>{title}</h3>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/* ===== Fields ===== */
export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input value={value} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} {...rest} />;
}

export function TextArea({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (value: string) => void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  return <textarea value={value} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)} {...rest} />;
}

export function Select({
  value,
  onChange,
  options,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select value={value} onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)} {...rest}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label}
    </label>
  );
}

/* ===== Empty state ===== */
export function EmptyState({ icon, message }: { icon?: ReactNode; message: string }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-ico">{icon}</div> : null}
      {message}
    </div>
  );
}

/* ===== JSON block ===== */
export function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(JSON.parse(value), null, 2) : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className="code-block">{text}</pre>;
}

/* ===== Drawer ===== */
export function Drawer({
  open,
  title,
  eyebrow,
  onClose,
  footer,
  children,
}: PropsWithChildren<{ open: boolean; title: string; eyebrow?: string; onClose: () => void; footer?: ReactNode }>) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
    (focusable()[0] ?? drawerRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key === 'Tab') {
        const elements = focusable(); const first = elements[0]; const last = elements.at(-1);
        if (!first) { e.preventDefault(); drawerRef.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="drawer-header">
          <div>
            {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
            <h3>{title}</h3>
          </div>
          <IconButton label="Close" icon={<Icon.Close />} onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </aside>
    </>
  );
}

/* ===== Confirm dialog ===== */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-center" onClick={onCancel}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="confirm-actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading} icon={<Icon.Trash className="btn-ico" />}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ===== Copy field ===== */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-reveal">
      <span style={{ flex: 1 }}>{value}</span>
      <IconButton
        label={label ?? 'Copy'}
        icon={copied ? <Icon.Check /> : <Icon.Copy />}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      />
    </div>
  );
}
