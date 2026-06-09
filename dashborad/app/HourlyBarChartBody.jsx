'use client';

import { useState } from 'react';

export default function HourlyBarChartBody({
  buckets,
  segments,
  chartHeight,
  chartWidth,
  slotWidth,
  barInset,
  maxTotal,
  axisStride,
  ariaLabel,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const hovered = hoverIdx !== null ? buckets[hoverIdx] : null;
  const barCount = buckets.length || 1;

  return (
    <div className="chart-body">
      <div className="chart-plot">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          className="chart-svg"
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <line
            x1="0"
            y1={chartHeight - 0.5}
            x2={chartWidth}
            y2={chartHeight - 0.5}
            stroke="var(--line)"
            strokeWidth="0.5"
          />
          {buckets.map((bucket, index) => {
            const slotX = index * slotWidth;
            const x = slotX + barInset;
            const width = slotWidth - barInset * 2;
            let yCursor = chartHeight;
            const isHover = hoverIdx === index;
            return (
              <g
                key={String(bucket.hour) + index}
                className={`chart-bar-group${isHover ? ' is-hover' : ''}`}
                onMouseEnter={() => setHoverIdx(index)}
              >
                <rect
                  x={slotX}
                  y={0}
                  width={slotWidth}
                  height={chartHeight}
                  fill="transparent"
                  className="chart-bar-hit"
                />
                {maxTotal > 0 &&
                  segments.map((seg) => {
                    const value = Number(bucket.parts[seg.key]) || 0;
                    if (value <= 0) return null;
                    const segHeight = (value / maxTotal) * chartHeight;
                    yCursor -= segHeight;
                    return (
                      <rect
                        key={seg.key}
                        x={x}
                        y={yCursor}
                        width={width}
                        height={segHeight}
                        fill={seg.color}
                      />
                    );
                  })}
              </g>
            );
          })}
        </svg>
        {hovered ? (
          <div
            className={`chart-tooltip${
              hoverIdx > barCount / 2 ? ' chart-tooltip-right' : ' chart-tooltip-left'
            }`}
            style={{ left: `${((hoverIdx + 0.5) / barCount) * 100}%` }}
          >
            <div className="chart-tooltip-title">{hovered.tooltipLabel}</div>
            {segments.map((seg) => (
              <div key={seg.key} className="chart-tooltip-row">
                <span className="chart-swatch" style={{ background: seg.color }} />
                <span className="chart-tooltip-label">{seg.label}</span>
                <span className="chart-tooltip-value">{hovered.formattedParts[seg.key]}</span>
              </div>
            ))}
            <div className="chart-tooltip-row chart-tooltip-total">
              <span className="chart-swatch chart-swatch-empty" />
              <span className="chart-tooltip-label">Total</span>
              <span className="chart-tooltip-value">{hovered.formattedTotal}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="chart-axis">
        {buckets.map((bucket, index) => (
          <span key={String(bucket.hour) + index}>
            {index % axisStride === 0 ? bucket.axisLabel : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
