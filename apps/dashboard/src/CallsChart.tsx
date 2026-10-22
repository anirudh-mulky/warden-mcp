import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallRecord, Verdict } from "@warden/shared";

/**
 * Calls per minute over the last 30 minutes, stacked by verdict.
 *
 * Plain SVG, no chart library: one stacked bar per minute, a 2px gap between
 * bars and between segments, a rounded top on each bar, three recessive
 * gridlines, and a tooltip per bar. Verdict colors are the fixed status
 * palette (good / warning / critical, neutral for errors) and never carry
 * meaning alone — the legend names them and the tooltip spells out counts.
 */

const MINUTES = 30;
/** Stack order, bottom to top. */
const ORDER: Verdict[] = ["allow", "throttle", "deny", "error"];
export const VERDICT_NAME: Record<Verdict, string> = { allow: "Allowed", throttle: "Throttled", deny: "Blocked", error: "Error" };

const HEIGHT = 200;
const PAD = { top: 10, right: 4, bottom: 22, left: 34 };
const GAP = 2;

interface Bucket {
  start: number;
  counts: Record<Verdict, number>;
  total: number;
}

/** The smallest of 1, 2, 5 × 10^n that is >= value, so gridlines land on round numbers. */
function niceCeil(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** A bar segment with only its top corners rounded — the data end. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function CallsChart({ calls, now }: { calls: ToolCallRecord[]; now: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  // Fit the chart to its card, whatever the screen size.
  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const buckets = useMemo<Bucket[]>(() => {
    const lastMinute = Math.floor(now / 60_000);
    const first = lastMinute - (MINUTES - 1);
    const list: Bucket[] = Array.from({ length: MINUTES }, (_, i) => ({
      start: (first + i) * 60_000,
      counts: { allow: 0, throttle: 0, deny: 0, error: 0 },
      total: 0,
    }));
    for (const c of calls) {
      const i = Math.floor(Date.parse(c.startedAt) / 60_000) - first;
      const b = list[i];
      if (b !== undefined) {
        b.counts[c.verdict] += 1;
        b.total += 1;
      }
    }
    return list;
  }, [calls, now]);

  const totals = useMemo(() => {
    const t: Record<Verdict, number> = { allow: 0, throttle: 0, deny: 0, error: 0 };
    for (const b of buckets) for (const v of ORDER) t[v] += b.counts[v];
    return t;
  }, [buckets]);

  const max = niceCeil(Math.max(0, ...buckets.map((b) => b.total)));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / MINUTES;
  const barW = Math.max(2, band - GAP);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const empty = buckets.every((b) => b.total === 0);
  const hovered = hover === null ? null : buckets[hover];

  return (
    <div className="chart">
      <ul className="legend" aria-label="Legend">
        {ORDER.map((v) => (
          <li key={v}>
            <span className={`swatch v-${v}`} aria-hidden="true" />
            {VERDICT_NAME[v]}
            <span className="legend-count">{totals[v]}</span>
          </li>
        ))}
      </ul>
      <div className="chart-plot" ref={wrap} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={HEIGHT} role="img" aria-label={`Calls per minute for the last ${MINUTES} minutes, stacked by result`}>
          {[0, max / 2, max].map((g) => (
            <g key={g}>
              <line className={g === 0 ? "axis" : "grid"} x1={PAD.left} x2={width - PAD.right} y1={y(g)} y2={y(g)} />
              <text className="tick" x={PAD.left - 8} y={y(g)} dy="0.32em" textAnchor="end">
                {g}
              </text>
            </g>
          ))}

          {buckets.map((b, i) => {
            const x = PAD.left + i * band + GAP / 2;
            const dim = hover !== null && hover !== i;
            let base = 0;
            const present = ORDER.filter((v) => b.counts[v] > 0);
            return (
              <g key={b.start} opacity={dim ? 0.4 : 1}>
                {present.map((v, k) => {
                  const top = base + b.counts[v];
                  const y0 = y(base);
                  const y1 = y(top);
                  base = top;
                  const isTop = k === present.length - 1;
                  // 2px surface gap above every segment except the top one.
                  const h = Math.max(1, y0 - y1 - (isTop ? 0 : GAP));
                  return isTop ? (
                    <path key={v} className={`v-${v}`} d={roundedTop(x, y0 - h, barW, h, 4)} />
                  ) : (
                    <rect key={v} className={`v-${v}`} x={x} y={y0 - h} width={barW} height={h} />
                  );
                })}
                {/* Hit target: the whole column, much bigger than a thin bar. */}
                <rect x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}

          {[0, 10, 20, MINUTES - 1].map((i) => (
            <text key={i} className="tick" x={PAD.left + i * band + band / 2} y={HEIGHT - 6} textAnchor="middle">
              {i === MINUTES - 1 ? "now" : `−${MINUTES - 1 - i}m`}
            </text>
          ))}
        </svg>

        {empty && <div className="chart-empty muted">No calls in the last {MINUTES} minutes</div>}

        {hovered !== null && hovered !== undefined && hover !== null && (
          <div
            className="tooltip"
            style={{ left: Math.min(PAD.left + hover * band + band / 2, width - 90), top: 0 }}
          >
            <div className="tooltip-title">
              {time(hovered.start)}–{time(hovered.start + 60_000)}
            </div>
            {ORDER.map((v) => (
              <div key={v} className="tooltip-row">
                <span className={`swatch v-${v}`} aria-hidden="true" />
                <span>{VERDICT_NAME[v]}</span>
                <span className="tooltip-num">{hovered.counts[v]}</span>
              </div>
            ))}
            <div className="tooltip-row total">
              <span />
              <span>Total</span>
              <span className="tooltip-num">{hovered.total}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
