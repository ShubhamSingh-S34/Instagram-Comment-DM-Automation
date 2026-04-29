/**
 * instagram.js — Instagram Graph API wrapper
 *
 * Endpoints used:
 *  GET  /me                       → profile info
 *  GET  /me/media                 → reels / posts
 *  POST /{ig-user-id}/messages    → send DM  (Messaging API)
 *  POST /{app-id}/subscriptions   → register webhook
 *  POST /me/subscribed_apps       → subscribe page to webhook fields
 */
const axios = require('axios');

const IG_BASE = 'https://graph.instagram.com';
const FB_BASE = 'https://graph.facebook.com/v21.0';
const TOKEN   = process.env.INSTAGRAM_TOKEN;
const APP_ID  = process.env.APP_ID;
const APP_SEC = process.env.APP_SECRET;

// Cache the IG user-id so we don't call /me on every DM
let _igUserId = null;

// ─────────────────────────────────────────
//  PROFILE
// ─────────────────────────────────────────
async function getProfile() {
  const { data } = await axios.get(`${IG_BASE}/me`, {
    params: {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count',
      access_token: TOKEN,
    },
  });
  _igUserId = data.id;
  return data;
}

// ─────────────────────────────────────────
//  REELS / MEDIA
// ─────────────────────────────────────────
async function getReels(limit = 25) {
  const { data } = await axios.get(`${IG_BASE}/me/media`, {
    params: {
      fields: 'id,media_type,thumbnail_url,media_url,timestamp,caption,permalink,like_count,comments_count',
      limit,
      access_token: TOKEN,
    },
  });

  const all = data.data || [];
  // Keep only VIDEO / REEL types (reels show up as VIDEO in the API)
  return all.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REEL');
}

// ─────────────────────────────────────────
//  SEND DM
// ─────────────────────────────────────────
async function sendDM(recipientIgsid, text) {
  // We need the business account's IG user ID as the sender
  if (!_igUserId) {
    const profile = await getProfile();
    _igUserId = profile.id;
  }

  const { data } = await axios.post(
    `${FB_BASE}/${_igUserId}/messages`,
    {
      recipient: { id: recipientIgsid },
      message:   { text },
    },
    {
      params: { access_token: TOKEN },
    }
  );

  return data;
}

// ─────────────────────────────────────────
//  WEBHOOK SUBSCRIPTION
// ─────────────────────────────────────────

/**
 * Subscribe the Meta app to Instagram webhooks.
 * Meta requires form-encoded body (NOT JSON) for this endpoint.
 */
async function subscribeWebhook(callbackUrl, verifyToken) {
  const appToken = `${APP_ID}|${APP_SEC}`;

  // Must be sent as application/x-www-form-urlencoded
  const body = new URLSearchParams({
    object:       'instagram',
    callback_url: callbackUrl,
    verify_token: verifyToken,
    fields:       'comments,messages',
    access_token: appToken,
  });

  const { data } = await axios.post(
    `${FB_BASE}/${APP_ID}/subscriptions`,
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return data;
}

/**
 * Subscribe the connected Instagram account to start
 * receiving webhook events.
 * Uses graph.instagram.com (NOT graph.facebook.com) with the Instagram token.
 */
async function subscribePage() {
  // First get the IG user ID
  if (!_igUserId) {
    const profile = await getProfile();
    _igUserId = profile.id;
  }

  const body = new URLSearchParams({
    subscribed_fields: 'comments,messages',
    access_token:      TOKEN,
  });

  const { data } = await axios.post(
    `${IG_BASE}/${_igUserId}/subscribed_apps`,
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

// ─────────────────────────────────────────
//  COMMENTS  (manual fetch – for debugging)
// ─────────────────────────────────────────
async function getComments(mediaId) {
  const { data } = await axios.get(`${IG_BASE}/${mediaId}/comments`, {
    params: {
      fields: 'id,text,username,timestamp',
      access_token: TOKEN,
    },
  });
  return data.data || [];
}

module.exports = { getProfile, getReels, sendDM, subscribeWebhook, subscribePage, getComments };
