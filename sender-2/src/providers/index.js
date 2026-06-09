import { createDryRunProvider } from './dry-run.js';
import { createInstagramPlaywrightProvider } from './instagram-playwright.js';

export function createProvider(name, options = {}) {
  if (!name || name === 'dry-run') return createDryRunProvider();
  if (['instagram-playwright', 'playwright', 'instagram'].includes(name)) {
    return createInstagramPlaywrightProvider(options);
  }
  throw new Error(`Unknown sender provider: ${name}`);
}
