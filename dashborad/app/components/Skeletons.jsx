export function OverviewSkeleton() {
  return (
    <>
      <div className="overview-grid">
        <div className="skeleton skeleton-donut" />
        <div className="skeleton skeleton-donut" />
      </div>
      <div className="split chart-split">
        <div className="skeleton skeleton-chart" />
        <div className="skeleton skeleton-chart" />
        <div className="skeleton skeleton-chart" />
      </div>
    </>
  );
}

export function RunCentersSkeleton() {
  return (
    <div className="run-centers">
      <div className="skeleton skeleton-panel" />
      <div className="skeleton skeleton-panel" />
    </div>
  );
}

export function BandSkeleton({ height = 220 }) {
  return (
    <section className="band">
      <div className="skeleton" style={{ height }} />
    </section>
  );
}
