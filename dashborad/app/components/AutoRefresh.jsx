'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const ACTIVE_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 45_000;
const TOAST_DISMISS_MS = 6_000;
const BASE_TITLE = 'MagicHat Campaign Dashboard';

// Polls router.refresh() so the dashboard stays current without manual
// reloads: every 5s while a run is in flight, every 45s when idle. Also owns
// the tab-title progress readout and run-finished toasts.
export default function AutoRefresh({ activeCount = 0, titleProgress = null, runs = [] }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [, setTick] = useState(0);
  const [toasts, setToasts] = useState([]);
  const prevRunsRef = useRef(null);
  const wasRefreshingRef = useRef(false);

  useEffect(() => {
    if (paused) return undefined;
    const interval = setInterval(() => {
      startTransition(() => router.refresh());
    }, activeCount > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [router, paused, activeCount]);

  useEffect(() => {
    if (wasRefreshingRef.current && !isRefreshing) setLastUpdated(Date.now());
    wasRefreshingRef.current = isRefreshing;
  }, [isRefreshing]);

  useEffect(() => {
    const ticker = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    document.title = activeCount > 0 && titleProgress ? `▶ ${titleProgress} — MagicHat` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [activeCount, titleProgress]);

  useEffect(() => {
    const previous = prevRunsRef.current;
    prevRunsRef.current = runs;
    if (!previous) return;

    const previousById = new Map(previous.map((run) => [run.id, run.status]));
    const justFinished = runs.filter((run) => {
      const before = previousById.get(run.id);
      return before && before !== run.status && ['completed', 'failed', 'stopped'].includes(run.status);
    });
    if (justFinished.length === 0) return;

    setToasts((current) => [
      ...current,
      ...justFinished.map((run) => ({
        id: `${run.id}-${run.status}`,
        tone: run.status === 'completed' ? 'good' : 'bad',
        text: `${run.kind} run ${String(run.id).slice(0, 8)} ${run.status}`,
      })),
    ]);
  }, [runs]);

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timer = setTimeout(() => setToasts((current) => current.slice(1)), TOAST_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  const secondsAgo = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));

  return (
    <>
      <div className="refresh-chip">
        <span
          className={`refresh-dot${activeCount > 0 && !paused ? ' is-live' : ''}${paused ? ' is-paused' : ''}`}
        />
        <span>
          {paused ? 'auto-refresh paused' : isRefreshing ? 'updating…' : `updated ${secondsAgo}s ago`}
        </span>
        <button type="button" onClick={() => setPaused((value) => !value)}>
          {paused ? 'resume' : 'pause'}
        </button>
      </div>
      {toasts.length > 0 ? (
        <div className="toast-stack" role="status">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.tone}`}>
              {toast.text}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
