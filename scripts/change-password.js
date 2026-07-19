#!/usr/bin/env node
const { db, hashPassword } = require('../server');
const { now } = require('../datetime');

function usage() {
  console.error('Usage: node scripts/change-password.js <username> <new_password>');
}

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  usage();
  process.exit(1);
}

const result = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
  .run(hashPassword(password), now(), username);

if (!result.changes) {
  console.error(`User not found: ${username}`);
  process.exit(1);
}

console.log(`Password changed for user: ${username}`);
