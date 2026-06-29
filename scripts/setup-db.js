#!/usr/bin/env node
const { db, initialSeedResult } = require('../server');

const result = initialSeedResult;
console.log('Database setup complete. Migrations applied.');
if (result.seeded) {
  console.log(`Seeded default OWNER user: ${result.username}`);
} else if (result.reason === 'users-exist') {
  console.log('Default OWNER seed skipped because one or more users already exist.');
} else if (result.reason === 'missing-env') {
  console.log('Default OWNER seed skipped because DEFAULT_OWNER_USERNAME or DEFAULT_OWNER_PASSWORD is not configured.');
}
db.close();
