#!/usr/bin/env node
const { db, hashPassword } = require('../server');
const { now } = require('../datetime');

const ROLES = new Set(['OWNER', 'ADMIN', 'CLERK']);

function usage() {
  console.error('Usage: node scripts/create-user.js <username> <password> [display_name] [role]');
  console.error('Example: node scripts/create-user.js clerk1 tempPass123 "Store Clerk" CLERK');
}

const [username, password, displayNameArg, roleArg] = process.argv.slice(2);
const role = String(roleArg || 'CLERK').toUpperCase();

if (!username || !password || !ROLES.has(role)) {
  usage();
  process.exit(1);
}

const displayName = displayNameArg || username;
const stamp = now();
const id = `user_${cryptoRandomId()}`;

try {
  db.prepare(`
    INSERT INTO users(id, username, display_name, role, password_hash, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, username, displayName, role, hashPassword(password), stamp, stamp);
  console.log(`Created ${role} user: ${username}`);
  process.exit(0);
} catch (error) {
  if (String(error.message).includes('UNIQUE')) {
    console.error(`User already exists: ${username}`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
}

function cryptoRandomId() {
  return require('crypto').randomUUID().replace(/-/g, '').slice(0, 21);
}
