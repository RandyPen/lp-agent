/**
 * Chart components. Colors follow the dataviz reference palette's dark
 * categorical steps (validated against the dark surface): blue #3987e5,
 * aqua #199e70, violet #9085e9. One axis per chart, crosshair tooltips on,
 * thin marks, recessive grid.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MarketStateEpisode, PnlTick, Prediction, PricePoint } from "@/lib/api";
import { formatTs, formatUsd } from "@/lib/format";

const GRID = "rgba(159, 176, 188, 0.08)";
const AXIS_TICK = { fill: "#5c6c78", fontSize: 11, fontFamily: "IBM Plex Mono" } as const;

const TOOLTIP_STYLE = {
  backgroundColor: "#151c22",
  border: "1px solid #2b3945",
  borderRadius: 6,
  fontFamily: "IBM Plex Mono",
  fontSize: 12,
  color: "#e8eef2",
} as const;

const SERIES = ["#3987e5", "#199e70", "#9085e9", "#c98500"] as const;

// ---------------------------------------------------------------------------
// NAV per PM — multi-line, each PM its own series
// ---------------------------------------------------------------------------

export interface NavSeries {
  name: string;
  points: PnlTick[];
}

export function NavChart({ series }: { series: NavSeries[] }) {
  return (
    <div className={series.length > 1 ? "h-72" : "h-64"}>
      <ResponsiveContainer>
        <LineChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => formatTs(v)}
            tick={AXIS_TICK}
            stroke={GRID}
            allowDuplicatedCategory={false}
          />
          <YAxis
            tick={AXIS_TICK}
            stroke={GRID}
            width={70}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `$${formatUsd(v, 0)}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => formatTs(Number(v))}
            formatter={(value) => [`$${formatUsd(Number(value))}`, "NAV"]}
          />
          {series.map((s, i) => (
            <Line
              key={s.name}
              data={s.points}
              dataKey="nav_usd"
              name={s.name}
              stroke={SERIES[i % SERIES.length]}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {series.length > 1 && (
        <div className="text-ink-3 mt-1 flex flex-wrap gap-4 font-mono text-[11px]">
          {series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4"
                style={{ background: SERIES[i % SERIES.length] }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cumulative fee income — single aqua area (no legend needed)
// ---------------------------------------------------------------------------

export function FeeChart({ ticks }: { ticks: Array<{ ts_ms: number; cum_fees: number }> }) {
  return (
    <div className="h-40">
      <ResponsiveContainer>
        <ComposedChart data={ticks} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => formatTs(v)}
            tick={AXIS_TICK}
            stroke={GRID}
          />
          <YAxis
            tick={AXIS_TICK}
            stroke={GRID}
            width={70}
            tickFormatter={(v: number) => `$${formatUsd(v, 0)}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => formatTs(Number(v))}
            formatter={(value) => [`$${formatUsd(Number(value))}`, "cumulative fees"]}
          />
          <Area
            dataKey="cum_fees"
            stroke="#199e70"
            strokeWidth={2}
            fill="#199e70"
            fillOpacity={0.14}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vol band — observed price line + ±1.28σ (80%) vol band centered on spot
// ---------------------------------------------------------------------------

export interface FanData {
  pricePoints: Array<{ ts_ms: number; price: number }>;
  bandPoints: Array<{ ts_ms: number; band: [number, number]; center: number }>;
}

/**
 * Convert prediction rows (bin-offset space) + observed prices into two
 * price-space series (observed line, prediction band). Bin id ↑ = price ↓
 * for this pool (poolCoinAIsQuote), so an offset of +d bins maps to
 * price × (1+binStep/1e4)^(-d).
 */
export function buildFanPoints(
  predictions: Prediction[],
  prices: PricePoint[],
  binStep: number,
): FanData {
  const ratio = 1 + binStep / 10_000;
  const pricePoints = prices
    .map((p) => ({ ts_ms: p.observed_ms, price: Number(p.price) }))
    .sort((a, b) => a.ts_ms - b.ts_ms);

  // Thin the prediction series so band vertices stay sparse enough to read
  // as a ribbon instead of per-tick fuzz.
  const MAX_BAND_POINTS = 150;
  const step = Math.max(1, Math.ceil(predictions.length / MAX_BAND_POINTS));
  const thinned = predictions.filter((_, i) => i % step === 0);

  // Anchor each prediction's offsets at the nearest observed price.
  const bandPoints: FanData["bandPoints"] = [];
  for (const pred of thinned) {
    let nearest: { ts_ms: number; price: number } | undefined;
    let best = Infinity;
    for (const p of pricePoints) {
      const d = Math.abs(p.ts_ms - pred.ts_ms);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    if (!nearest || best > 15 * 60 * 1000) continue;
    const at = (offset: number) => nearest!.price * Math.pow(ratio, -offset);
    // Center is spot by design (the center head was removed 2026-07); the
    // band is the ±1.28σ 80 % interval from the vol head.
    const half = 1.28 * pred.width_sigma;
    const lo = Math.min(at(-half), at(half));
    const hi = Math.max(at(-half), at(half));
    bandPoints.push({ ts_ms: pred.ts_ms, band: [lo, hi], center: at(0) });
  }
  bandPoints.sort((a, b) => a.ts_ms - b.ts_ms);
  return { pricePoints, bandPoints };
}

export function PredictionFan({ data }: { data: FanData }) {
  return (
    <div className="h-72">
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => formatTs(v)}
            tick={AXIS_TICK}
            stroke={GRID}
          />
          <YAxis
            tick={AXIS_TICK}
            stroke={GRID}
            width={64}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => formatTs(Number(v))}
            formatter={(value, name) => {
              if (Array.isArray(value)) {
                return [`${Number(value[0]).toFixed(3)} – ${Number(value[1]).toFixed(3)}`, "±1.28σ band"];
              }
              return [Number(value).toFixed(3), name === "price" ? "price" : "band center (spot)"];
            }}
          />
          <Area
            data={data.bandPoints}
            dataKey="band"
            stroke="none"
            fill="#199e70"
            fillOpacity={0.16}
            isAnimationActive={false}
            name="±1.28σ band"
          />
          <Line
            data={data.bandPoints}
            dataKey="center"
            stroke="#199e70"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            name="band center (spot)"
          />
          <Line
            data={data.pricePoints}
            dataKey="price"
            stroke="#3987e5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="price"
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-ink-3 mt-1 flex gap-4 font-mono text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: "#3987e5" }} /> observed price
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t border-dashed" style={{ borderColor: "#199e70" }} />
          band center (spot)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4" style={{ background: "rgba(25,158,112,0.25)" }} /> ±1.28σ vol band
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market-state ribbon — colored horizontal band of NORMAL/TREND/EXTREME
// ---------------------------------------------------------------------------

const STATE_COLOR: Record<string, string> = {
  NORMAL: "var(--color-state-normal)",
  TREND: "var(--color-state-trend)",
  EXTREME: "var(--color-state-extreme)",
};

export function StateRibbon({ episodes, now }: { episodes: MarketStateEpisode[]; now: number }) {
  if (episodes.length === 0) return null;
  const asc = [...episodes].sort((a, b) => a.entered_at_ms - b.entered_at_ms);
  const start = asc[0]!.entered_at_ms;
  const span = Math.max(1, now - start);

  return (
    <div>
      <div className="border-line flex h-5 w-full overflow-hidden rounded-sm border">
        {asc.map((e, i) => {
          const end = e.exited_at_ms ?? now;
          const width = ((end - e.entered_at_ms) / span) * 100;
          return (
            <div
              key={i}
              title={`${e.state} · ${formatTs(e.entered_at_ms)} → ${e.exited_at_ms ? formatTs(e.exited_at_ms) : "now"} · trigger: ${e.trigger}`}
              style={{
                width: `${width}%`,
                background: `color-mix(in srgb, ${STATE_COLOR[e.state] ?? "#5c6c78"} 55%, transparent)`,
              }}
              className="h-full min-w-[2px] border-r border-black/30 last:border-r-0"
            />
          );
        })}
      </div>
      <div className="text-ink-3 mt-1 flex justify-between font-mono text-[10px]">
        <span>{formatTs(start)}</span>
        <span>now</span>
      </div>
    </div>
  );
}
