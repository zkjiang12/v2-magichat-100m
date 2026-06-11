import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

// Access tokens are valid for ~1h; minting one per status check doubled every
// Cloud Run API call. Refresh 2 minutes before expiry.
let tokenCache = { token: null, expiresAt: 0 };

// Operations never leave a terminal state, so remember them for the life of
// the server instance instead of re-fetching on every page view.
const terminalOperationCache = new Map();

export async function triggerScraperCloudRunJob({ runId, campaign }) {
  if (!runId) throw new Error('Cloud Run scraper trigger requires a run id.');
  return triggerCloudRunJob({
    label: 'scraper',
    projectId: process.env.SCRAPER_CLOUD_RUN_PROJECT_ID,
    region: process.env.SCRAPER_CLOUD_RUN_REGION,
    jobName: process.env.SCRAPER_CLOUD_RUN_JOB_NAME,
    args: ['npm', 'run', 'crawl', '--', '--run-id', runId],
    env: campaign ? [{ name: 'OUTBOUND_CAMPAIGN', value: campaign }] : [],
  });
}

export async function triggerSenderCloudRunJob({ runId, campaign }) {
  if (!runId) throw new Error('Cloud Run sender trigger requires a run id.');
  const provider = process.env.SENDER_CLOUD_RUN_PROVIDER || 'dry-run';
  return triggerCloudRunJob({
    label: 'sender',
    projectId: process.env.SENDER_CLOUD_RUN_PROJECT_ID,
    region: process.env.SENDER_CLOUD_RUN_REGION,
    jobName: process.env.SENDER_CLOUD_RUN_JOB_NAME,
    args: ['npm', 'run', 'sender:run', '--', '--run-id', runId, '--once'],
    env: [
      { name: 'SENDER_PROVIDER', value: provider },
      { name: 'SENDER_LIVE_SENDS_ENABLED', value: process.env.SENDER_LIVE_SENDS_ENABLED || 'false' },
      { name: 'SENDER_WORKER_ID', value: `sender-cloud-${String(runId).slice(0, 8)}` },
      ...(campaign ? [{ name: 'OUTBOUND_CAMPAIGN', value: campaign }] : []),
    ],
  });
}

export async function getCloudRunOperationStatus({ operationName }) {
  if (!operationName) return { status: 'not_triggered' };

  const cached = terminalOperationCache.get(operationName);
  if (cached) return cached;

  try {
    const token = await getAccessToken();
    const response = await fetch(cloudRunResourceUrl(operationName), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        status: 'unknown',
        error: `Cloud Run status fetch failed: ${response.status} ${text}`,
      };
    }

    const status = normalizeOperationStatus(await response.json());
    if (status.done === true) terminalOperationCache.set(operationName, status);
    return status;
  } catch (error) {
    return {
      status: 'unknown',
      error: error.message,
    };
  }
}

async function triggerCloudRunJob({ label, projectId, region, jobName, args, env = [] }) {
  if (!projectId || !region || !jobName) return null;

  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}:run`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          {
            args,
            env,
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloud Run ${label} trigger failed: ${response.status} ${text}`);
  }

  const operation = await response.json();
  return {
    ...operation,
    target: 'cloud_run_job',
  };
}

function cloudRunResourceUrl(resourceName) {
  if (String(resourceName).startsWith('https://')) return resourceName;
  return `https://run.googleapis.com/v2/${String(resourceName).replace(/^\/+/, '')}`;
}

function normalizeOperationStatus(operation) {
  const metadata = operation.metadata || {};
  const error = operation.error?.message || operation.error?.details?.[0]?.message || null;

  if (error) {
    return {
      status: 'failed',
      done: true,
      error,
      message: metadata.statusMessage || null,
    };
  }

  if (operation.done === true) {
    return {
      status: 'succeeded',
      done: true,
      error: null,
      message: metadata.statusMessage || null,
    };
  }

  if (operation.done === false) {
    return {
      status: 'running',
      done: false,
      error: null,
      message: metadata.statusMessage || null,
    };
  }

  return {
    status: 'unknown',
    done: null,
    error: null,
    message: metadata.statusMessage || null,
  };
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const minted = await mintAccessToken();
  tokenCache = {
    token: minted.token,
    expiresAt: Date.now() + (Number(minted.expiresIn) || 300) * 1000 - 120_000,
  };
  return minted.token;
}

async function mintAccessToken() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    return getServiceAccountAccessToken(JSON.parse(serviceAccountJson));
  }

  const metadataToken = await getMetadataAccessToken();
  if (metadataToken) return metadataToken;

  const adcToken = await getApplicationDefaultAccessToken();
  if (adcToken) return adcToken;

  throw new Error(
    'Cloud Run trigger is configured, but no Google credentials are available. Set GOOGLE_SERVICE_ACCOUNT_JSON, run `gcloud auth application-default login`, or run on Google Cloud.',
  );
}

async function getMetadataAccessToken() {
  try {
    const response = await fetch(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(RUN_SCOPE)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload.access_token) return null;
    return { token: payload.access_token, expiresIn: payload.expires_in };
  } catch {
    return null;
  }
}

async function getServiceAccountAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: credentials.client_email,
    scope: RUN_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const unsignedJwt = `${header}.${claim}`;
  const signature = await signRs256(unsignedJwt, credentials.private_key);
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google access token request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return { token: payload.access_token, expiresIn: payload.expires_in || 3600 };
}

async function getApplicationDefaultAccessToken() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
  if (!fs.existsSync(credentialsPath)) return null;

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (credentials.type === 'service_account') {
    return getServiceAccountAccessToken(credentials);
  }
  if (credentials.type === 'authorized_user') {
    return getAuthorizedUserAccessToken(credentials);
  }
  return null;
}

async function getAuthorizedUserAccessToken(credentials) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google ADC token refresh failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return { token: payload.access_token, expiresIn: payload.expires_in || 3600 };
}

async function signRs256(input, privateKeyPem) {
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(input),
  );
  return base64UrlEncode(signature);
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
