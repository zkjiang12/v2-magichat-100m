import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const scraperDir = path.join(repoRoot, 'scraper-2');
const senderDir = path.join(repoRoot, 'sender-2');
const logDir = path.join(repoRoot, '.dashboard-runs');

export function getLocalToolStatus() {
  return {
    commands: {
      scraperWorker: `cd ${scraperDir} && npm run worker:claim`,
      senderDryRun: `cd ${senderDir} && npm run sender:run -- --once`,
      scraperAccuracyEval: `cd ${scraperDir} && npm run eval:accuracy`,
      scraperSpeedCostEval: `cd ${scraperDir} && npm run eval:speed-cost`,
      senderTests: `cd ${senderDir} && npm test`,
      scraperTests: `cd ${scraperDir} && npm test`,
    },
    logs: listRecentLogs(),
    evalRuns: {
      accuracy: listRecentFiles(path.join(scraperDir, 'data/eval-runs/accuracy'), 5),
      speedCost: listRecentFiles(path.join(scraperDir, 'data/eval-runs/speed-cost'), 5),
    },
  };
}

export async function launchScraperWorker() {
  return spawnLoggedProcess({
    cwd: scraperDir,
    args: ['run', 'worker:claim'],
    label: 'scraper-worker',
  });
}

export async function launchSenderDryRunWorker() {
  return spawnLoggedProcess({
    cwd: senderDir,
    args: ['run', 'sender:run', '--', '--once'],
    label: 'sender-dry-run',
    env: {
      SENDER_PROVIDER: 'dry-run',
      SENDER_WORKER_ID: `dashboard-dry-run-${Date.now()}`,
    },
  });
}

export async function launchScraperAccuracyEval() {
  return spawnLoggedProcess({
    cwd: scraperDir,
    args: ['run', 'eval:accuracy'],
    label: 'scraper-eval-accuracy',
  });
}

export async function launchScraperSpeedCostEval() {
  return spawnLoggedProcess({
    cwd: scraperDir,
    args: ['run', 'eval:speed-cost'],
    label: 'scraper-eval-speed-cost',
  });
}

export async function launchScraperTests() {
  return spawnLoggedProcess({
    cwd: scraperDir,
    args: ['test'],
    label: 'scraper-tests',
  });
}

export async function launchSenderTests() {
  return spawnLoggedProcess({
    cwd: senderDir,
    args: ['test'],
    label: 'sender-tests',
  });
}

function spawnLoggedProcess({ cwd, args, label, env = {} }) {
  fs.mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  const logPath = path.join(logDir, `${toLogStamp(startedAt)}-${label}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  stream.write(`$ cd ${cwd} && npm ${args.join(' ')}\n`);
  stream.write(`startedAt=${startedAt.toISOString()}\n\n`);

  const child = spawn('npm', args, {
    cwd,
    detached: true,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.on('exit', (code, signal) => {
    stream.write(`\nexitedAt=${new Date().toISOString()} code=${code} signal=${signal || ''}\n`);
    stream.end();
  });
  child.unref();

  return {
    pid: child.pid,
    logPath,
  };
}

function listRecentLogs() {
  return listRecentFiles(logDir, 12).map((file) => ({
    ...file,
    tail: readTail(file.path, 4000),
  }));
}

function listRecentFiles(dir, limit) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    })
    .filter((file) => file.size > 0)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(maxBytes, stat.size);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function toLogStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}
