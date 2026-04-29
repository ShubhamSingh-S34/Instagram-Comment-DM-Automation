/**
 * db.js — Pure JavaScript JSON persistence (no native compilation needed)
 * Data is stored in data.json in the project root.
 * Works on macOS, Windows, and Linux without any compilation step.
 */
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

// ─────────────────────────────────────────
//  Low-level read / write
// ─────────────────────────────────────────
function read() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { rules: [], logs: [], _ruleSeq: 0, _logSeq: 0 };
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────
function init() {
  if (!fs.existsSync(DB_PATH)) {
    save({ rules: [], logs: [], _ruleSeq: 0, _logSeq: 0 });
  }
  console.log('✅  Database ready (data.json)');
}

// ─────────────────────────────────────────
//  RULES
// ─────────────────────────────────────────
function getAllRules() {
  const { rules } = read();
  return [...rules].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getRulesForMedia(mediaId) {
  const { rules } = read();
  return rules.filter(r => r.media_id === mediaId && r.active);
}

function getRuleById(id) {
  const { rules } = read();
  return rules.find(r => r.id === id) || null;
}

function createRule({ media_id, media_caption, media_thumbnail, keywords, initial_message, link_message }) {
  const db = read();
  db._ruleSeq += 1;
  const rule = {
    id:              db._ruleSeq,
    media_id,
    media_caption:   media_caption   || '',
    media_thumbnail: media_thumbnail || '',
    keywords,
    initial_message,
    link_message,
    active:          true,
    created_at:      new Date().toISOString(),
  };
  db.rules.push(rule);
  save(db);
  return rule.id;
}

function updateRule(id, { keywords, initial_message, link_message, active }) {
  const db = read();
  const idx = db.rules.findIndex(r => r.id === id);
  if (idx !== -1) {
    db.rules[idx] = {
      ...db.rules[idx],
      keywords,
      initial_message,
      link_message,
      active: active !== undefined ? active : db.rules[idx].active,
    };
    save(db);
  }
}

function deleteRule(id) {
  const db  = read();
  db.rules  = db.rules.filter(r => r.id !== id);
  save(db);
}

// ─────────────────────────────────────────
//  DM LOGS
// ─────────────────────────────────────────
function hasBeenDMed(mediaId, userId) {
  const { logs } = read();
  return logs.some(l => l.media_id === mediaId && l.user_id === userId && l.status !== 'failed');
}

function logDM({ rule_id, media_id, user_id, username, comment_id, comment_text, keyword_matched, status }) {
  const db = read();
  db._logSeq += 1;
  db.logs.push({
    id:              db._logSeq,
    rule_id,
    media_id,
    user_id,
    username:        username        || 'unknown',
    comment_id,
    comment_text,
    keyword_matched: keyword_matched || '',
    status,
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  });
  save(db);
}

function getPendingDM(userId) {
  const { logs } = read();
  const pending = logs
    .filter(l => l.user_id === userId && l.status === 'awaiting_follow')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return pending[0] || null;
}

function updateDMStatus(userId, mediaId, status) {
  const db = read();
  db.logs = db.logs.map(l => {
    if (l.user_id === userId && l.media_id === mediaId && l.status === 'awaiting_follow') {
      return { ...l, status, updated_at: new Date().toISOString() };
    }
    return l;
  });
  save(db);
}

function getLogs(limit = 20, offset = 0) {
  const { logs } = read();
  return [...logs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(offset, offset + limit);
}

function getLogsCount() {
  return read().logs.length;
}

function getStats() {
  const { rules, logs } = read();
  return {
    total_dms:       logs.length,
    links_sent:      logs.filter(l => l.status === 'link_sent').length,
    awaiting_follow: logs.filter(l => l.status === 'awaiting_follow').length,
    failed:          logs.filter(l => l.status === 'failed').length,
    active_rules:    rules.filter(r => r.active).length,
  };
}

module.exports = {
  init,
  getAllRules, getRulesForMedia, getRuleById,
  createRule, updateRule, deleteRule,
  hasBeenDMed, logDM, getPendingDM, updateDMStatus,
  getLogs, getLogsCount, getStats,
};
