/**
 * Brand mark: a DLMM liquidity ladder. Bars are bins around the active bin
 * (the tall phosphor one); the two sides are dimmer — above the active bin
 * liquidity is one asset, below it the other. Animated rise on load via the
 * `.binmark` CSS (styles.css), stilled under prefers-reduced-motion.
 */
export function BinMark({ size = 26 }: { size?: number }) {
  // x, height, fill — active bin at index 3.
  const bars: Array<[number, number, string]> = [
    [0, 8, "var(--color-ink-3)"],
    [4, 13, "var(--color-ink-3)"],
    [8, 18, "var(--color-ink-2)"],
    [12, 24, "var(--color-mint)"],
    [16, 16, "var(--color-ink-2)"],
    [20, 11, "var(--color-ink-3)"],
    [24, 7, "var(--color-ink-3)"],
  ];
  return (
    <svg
      className="binmark shrink-0"
      width={size}
      height={size}
      viewBox="0 0 27 24"
      aria-hidden
    >
      {bars.map(([x, h, fill]) => (
        <rect key={x} x={x} y={24 - h} width={3} height={h} fill={fill} />
      ))}
    </svg>
  );
}
