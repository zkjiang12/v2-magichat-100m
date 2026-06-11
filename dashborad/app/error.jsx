'use client';

export default function DashboardError({ error, reset }) {
  const message = error?.message || '';
  const looksLikeConfig = message.includes('DATABASE_URL');

  return (
    <main>
      <section className="empty-state">
        <h2>{looksLikeConfig ? 'Dashboard is not connected yet' : 'Something went wrong'}</h2>
        <p>{message || 'The connection to the server was interrupted.'}</p>
        {looksLikeConfig ? (
          <p>Set `DATABASE_URL` and run the dashboard/control migrations.</p>
        ) : (
          <p>This is usually a dropped connection — reloading fixes it.</p>
        )}
        <button type="button" onClick={() => reset()}>
          Reload
        </button>
      </section>
    </main>
  );
}
