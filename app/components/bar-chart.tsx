type Bar = { label: string; value: number; secondary?: number };

/**
 * Minimal SVG bar chart: total bars with an optional darker part (e.g.
 * accepted). The picture is for the eye; the same numbers are in a list that
 * screen readers read instead, so nothing depends on seeing the bars or their
 * shades.
 */
export function BarChart({ bars, height = 120 }: { bars: Bar[]; height?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const width = 100 / Math.max(1, bars.length);
  const said = (bar: Bar) =>
    `${bar.label}: ${bar.value}${bar.secondary !== undefined ? ` (${bar.secondary} accepted)` : ''}`;
  return (
    <figure>
      <ul className="sr-only">
        {bars.map((bar) => (
          <li key={bar.label}>{said(bar)}</li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        aria-hidden
      >
        {bars.map((bar, i) => {
          const h = (bar.value / max) * (height - 4);
          const h2 = ((bar.secondary ?? 0) / max) * (height - 4);
          return (
            <g key={bar.label}>
              {/* one text node: SVG titles must not be split into several */}
              <title>{said(bar)}</title>
              <rect
                x={i * width + width * 0.15}
                y={height - h}
                width={width * 0.7}
                height={h}
                fill="#c7d2fe"
              />
              <rect
                x={i * width + width * 0.15}
                y={height - h2}
                width={width * 0.7}
                height={h2}
                fill="#4f46e5"
              />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-slate-500" aria-hidden>
        <span>{bars[0]?.label}</span>
        <span>{bars[bars.length - 1]?.label}</span>
      </figcaption>
    </figure>
  );
}
