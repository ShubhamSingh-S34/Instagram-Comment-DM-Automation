require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');
const ig      = require('./instagram');

const app = express();

// Parse JSON but keep raw body for signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT         = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'insta_webhook_secret_2024';
const APP_SECRET   = process.env.APP_SECRET;

// ─────────────────────────────────────────
//  WEBHOOK  (Meta sends events here)
// ─────────────────────────────────────────

/** Step 1 – Meta pings this to verify the webhook URL */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅  Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.log('❌  Webhook verification failed – check your verify token');
  res.sendStatus(403);
});

/** Step 2 – Meta sends real events here */
app.post('/webhook', async (req, res) => {
  // Verify the payload signature to ensure it came from Meta
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
      if (sig !== expected) {
        console.log('❌  Invalid webhook signature – rejected');
        return res.sendStatus(403);
      }
    }
  }

  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field === 'comments') {
        await handleComment(change.value).catch(console.error);
      } else if (change.field === 'messages') {
        await handleMessage(change.value).catch(console.error);
      }
    }
  }
});

// ─────────────────────────────────────────
//  COMMENT HANDLER
// ─────────────────────────────────────────
async function handleComment(value) {
  const { media, id: commentId, text, from } = value;
  const mediaId  = media?.id;
  const userId   = from?.id;
  const username = from?.username || 'unknown';

  if (!mediaId || !userId || !text) return;

  console.log(`\n💬  Comment from @${username}: "${text}" on media ${mediaId}`);

  const rules = db.getRulesForMedia(mediaId);
  if (!rules.length) return;

  for (const rule of rules) {
    if (!rule.active) continue;

    const keywords = rule.keywords.split(',').map(k => k.trim().toLowerCase());
    const matched  = keywords.find(kw => text.toLowerCase().includes(kw));

    if (!matched) continue;

    // Don't DM the same person twice for the same post
    if (db.hasBeenDMed(mediaId, userId)) {
      console.log(`⏭️   Already DM'd @${username} for this post – skipping`);
      continue;
    }

    try {
      await ig.sendDM(userId, rule.initial_message);
      db.logDM({
        rule_id:         rule.id,
        media_id:        mediaId,
        user_id:         userId,
        username,
        comment_id:      commentId,
        comment_text:    text,
        keyword_matched: matched,
        status:          'awaiting_follow',
      });
      console.log(`✉️   Initial DM sent to @${username} (keyword: "${matched}")`);
    } catch (err) {
      console.error(`❌  Failed to DM @${username}:`, err.message);
      db.logDM({
        rule_id:         rule.id,
        media_id:        mediaId,
        user_id:         userId,
        username,
        comment_id:      commentId,
        comment_text:    text,
        keyword_matched: matched,
        status:          'failed',
      });
    }

    break; // Only fire one rule per comment
  }
}

// ─────────────────────────────────────────
//  MESSAGE HANDLER  (reply detection)
// ─────────────────────────────────────────
async function handleMessage(value) {
  const senderId = value.sender?.id;
  const text     = value.message?.text?.toLowerCase().trim();

  if (!senderId || !text) return;

  console.log(`\n📩  Message from ${senderId}: "${text}"`);

  // Keywords that mean "I've followed you, now send the link"
  const confirmWords = [
    'done', 'followed', 'yes', 'ok', 'send', 'link',
    'follow kiya', 'kar liya', 'ho gaya', '✅', 'ready', 'hi', 'hello'
  ];
  const isConfirmation = confirmWords.some(kw => text.includes(kw));

  if (!isConfirmation) return;

  const pending = db.getPendingDM(senderId);
  if (!pending) return;

  const rule = db.getRuleById(pending.rule_id);
  if (!rule) return;

  try {
    await ig.sendDM(senderId, rule.link_message);
    db.updateDMStatus(senderId, pending.media_id, 'link_sent');
    console.log(`🔗  Link delivered to user ${senderId}`);
  } catch (err) {
    console.error(`❌  Failed to send link to ${senderId}:`, err.message);
  }
}

// ─────────────────────────────────────────
//  REST API  (used by the dashboard)
// ─────────────────────────────────────────

/** Instagram profile */
app.get('/api/profile', async (_req, res) => {
  try {
    res.json(await ig.getProfile());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Fetch recent reels */
app.get('/api/reels', async (_req, res) => {
  try {
    res.json(await ig.getReels());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** All rules */
app.get('/api/rules', (_req, res) => res.json(db.getAllRules()));

/** Rules for a specific media */
app.get('/api/rules/media/:mediaId', (req, res) =>
  res.json(db.getRulesForMedia(req.params.mediaId))
);

/** Create rule */
app.post('/api/rules', (req, res) => {
  const { media_id, media_caption, media_thumbnail, keywords, initial_message, link_message } = req.body;
  if (!media_id || !keywords || !initial_message || !link_message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = db.createRule({ media_id, media_caption, media_thumbnail, keywords, initial_message, link_message });
  res.json({ success: true, id });
});

/** Update rule */
app.put('/api/rules/:id', (req, res) => {
  const { keywords, initial_message, link_message, active } = req.body;
  db.updateRule(req.params.id, { keywords, initial_message, link_message, active });
  res.json({ success: true });
});

/** Delete rule */
app.delete('/api/rules/:id', (req, res) => {
  db.deleteRule(req.params.id);
  res.json({ success: true });
});

/** Activity logs */
app.get('/api/logs', (req, res) => {
  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;
  res.json({ logs: db.getLogs(limit, offset), total: db.getLogsCount() });
});

/** Dashboard stats */
app.get('/api/stats', (_req, res) => res.json(db.getStats()));

/** Subscribe webhook programmatically */
app.post('/api/subscribe-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl is required' });

  console.log(`\n📡  Subscribing webhook: ${webhookUrl}`);
  try {
    const result = await ig.subscribeWebhook(webhookUrl, VERIFY_TOKEN);
    console.log('✅  Webhook subscribed:', JSON.stringify(result));
    res.json({ success: true, result });
  } catch (e) {
    const detail = e.response?.data || e.message;
    console.error('❌  Webhook subscribe failed:', JSON.stringify(detail));
    res.status(500).json({ error: e.message, detail });
  }
});

/** Also subscribe the IG user to receive webhook events */
app.post('/api/subscribe-page', async (_req, res) => {
  console.log('\n🔌  Subscribing Instagram account to webhook events...');
  try {
    const result = await ig.subscribePage();
    console.log('✅  Account subscribed:', JSON.stringify(result));
    res.json({ success: true, result });
  } catch (e) {
    const detail = e.response?.data || e.message;
    console.error('❌  Account subscribe failed:', JSON.stringify(detail));
    res.status(500).json({ error: e.message, detail });
  }
});

/** Test: send a DM manually */
app.post('/api/test-dm', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });
  try {
    await ig.sendDM(userId, message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Serve the SPA for any unmatched route */
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─────────────────────────────────────────
//  COMMENT POLLER  (runs every 2 minutes)
//  Fallback for when webhooks miss events
// ─────────────────────────────────────────
const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes
const seenComments  = new Set();      // avoid reprocessing same comment

async function pollComments() {
  console.log('\n🔄  Polling comments...');
  try {
    const rules = db.getAllRules().filter(r => r.active);
    if (!rules.length) { console.log('   No active rules found'); return; }

    const mediaIds = [...new Set(rules.map(r => r.media_id))];
    console.log(`   Checking ${mediaIds.length} reel(s): ${mediaIds.join(', ')}`);

    for (const mediaId of mediaIds) {
      try {
        const comments = await ig.getComments(mediaId);
        console.log(`   Media ${mediaId} → ${comments.length} comment(s) found`);

        if (comments.length > 0) {
          console.log('   Comments:', JSON.stringify(comments.slice(0, 3), null, 2));
        }

        const mediaRules = db.getRulesForMedia(mediaId);

        for (const comment of comments) {
          if (seenComments.has(comment.id)) continue;
          seenComments.add(comment.id);

          const userId   = comment.id; // use comment ID as user reference
          const username = comment.username || 'unknown';
          const text     = comment.text || '';

          console.log(`   New comment from @${username}: "${text}"`);

          for (const rule of mediaRules) {
            const keywords = rule.keywords.split(',').map(k => k.trim().toLowerCase());
            const matched  = keywords.find(kw => text.toLowerCase().includes(kw));
            if (!matched) continue;
            if (db.hasBeenDMed(mediaId, userId)) {
              console.log(`   Already DM'd @${username}, skipping`);
              continue;
            }

            try {
              await ig.sendDM(userId, rule.initial_message);
              db.logDM({
                rule_id: rule.id, media_id: mediaId,
                user_id: userId, username,
                comment_id: comment.id, comment_text: text,
                keyword_matched: matched, status: 'awaiting_follow',
              });
              console.log(`✉️  [POLL] DM sent to @${username} (keyword: "${matched}")`);
            } catch (err) {
              console.error(`❌  [POLL] Failed to DM @${username}:`, err.message);
            }
            break;
          }
        }
      } catch (err) {
        console.error(`❌  Error fetching comments for media ${mediaId}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('❌  Poller error:', err.message);
  }
  console.log('   Poll complete.\n');
}

// ─────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────
db.init();
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Instagram DM Automation Tool  🚀       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Dashboard  →  http://localhost:${PORT}`);
  console.log(`  Webhook    →  http://localhost:${PORT}/webhook`);
  console.log(`  Token      →  ${VERIFY_TOKEN}`);
  console.log(`  Poller     →  every 2 minutes\n`);

  // Run immediately on start, then every 2 minutes
  pollComments();
  setInterval(pollComments, POLL_INTERVAL);
});
