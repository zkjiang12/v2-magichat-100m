#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 4173;
const DEFAULT_STATE_PATH = 'data/frontier-crawl-state.json';
const DEFAULT_EVALUATIONS_PATH = 'data/evaluations.jsonl';

const options = parseOptions(process.argv.slice(2));

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/') {
      sendHtml(response, renderDashboardHtml());
      return;
    }

    if (url.pathname === '/api/state') {
      const requestedStatePath = url.searchParams.get('state');
      const statePath = requestedStatePath || options.statePath;
      const state = await readJsonIfExists(statePath);
      sendJson(response, buildStateResponse({ state, statePath }));
      return;
    }

    if (url.pathname === '/api/evaluations') {
      const rows = await readJsonlIfExists(options.evaluationsPath);
      sendJson(response, {
        evaluationsPath: path.resolve(options.evaluationsPath),
        rows: rows.slice().reverse(),
      });
      return;
    }

    sendText(response, 'Not found', 404);
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
});

server.listen(options.port, () => {
  console.log(`Crawl dashboard: http://localhost:${options.port}`);
  console.log(`State file: ${path.resolve(options.statePath)}`);
});

function buildStateResponse({ state, statePath }) {
  if (!state) {
    return {
      exists: false,
      statePath: path.resolve(statePath),
      totals: emptyTotals(),
      workers: [],
      profiles: [],
      recent: [],
    };
  }

  return buildFrontierStateResponse({ state, statePath });
}

function buildFrontierStateResponse({ state, statePath }) {
  const seenRecords = Object.values(state.seen || {});
  const statusCounts = countBy(seenRecords, (record) => record.status || 'unknown');
  const frontierCounts = countBy(state.frontier || [], (seed) => seed.status || 'unknown');
  const queuedSeeds = (state.frontier || []).filter(
    (seed) => seed.status === 'pending' || seed.status === 'paused',
  ).length;
  const queuedCandidates = (state.qualificationQueue || []).length;
  const processed = state.processedCount ?? (
    (statusCounts.accepted || 0) + (statusCounts.rejected || 0)
  );
  const accepted = state.acceptedCount ?? (statusCounts.accepted || 0);

  return {
    exists: true,
    mode: 'frontier',
    statePath: path.resolve(statePath),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    acceptedLimit: state.maxAccepted,
    currentSeed: state.currentSeed,
    totals: {
      accepted,
      processed,
      failed: state.failedCount || statusCounts.failed || 0,
      seen: seenRecords.length,
      queuedSeeds,
      queuedCandidates,
      statusCounts,
      frontierCounts,
    },
    workersTitle: 'Frontier',
    workers: frontierRecords(state.frontier || []),
    profiles: profileRecords(seenRecords),
    recent: recentRecords(seenRecords),
  };
}

function emptyTotals() {
  return {
    accepted: 0,
    processed: 0,
    seen: 0,
    queuedSeeds: 0,
    queuedCandidates: 0,
    statusCounts: {},
  };
}

function frontierRecords(frontier) {
  return frontier
    .slice()
    .sort((a, b) => frontierSortValue(a) - frontierSortValue(b))
    .slice(0, 48)
    .map((seed) => ({
      id: seed.handle,
      handle: seed.handle,
      acceptedCount: seed.priorityScore || 0,
      processedCount: seed.depth || 0,
      prioritySeeds: seed.priorityScore || 0,
      regularSeeds: seed.depth || 0,
      completed: seed.status === 'done' || seed.status === 'failed',
      status: seed.status,
      depth: seed.depth,
      priorityScore: seed.priorityScore,
      parentSeed: seed.parentSeed,
      originalSeed: Boolean(seed.originalSeed),
      discoveredAt: seed.discoveredAt,
      filterStats: seed.filterStats,
      discovery: seed.discovery,
    }));
}

function profileRecords(records) {
  return records
    .filter((record) => record.status === 'accepted' || record.status === 'rejected')
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .map((record) => ({
      handle: record.handle,
      name: record.name,
      profileUrl: record.profileUrl,
      status: record.status,
      batchId: record.batchId,
      workerId: record.workerId,
      sourceSeed: record.sourceSeed,
      sourceDepth: record.sourceDepth,
      followersCount: record.followersCount,
      followingCount: record.followingCount,
      fitScore: record.fitScore,
      list: record.list,
      reasoning: record.reasoning,
      updatedAt: record.scoredAt || record.failedAt || record.discoveredAt,
    }));
}

function recentRecords(records) {
  return records
    .filter((record) => record.scoredAt || record.failedAt || record.discoveredAt)
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .slice(0, 80)
    .map((record) => ({
      handle: record.handle,
      status: record.status,
      batchId: record.batchId,
      workerId: record.workerId,
      sourceSeed: record.sourceSeed,
      sourceDepth: record.sourceDepth,
      followersCount: record.followersCount,
      fitScore: record.fitScore,
      list: record.list,
      reasoning: record.reasoning,
      error: record.error,
      updatedAt: record.scoredAt || record.failedAt || record.discoveredAt,
    }));
}

function timestampValue(record) {
  return Date.parse(record.scoredAt || record.failedAt || record.discoveredAt || 0) || 0;
}

function frontierSortValue(seed) {
  const statusRank = {
    qualifying: 0,
    discovering: 1,
    pending: 2,
    paused: 3,
    failed: 4,
    done: 5,
  }[seed.status] ?? 9;
  return (
    statusRank * 1_000_000_000 +
    (seed.depth || 0) * 1_000_000 -
    (seed.priorityScore || 0) * 10_000 +
    (seed.order || 0)
  );
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonlIfExists(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function sendHtml(response, body) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendText(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function parseOptions(args) {
  let port = Number(process.env.PORT || DEFAULT_PORT);
  let statePath = process.env.CRAWL_STATE_PATH || DEFAULT_STATE_PATH;
  let evaluationsPath = process.env.EVALUATIONS_PATH || DEFAULT_EVALUATIONS_PATH;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      port = Number(args[index + 1]);
      index += 1;
    } else if (arg === '--state') {
      statePath = args[index + 1];
      index += 1;
    } else if (arg === '--evaluations') {
      evaluationsPath = args[index + 1];
      index += 1;
    }
  }

  if (!Number.isInteger(port) || port < 1) {
    throw new Error('--port must be a positive integer');
  }
  if (!statePath) throw new Error('--state requires a file path');
  if (!evaluationsPath) throw new Error('--evaluations requires a file path');

  return { port, statePath, evaluationsPath };
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MagicHat Crawl Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #16181d;
      --muted: #667085;
      --line: #d9dee7;
      --green: #0f8a5f;
      --red: #b42318;
      --amber: #b54708;
      --blue: #175cd3;
      --ink: #26303d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; letter-spacing: 0; }
    main { padding: 20px 24px 32px; max-width: 1500px; margin: 0 auto; }
    .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .status { color: var(--muted); font-size: 13px; }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      height: 34px;
      padding: 0 12px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { border-color: #9aa4b2; }
    .grid { display: grid; gap: 16px; }
    .metrics { grid-template-columns: repeat(5, minmax(140px, 1fr)); }
    .metric, .section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px; min-height: 86px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .value { font-size: 30px; font-weight: 750; margin-top: 8px; line-height: 1; }
    .section { overflow: hidden; }
    .section h2 {
      margin: 0;
      padding: 14px 16px;
      font-size: 15px;
      border-bottom: 1px solid var(--line);
    }
    .section-body { padding: 14px 16px; }
    .two-col { grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.8fr); margin-top: 16px; }
    .batch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .batch {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }
    .batch-title { display: flex; justify-content: space-between; font-weight: 750; margin-bottom: 10px; }
    .progress {
      height: 8px;
      border-radius: 999px;
      background: #e8edf3;
      overflow: hidden;
      margin: 10px 0;
    }
    .bar { height: 100%; background: var(--green); width: 0%; }
    .mini { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 8px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      background: #fbfcfe;
      font-size: 12px;
      color: var(--ink);
    }
    .section-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--line);
      padding-right: 12px;
    }
    .section-top h2 { border-bottom: 0; flex: 1; }
    .section-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    label.control {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    select {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 0 28px 0 10px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
    }
    .profile-summary {
      color: var(--muted);
      font-size: 12px;
      padding: 12px 16px 0;
    }
    .table-wrap { overflow-x: auto; }
    .profile-cell { min-width: 170px; }
    .profile-name { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .profile-link { color: var(--blue); text-decoration: none; }
    .profile-link:hover { text-decoration: underline; }
    .nowrap { white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700; }
    .accepted { color: var(--green); background: #e9f8f1; }
    .rejected, .failed, .seed_failed { color: var(--red); background: #fff0ed; }
    .claimed { color: var(--blue); background: #edf4ff; }
    .filtered_private, .filtered_followers, .filtered_unverified, .filtered_hard_no { color: var(--amber); background: #fff6e8; }
    .seed { color: var(--ink); background: #eef2f7; }
    .reason { color: var(--muted); max-width: 520px; }
    .empty { color: var(--muted); padding: 16px; }
    code { background: #eef2f7; border-radius: 5px; padding: 2px 5px; }
    @media (max-width: 900px) {
      header { align-items: flex-start; flex-direction: column; }
      main { padding: 14px; }
      .metrics, .two-col { grid-template-columns: 1fr; }
      .value { font-size: 26px; }
      .section-top { align-items: flex-start; flex-direction: column; padding: 0 16px 14px 0; gap: 0; }
      .section-controls { padding-left: 16px; }
      table { font-size: 12px; }
      th, td { padding: 8px 6px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>MagicHat Crawl Dashboard</h1>
      <div class="status" id="statePath">Loading state...</div>
    </div>
    <div class="toolbar">
      <span class="status" id="lastUpdated">Not loaded</span>
      <button id="refreshButton" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section class="grid metrics" id="metrics"></section>
    <section class="grid two-col">
      <div class="section">
        <h2 id="workersTitle">Batches</h2>
        <div class="section-body">
          <div class="batch-grid" id="batches"></div>
        </div>
      </div>
      <div class="section">
        <h2>Status Counts</h2>
        <div class="section-body">
          <div class="chips" id="statusCounts"></div>
        </div>
      </div>
    </section>
    <section class="section" style="margin-top:16px">
      <div class="section-top">
        <h2>Accepted / Rejected Profiles</h2>
        <div class="section-controls">
          <label class="control">
            View
            <select id="profileFilter">
              <option value="all">All</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <label class="control">
            Sort
            <select id="profileSort">
              <option value="chronological_desc">Newest first</option>
              <option value="chronological_asc">Oldest first</option>
              <option value="score_desc">Ranking 4 to 1</option>
              <option value="score_asc">Ranking 1 to 4</option>
            </select>
          </label>
        </div>
      </div>
      <div id="profiles"></div>
    </section>
    <section class="section" style="margin-top:16px">
      <h2>Recent Crawl Events</h2>
      <div id="recent"></div>
    </section>
    <section class="section" style="margin-top:16px">
      <h2>Recent Evaluations</h2>
      <div id="evaluations"></div>
    </section>
  </main>
  <script>
    const formatter = new Intl.NumberFormat();
    const refreshButton = document.getElementById('refreshButton');
    const profileFilter = document.getElementById('profileFilter');
    const profileSort = document.getElementById('profileSort');
    let profileRows = [];

    refreshButton.addEventListener('click', refresh);
    profileFilter.addEventListener('change', renderProfiles);
    profileSort.addEventListener('change', renderProfiles);

    refresh();
    setInterval(refresh, 5000);

    async function refresh() {
      const [stateResponse, evaluationsResponse] = await Promise.all([
        fetch('/api/state').then((response) => response.json()),
        fetch('/api/evaluations').then((response) => response.json()),
      ]);
      const evaluationRows = evaluationsResponse.rows || [];
      renderState(stateResponse);
      profileRows = stateResponse.exists
        ? stateResponse.profiles
        : evaluationRows.map(profileFromEvaluation);
      renderProfiles();
      renderEvaluations(evaluationRows);
    }

    function renderState(data) {
      document.getElementById('statePath').textContent = data.exists
        ? data.statePath
        : data.statePath + ' does not exist yet';
      document.getElementById('lastUpdated').textContent = data.updatedAt
        ? 'Updated ' + new Date(data.updatedAt).toLocaleTimeString()
        : 'Waiting for crawl state';

      const totals = data.totals || {};
      metricCards([
        ['Accepted', totals.accepted || 0],
        ['Processed', totals.processed || 0],
        ['Seen', totals.seen || 0],
        ['Queued Seeds', totals.queuedSeeds || 0],
        ['Queued Candidates', totals.queuedCandidates || 0],
        ['Max Accepted', data.acceptedLimit || 0],
      ]);
      document.getElementById('workersTitle').textContent = data.workersTitle || 'Frontier';
      renderWorkers({
        workers: data.workers || [],
      });
      renderStatusCounts({
        statusCounts: totals.statusCounts || {},
        frontierCounts: totals.frontierCounts || {},
      });
      renderRecent(data.recent || []);
    }

    function profileFromEvaluation(row) {
      const score = Number(row.aiFitScore);
      return {
        handle: row.handle,
        name: row.creator && row.creator.name,
        profileUrl: row.profileUrl,
        status: score >= 3 ? 'accepted' : 'rejected',
        followersCount: row.creator && row.creator.followersCount,
        fitScore: score,
        list: row.list,
        reasoning: row.aiReasoning,
        updatedAt: row.createdAt,
      };
    }

    function metricCards(items) {
      document.getElementById('metrics').innerHTML = items.map(([label, value]) => (
        '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + formatter.format(value) + '</div></div>'
      )).join('');
    }

    function renderWorkers({ workers }) {
      const target = document.getElementById('batches');
      if (workers.length === 0) {
        target.innerHTML = '<div class="empty">No crawl state yet.</div>';
        return;
      }
      target.innerHTML = workers.map((seed) => {
        const queued = seed.filterStats && seed.filterStats.queued;
        const discovered = seed.discovery && seed.discovery.candidateCount;
        return '<div class="batch">' +
          '<div class="batch-title"><span>@' + escapeHtml(seed.handle || seed.id || '') + '</span><span>' + escapeHtml(seed.status || '') + '</span></div>' +
          '<div class="mini"><span>depth ' + formatNumber(seed.depth) + '</span><span>priority ' + formatNumber(seed.priorityScore) + '</span></div>' +
          '<div class="mini" style="margin-top:6px"><span>queued ' + formatNumber(queued) + '</span><span>found ' + formatNumber(discovered) + '</span></div>' +
          '<div class="mini" style="margin-top:6px"><span>' + (seed.originalSeed ? 'original seed' : 'discovered') + '</span><span>' + (seed.parentSeed ? '@' + escapeHtml(seed.parentSeed) : '') + '</span></div>' +
        '</div>';
      }).join('');
    }

    function renderStatusCounts({ statusCounts, frontierCounts }) {
      const entries = [
        ...Object.entries(statusCounts),
        ...Object.entries(frontierCounts).map(([status, count]) => ['frontier_' + status, count]),
      ].sort((a, b) => b[1] - a[1]);
      document.getElementById('statusCounts').innerHTML = entries.length
        ? entries.map(([status, count]) => '<span class="chip">' + escapeHtml(status) + ': ' + formatter.format(count) + '</span>').join('')
        : '<span class="empty">No statuses yet.</span>';
    }

    function renderRecent(rows) {
      const target = document.getElementById('recent');
      if (rows.length === 0) {
        target.innerHTML = '<div class="empty">No crawl events yet.</div>';
        return;
      }
      target.innerHTML = '<table><thead><tr><th>Handle</th><th>Status</th><th>Worker</th><th>Score</th><th>Followers</th><th>Source</th><th>Reason</th></tr></thead><tbody>' +
        rows.map((row) => '<tr>' +
          '<td><code>@' + escapeHtml(row.handle || '') + '</code></td>' +
          '<td><span class="pill ' + escapeClass(row.status || '') + '">' + escapeHtml(row.status || '') + '</span></td>' +
          '<td>' + escapeHtml(row.workerId || row.batchId || '') + '</td>' +
          '<td>' + (row.fitScore ? row.fitScore + '/4' : '') + '</td>' +
          '<td>' + formatNumber(row.followersCount) + '</td>' +
          '<td>' + escapeHtml(row.sourceSeed || '') + '</td>' +
          '<td class="reason">' + escapeHtml(row.reasoning || row.error || '') + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
    }

    function renderProfiles() {
      const target = document.getElementById('profiles');
      const filtered = filterProfileRows(profileRows);
      const rows = sortProfileRows(filtered);
      if (profileRows.length === 0) {
        target.innerHTML = '<div class="empty">No accepted or rejected profiles yet.</div>';
        return;
      }

      const acceptedCount = profileRows.filter((row) => row.status === 'accepted').length;
      const rejectedCount = profileRows.filter((row) => row.status === 'rejected').length;
      const scoreCounts = [4, 3, 2, 1]
        .map((score) => score + ': ' + profileRows.filter((row) => Number(row.fitScore) === score).length)
        .join(' | ');

      target.innerHTML =
        '<div class="profile-summary">Showing ' + formatter.format(rows.length) +
        ' of ' + formatter.format(profileRows.length) +
        ' | Accepted ' + formatter.format(acceptedCount) +
        ' | Rejected ' + formatter.format(rejectedCount) +
        ' | ' + scoreCounts + '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Profile</th><th>Result</th><th>Score</th><th>List</th><th>Followers</th><th>Worker</th><th>Source</th><th>Scored</th><th>Reason</th></tr></thead><tbody>' +
        rows.map((row) => '<tr>' +
          '<td class="profile-cell">' + renderProfileLink(row) + '<div class="profile-name">' + escapeHtml(row.name || '') + '</div></td>' +
          '<td><span class="pill ' + escapeClass(row.status || '') + '">' + escapeHtml(row.status || '') + '</span></td>' +
          '<td class="nowrap">' + (row.fitScore ? row.fitScore + '/4' : '') + '</td>' +
          '<td>' + escapeHtml(row.list || '') + '</td>' +
          '<td>' + formatNumber(row.followersCount) + '</td>' +
          '<td>' + escapeHtml(row.workerId || row.batchId || '') + '</td>' +
          '<td>' + (row.sourceSeed ? '<code>@' + escapeHtml(row.sourceSeed) + '</code>' : '') + '</td>' +
          '<td class="nowrap">' + formatDateTime(row.updatedAt) + '</td>' +
          '<td class="reason">' + escapeHtml(row.reasoning || '') + '</td>' +
        '</tr>').join('') +
        '</tbody></table></div>';
    }

    function filterProfileRows(rows) {
      const filter = profileFilter.value;
      if (filter === 'accepted') return rows.filter((row) => row.status === 'accepted');
      if (filter === 'rejected') return rows.filter((row) => row.status === 'rejected');
      return rows;
    }

    function sortProfileRows(rows) {
      const sort = profileSort.value;
      return rows.slice().sort((a, b) => {
        if (sort === 'score_desc') return scoreValue(b) - scoreValue(a) || timeValue(b) - timeValue(a);
        if (sort === 'score_asc') return scoreValue(a) - scoreValue(b) || timeValue(b) - timeValue(a);
        if (sort === 'chronological_asc') return timeValue(a) - timeValue(b) || scoreValue(b) - scoreValue(a);
        return timeValue(b) - timeValue(a) || scoreValue(b) - scoreValue(a);
      });
    }

    function renderProfileLink(row) {
      const handle = row.handle || '';
      const label = '<code>@' + escapeHtml(handle) + '</code>';
      if (!row.profileUrl) return label;
      return '<a class="profile-link" href="' + escapeHtml(row.profileUrl) + '" target="_blank" rel="noopener">' + label + '</a>';
    }

    function renderEvaluations(rows) {
      const target = document.getElementById('evaluations');
      if (rows.length === 0) {
        target.innerHTML = '<div class="empty">No evaluations yet.</div>';
        return;
      }
      target.innerHTML = '<table><thead><tr><th>Handle</th><th>Score</th><th>List</th><th>Followers</th><th>Reason</th></tr></thead><tbody>' +
        rows.slice(0, 30).map((row) => '<tr>' +
          '<td><code>@' + escapeHtml(row.handle || '') + '</code></td>' +
          '<td>' + (row.aiFitScore || '') + '/4</td>' +
          '<td>' + escapeHtml(row.list || '') + '</td>' +
          '<td>' + formatNumber(row.creator && row.creator.followersCount) + '</td>' +
          '<td class="reason">' + escapeHtml(row.aiReasoning || '') + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
    }

    function formatNumber(value) {
      return value === null || value === undefined ? '' : formatter.format(value);
    }

    function formatDateTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString();
    }

    function scoreValue(row) {
      const score = Number(row.fitScore);
      return Number.isFinite(score) ? score : 0;
    }

    function timeValue(row) {
      const parsed = Date.parse(row.updatedAt || '');
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function escapeClass(value) {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
}
