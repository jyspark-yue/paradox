import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">{children}</h3>
      {right}
    </div>
  );
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-b border-board-700/70 px-4 py-3", className)}>
      <SectionTitle right={right}>{title}</SectionTitle>
      {children}
    </section>
  );
}

type Tone = "default" | "primary" | "danger" | "ghost" | "success";

export function Button({
  tone = "default",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" }) {
  const tones: Record<Tone, string> = {
    default: "bg-board-700 text-ink-100 hover:bg-board-600 border border-board-600",
    primary: "bg-evidence text-board-950 hover:bg-[#f0c75a] border border-[#f0c75a] font-semibold",
    danger: "bg-transparent text-contra border border-contra/60 hover:bg-contra/10",
    ghost: "bg-transparent text-ink-300 hover:text-ink-100 hover:bg-board-800 border border-transparent",
    success: "bg-action/15 text-action border border-action/50 hover:bg-action/25",
  };
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-evidence/70 disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}

export function Badge({ children, color, className, title }: { children: ReactNode; color?: string; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none", className)}
      style={color ? { color, backgroundColor: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}55` } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}

/** Monospace chain of node ids, e.g. act_lab_door → obs_01 → src_lab_door. */
export function PathChain({ path, onPick }: { path: string[]; onPick?: (id: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-[11px] leading-5">
      {path.map((id, i) => (
        <span key={`${id}-${i}`} className="inline-flex items-center gap-1">
          {onPick ? (
            <button type="button" className="rounded bg-board-800 px-1 text-ink-200 hover:bg-board-700 hover:text-ink-100" onClick={() => onPick(id)}>
              {id}
            </button>
          ) : (
            <span className="rounded bg-board-800 px-1 text-ink-200">{id}</span>
          )}
          {i < path.length - 1 && <span className="text-ink-400">→</span>}
        </span>
      ))}
    </div>
  );
}

export function Meter({ value, max, color = "#e3b341", marker, className }: { value: number; max: number; color?: string; marker?: number; className?: string }) {
  const w = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={cx("relative h-2 overflow-hidden rounded-full bg-board-700", className)}>
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${w}%`, backgroundColor: color }} />
      {marker !== undefined && (
        <div className="absolute inset-y-[-2px] w-[2px] bg-ink-100" style={{ left: `calc(${Math.min(100, (marker / max) * 100)}% - 1px)` }} />
      )}
    </div>
  );
}
