#!/usr/bin/env node

console.log(
  [
    'No historical dashboard import is needed.',
    'Run future scraper crawls with DATABASE_URL set; scraper-2 will write dashboard rows to Postgres live.',
    'Example:',
    "  cd ../scraper-2",
    "  DATABASE_URL='postgresql://...' npm run crawl -- --file seeds.txt",
  ].join('\n'),
);
