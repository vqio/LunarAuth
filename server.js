const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper functions
function nowIso() {
  return new Date().toISOString();
}

function safe(v) {
  return String(v ?? '');
}

function parseDurMs(input) {
  const raw = safe(input).trim().toLowerCase();
  const m = raw.match(/^([0-9]+)\s*([smhdw])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2];
  const mult = u === 's' ? 1000 : u === 'm' ? 60000 : u === 'h' ? 3600000 : u === 'd' ? 86400000 : 604800000;
  return n * mult;
}

function computeRemainingMs(key, nowMs, appPaused) {
  if (!key) return 0;
  const paused = !!key.paused || !!appPaused;
  if (!key.started_at) return Math.max(0, key.remaining_ms ?? 0);
  if (paused) return Math.max(0, key.remaining_ms ?? 0);
  const last = key.last_tick_at ? new Date(key.last_tick_at).getTime() : null;
  if (last == null || Number.isNaN(last)) return Math.max(0, key.remaining_ms ?? 0);
  const elapsed = Math.max(0, nowMs - last);
  return Math.max(0, (key.remaining_ms ?? 0) - elapsed);
}

// Generate random string
function generateRandomString(length, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate key format
function generateKey(prefix = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return prefix ? prefix + key : key;
}

// API Handler: Validate key
async function handleValidate(req, res, query) {
  // Get Secret ID from header or query parameter
  let secretId = '';
  if (req.headers['x-auth-secret']) {
    secretId = safe(req.headers['x-auth-secret']).trim();
  } else {
    const headerKeys = Object.keys(req.headers);
    for (const k of headerKeys) {
      if (k.toLowerCase() === 'x-auth-secret') {
        secretId = safe(req.headers[k] || '').trim();
        break;
      }
    }
  }
  if (!secretId) {
    secretId = safe(query.secret || '').trim();
  }

  const key = safe(query.key).trim();
  const hwid = safe(query.hwid).trim();

  console.log('=== DEBUG VALIDATE ===');
  console.log('Secret ID received:', secretId ? secretId.substring(0, 8) + '...' : 'EMPTY');
  console.log('Key received:', key ? key.substring(0, 10) + '...' : 'EMPTY');
  console.log('HWID received:', hwid ? hwid.substring(0, 10) + '...' : 'EMPTY');

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required', code: 'INVALID_SECRET' }));
    return;
  }

  // Validate Secret ID and get user
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('secret_id', secretId)
    .single();

  if (userError || !user) {
    console.log('Secret ID not found!');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  console.log('User found:', user.username || user.email);

  // Get all accessible apps for this user
  let accessibleApps = [];
  if (user.role === 'admin') {
    const { data: apps } = await supabase.from('apps').select('*');
    accessibleApps = apps || [];
  } else {
    // Own apps
    const { data: ownApps } = await supabase.from('apps').select('*').eq('owner_user_id', user.id);
    accessibleApps.push(...(ownApps || []));
    
    // Reseller apps
    const { data: resellerEntries } = await supabase.from('resellers').select('app_id').eq('reseller_user_id', user.id);
    if (resellerEntries && resellerEntries.length > 0) {
      const appIds = resellerEntries.map(r => r.app_id);
      const { data: resellerApps } = await supabase.from('apps').select('*').in('id', appIds);
      accessibleApps.push(...(resellerApps || []));
    }
  }

  // Find key in accessible apps
  let keyObj = null;
  let app = null;

  for (const accessibleApp of accessibleApps) {
    const { data: foundKey } = await supabase
      .from('keys')
      .select('*')
      .eq('key', key)
      .eq('app_id', accessibleApp.id)
      .single();

    if (foundKey) {
      keyObj = foundKey;
      app = accessibleApp;
      break;
    }
  }

  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid or not found key', code: 'KEY_NOT_FOUND' }));
    return;
  }

  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'App not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  // Check if app is active
  if (app.status !== 'on') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'App paused', code: 'APP_PAUSED' }));
    return;
  }

  // Update last Secret ID usage
  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  if (keyObj.paused) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key paused', code: 'KEY_PAUSED' }));
    return;
  }

  const now = Date.now();
  const appPaused = app.status !== 'on';

  // Check HWID
  if (!hwid) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'HWID is required', code: 'HWID_REQUIRED' }));
    return;
  }

  // First use - bind HWID and start counter
  if (!keyObj.hwid && hwid) {
    const updates = {
      hwid: hwid,
      first_used_at: nowIso(),
    };
    if (!keyObj.started_at) {
      updates.started_at = nowIso();
      updates.last_tick_at = nowIso();
      if (typeof keyObj.remaining_ms !== 'number') {
        updates.remaining_ms = keyObj.duration_ms || 0;
      }
    }
    await supabase.from('keys').update(updates).eq('id', keyObj.id);
    
    const remaining = computeRemainingMs({ ...keyObj, ...updates }, now, appPaused);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ 
      success: true, 
      message: 'Valid key', 
      code: 'OK',
      remaining: Math.floor(remaining / 1000)
    }));
    return;
  }

  // Calculate remaining time
  const last = keyObj.last_tick_at ? new Date(keyObj.last_tick_at).getTime() : null;
  if (keyObj.started_at && !keyObj.paused && last != null && !Number.isNaN(last)) {
    const elapsed = Math.max(0, now - last);
    if (elapsed > 0) {
      const newRemaining = Math.max(0, (keyObj.remaining_ms || 0) - elapsed);
      await supabase.from('keys').update({ 
        remaining_ms: newRemaining, 
        last_tick_at: nowIso() 
      }).eq('id', keyObj.id);
      keyObj.remaining_ms = newRemaining;
      keyObj.last_tick_at = nowIso();
    }
  }

  // Check if expired
  const remaining = computeRemainingMs(keyObj, now, appPaused);
  if (remaining <= 0 && keyObj.started_at) {
    await supabase.from('keys').update({ remaining_ms: 0, last_tick_at: null }).eq('id', keyObj.id);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key expired', code: 'KEY_EXPIRED' }));
    return;
  }

  // Check HWID mismatch
  if (keyObj.hwid && keyObj.hwid !== hwid) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'This key is already in use on another device', code: 'HWID_MISMATCH' }));
    return;
  }

  const finalRemaining = computeRemainingMs(keyObj, now, appPaused);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true, 
    message: 'Valid key', 
    code: 'OK',
    remaining: Math.floor(finalRemaining / 1000)
  }));
}

// API Handler: Pause/unpause key
async function handlePauseKey(req, res, data) {
  const secretId = safe(data.secretId || '').trim();
  const key = safe(data.key || '').trim();
  const paused = data.paused === true;

  console.log(`[PAUSE-KEY] Received: secretId=${secretId.substring(0, 10)}... | key=${key.substring(0, 15)}... | paused=${paused}`);

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required' }));
    return;
  }

  // Validate Secret ID
  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  // Find key
  let { data: keyObj } = await supabase.from('keys').select('*').eq('key', key).single();
  if (!keyObj) {
    // Try without hyphens
    const { data: allKeys } = await supabase.from('keys').select('*');
    keyObj = (allKeys || []).find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
  }
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key not found', code: 'KEY_NOT_FOUND' }));
    return;
  }

  // Get app
  const { data: app } = await supabase.from('apps').select('*').eq('id', keyObj.app_id).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  // Check access
  let hasAccess = false;
  if (user.role === 'admin') {
    hasAccess = true;
  } else if (app.owner_user_id === user.id) {
    hasAccess = true;
  } else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', keyObj.app_id).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to manage this key', code: 'NO_PERMISSION' }));
    return;
  }

  const now = Date.now();
  const updates = { paused };

  // If pausing and was running, update remaining time
  if (paused && keyObj.started_at && !keyObj.paused) {
    const last = keyObj.last_tick_at ? new Date(keyObj.last_tick_at).getTime() : null;
    if (last != null && !Number.isNaN(last)) {
      const elapsed = Math.max(0, now - last);
      if (elapsed > 0) {
        updates.remaining_ms = Math.max(0, (keyObj.remaining_ms || 0) - elapsed);
      }
    }
    updates.last_tick_at = nowIso();
  }

  // If unpausing and not started, start now
  if (!paused && !keyObj.started_at) {
    updates.started_at = nowIso();
    updates.last_tick_at = nowIso();
    if (typeof keyObj.remaining_ms !== 'number') {
      updates.remaining_ms = keyObj.duration_ms || 0;
    }
  }

  // If unpausing, update last_tick_at
  if (!paused && keyObj.started_at) {
    updates.last_tick_at = nowIso();
  }

  await supabase.from('keys').update(updates).eq('id', keyObj.id);
  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  const remaining = computeRemainingMs({ ...keyObj, ...updates }, now, false);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true, 
    paused: updates.paused,
    remaining: Math.floor(remaining / 1000),
    key: keyObj.key
  }));
}

// API Handler: Reset key
async function handleResetKey(req, res, data) {
  const secretId = safe(data.secretId || '').trim();
  const key = safe(data.key || '').trim();

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required' }));
    return;
  }

  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  let { data: keyObj } = await supabase.from('keys').select('*').eq('key', key).single();
  if (!keyObj) {
    const { data: allKeys } = await supabase.from('keys').select('*');
    keyObj = (allKeys || []).find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
  }
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key not found', code: 'KEY_NOT_FOUND' }));
    return;
  }

  const { data: app } = await supabase.from('apps').select('*').eq('id', keyObj.app_id).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  let hasAccess = false;
  if (user.role === 'admin') hasAccess = true;
  else if (app.owner_user_id === user.id) hasAccess = true;
  else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', keyObj.app_id).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to manage this key', code: 'NO_PERMISSION' }));
    return;
  }

  await supabase.from('keys').update({
    remaining_ms: keyObj.duration_ms || 0,
    started_at: null,
    last_tick_at: null,
    paused: false,
    hwid: null,
    first_used_at: null
  }).eq('id', keyObj.id);

  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true, 
    remaining: Math.floor((keyObj.duration_ms || 0) / 1000)
  }));
}

// API Handler: Reset HWID
async function handleResetHwid(req, res, data) {
  const secretId = safe(data.secretId || '').trim();
  const key = safe(data.key || '').trim();

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required' }));
    return;
  }

  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  let { data: keyObj } = await supabase.from('keys').select('*').eq('key', key).single();
  if (!keyObj) {
    const { data: allKeys } = await supabase.from('keys').select('*');
    keyObj = (allKeys || []).find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
  }
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key not found', code: 'KEY_NOT_FOUND' }));
    return;
  }

  const { data: app } = await supabase.from('apps').select('*').eq('id', keyObj.app_id).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  let hasAccess = false;
  if (user.role === 'admin') hasAccess = true;
  else if (app.owner_user_id === user.id) hasAccess = true;
  else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', keyObj.app_id).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to manage this key', code: 'NO_PERMISSION' }));
    return;
  }

  await supabase.from('keys').update({ hwid: null, first_used_at: null }).eq('id', keyObj.id);
  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, message: 'HWID reset successfully' }));
}

// API Handler: Delete key
async function handleDeleteKey(req, res, data) {
  const secretId = safe(data.secretId || '').trim();
  const key = safe(data.key || '').trim();

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required' }));
    return;
  }

  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  let { data: keyObj } = await supabase.from('keys').select('*').eq('key', key).single();
  if (!keyObj) {
    const { data: allKeys } = await supabase.from('keys').select('*');
    keyObj = (allKeys || []).find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
  }
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key not found', code: 'KEY_NOT_FOUND' }));
    return;
  }

  const { data: app } = await supabase.from('apps').select('*').eq('id', keyObj.app_id).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  let hasAccess = false;
  if (user.role === 'admin') hasAccess = true;
  else if (app.owner_user_id === user.id) hasAccess = true;
  else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', keyObj.app_id).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to delete this key', code: 'NO_PERMISSION' }));
    return;
  }

  await supabase.from('keys').delete().eq('id', keyObj.id);
  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, message: 'Key deleted successfully' }));
}

// API Handler: Key status
async function handleKeyStatus(req, res, query) {
  const secretId = safe(query.secretId || '').trim();
  const key = safe(query.key || '').trim();

  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID and Key are required' }));
    return;
  }

  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  const { data: keyObj } = await supabase.from('keys').select('*').eq('key', key).single();
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Key not found', code: 'KEY_NOT_FOUND' }));
    return;
  }

  const { data: app } = await supabase.from('apps').select('*').eq('id', keyObj.app_id).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  let hasAccess = false;
  if (user.role === 'admin') hasAccess = true;
  else if (app.owner_user_id === user.id) hasAccess = true;
  else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', keyObj.app_id).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to access this key', code: 'NO_PERMISSION' }));
    return;
  }

  const now = Date.now();
  const appPaused = app.status !== 'on';
  const remaining = computeRemainingMs(keyObj, now, appPaused);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true,
    key: keyObj.key,
    paused: keyObj.paused || false,
    remaining: Math.floor(remaining / 1000),
    duration: Math.floor((keyObj.duration_ms || 0) / 1000),
    startedAt: keyObj.started_at,
    lastTickAt: keyObj.last_tick_at
  }));
}

// API Handler: Create key
async function handleCreateKey(req, res, data) {
  const secretId = safe(data.secretId || '').trim();
  const appId = safe(data.appId || '').trim();
  const duration = safe(data.duration || '').trim();
  const name = safe(data.name || '').trim();

  if (!secretId || !appId || !duration) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID, AppID and duration are required' }));
    return;
  }

  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid Secret ID', code: 'INVALID_SECRET' }));
    return;
  }

  const { data: app } = await supabase.from('apps').select('*').eq('id', appId).single();
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'AppID not found', code: 'APP_NOT_FOUND' }));
    return;
  }

  let hasAccess = false;
  if (user.role === 'admin') hasAccess = true;
  else if (app.owner_user_id === user.id) hasAccess = true;
  else {
    const { data: reseller } = await supabase.from('resellers').select('*').eq('reseller_user_id', user.id).eq('app_id', appId).single();
    if (reseller) hasAccess = true;
  }

  if (!hasAccess) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'No permission to create keys for this AppID', code: 'NO_PERMISSION' }));
    return;
  }

  const durationMs = parseDurMs(duration);
  if (durationMs == null) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Invalid duration. Use format: 1s, 1m, 1h, 1d, 1w', code: 'INVALID_DURATION' }));
    return;
  }

  const prefix = user.key_prefix || '';
  const key = generateKey(prefix);

  const { data: newKey, error } = await supabase.from('keys').insert({
    key: key,
    app_id: appId,
    name: name || `Key ${key.substring(0, 8)}`,
    duration_input: duration,
    duration_ms: durationMs,
    remaining_ms: durationMs,
    paused: false,
    paused_by_app: false,
    hwid: null,
    first_used_at: null,
    started_at: null,
    last_tick_at: null,
    created_by: user.id
  }).select().single();

  if (error) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Failed to create key', error: error.message }));
    return;
  }

  await supabase.from('users').update({ secret_last_used_at: nowIso() }).eq('id', user.id);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true, 
    key: newKey.key,
    keyId: newKey.id,
    duration: duration,
    remaining: Math.floor(durationMs / 1000)
  }));
}

// API Handler: Get/Save DB (for dashboard compatibility)
async function handleGetDB(req, res) {
  const { data: users } = await supabase.from('users').select('*');
  const { data: apps } = await supabase.from('apps').select('*');
  const { data: keys } = await supabase.from('keys').select('*');
  const { data: resellers } = await supabase.from('resellers').select('*');

  // Transform to camelCase for frontend compatibility
  const transformedUsers = (users || []).map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    password: u.password,
    role: u.role,
    secretId: u.secret_id,
    secretLastUsedAt: u.secret_last_used_at,
    keyPrefix: u.key_prefix,
    createdAt: u.created_at
  }));

  const transformedApps = (apps || []).map(a => ({
    id: a.id,
    name: a.name,
    status: a.status,
    ownerUserId: a.owner_user_id,
    createdAt: a.created_at
  }));

  const transformedKeys = (keys || []).map(k => ({
    id: k.id,
    key: k.key,
    appId: k.app_id,
    name: k.name,
    durationInput: k.duration_input,
    durationMs: k.duration_ms,
    remainingMs: k.remaining_ms,
    paused: k.paused,
    pausedByApp: k.paused_by_app,
    hwid: k.hwid,
    firstUsedAt: k.first_used_at,
    startedAt: k.started_at,
    lastTickAt: k.last_tick_at,
    createdAt: k.created_at,
    createdBy: k.created_by
  }));

  const transformedResellers = (resellers || []).map(r => ({
    id: r.id,
    resellerUserId: r.reseller_user_id,
    appId: r.app_id,
    createdAt: r.created_at
  }));

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    users: transformedUsers,
    apps: transformedApps,
    keys: transformedKeys,
    resellers: transformedResellers
  }));
}

async function handleSaveDB(req, res, data) {
  try {
    // Process users
    if (data.users && Array.isArray(data.users)) {
      for (const u of data.users) {
        const secretId = u.secretId || generateRandomString(15);
        const userData = {
          id: u.id,
          username: u.username,
          email: u.email,
          password: u.password,
          role: u.role || 'user',
          secret_id: secretId,
          secret_last_used_at: u.secretLastUsedAt || null,
          key_prefix: u.keyPrefix || null
        };
        
        await supabase.from('users').upsert(userData, { onConflict: 'id' });
      }
      
      // Delete users not in the list
      const userIds = data.users.map(u => u.id);
      if (userIds.length > 0) {
        await supabase.from('users').delete().not('id', 'in', `(${userIds.join(',')})`);
      }
    }

    // Process apps
    if (data.apps && Array.isArray(data.apps)) {
      for (const a of data.apps) {
        const appData = {
          id: a.id,
          name: a.name,
          status: a.status || 'on',
          owner_user_id: a.ownerUserId
        };
        await supabase.from('apps').upsert(appData, { onConflict: 'id' });
      }
      
      const appIds = data.apps.map(a => a.id);
      if (appIds.length > 0) {
        await supabase.from('apps').delete().not('id', 'in', `(${appIds.join(',')})`);
      }
    }

    // Process keys
    if (data.keys && Array.isArray(data.keys)) {
      for (const k of data.keys) {
        const keyData = {
          id: k.id,
          key: k.key,
          app_id: k.appId,
          name: k.name,
          duration_input: k.durationInput,
          duration_ms: k.durationMs || 0,
          remaining_ms: k.remainingMs || 0,
          paused: k.paused || false,
          paused_by_app: k.pausedByApp || false,
          hwid: k.hwid || null,
          first_used_at: k.firstUsedAt || null,
          started_at: k.startedAt || null,
          last_tick_at: k.lastTickAt || null,
          created_by: k.createdBy || null
        };
        await supabase.from('keys').upsert(keyData, { onConflict: 'id' });
      }
      
      const keyIds = data.keys.map(k => k.id);
      if (keyIds.length > 0) {
        await supabase.from('keys').delete().not('id', 'in', `(${keyIds.join(',')})`);
      }
    }

    // Process resellers
    if (data.resellers && Array.isArray(data.resellers)) {
      // Clear existing resellers and re-add
      await supabase.from('resellers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      
      for (const r of data.resellers) {
        await supabase.from('resellers').insert({
          reseller_user_id: r.resellerUserId,
          app_id: r.appId
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));
  } catch (e) {
    console.error('Error saving DB:', e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Secret');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // API routes
    if (parsedUrl.pathname === '/api/validate' && req.method === 'GET') {
      await handleValidate(req, res, parsedUrl.query);
      return;
    }

    if (parsedUrl.pathname === '/api/pause-key' && req.method === 'POST') {
      const data = await parseBody(req);
      await handlePauseKey(req, res, data);
      return;
    }

    if (parsedUrl.pathname === '/api/reset-key' && req.method === 'POST') {
      const data = await parseBody(req);
      await handleResetKey(req, res, data);
      return;
    }

    if (parsedUrl.pathname === '/api/reset-hwid' && req.method === 'POST') {
      const data = await parseBody(req);
      await handleResetHwid(req, res, data);
      return;
    }

    if (parsedUrl.pathname === '/api/delete-key' && req.method === 'POST') {
      const data = await parseBody(req);
      await handleDeleteKey(req, res, data);
      return;
    }

    if (parsedUrl.pathname === '/api/key-status' && req.method === 'GET') {
      await handleKeyStatus(req, res, parsedUrl.query);
      return;
    }

    if (parsedUrl.pathname === '/api/create-key' && req.method === 'POST') {
      const data = await parseBody(req);
      await handleCreateKey(req, res, data);
      return;
    }

    if (parsedUrl.pathname === '/db.json' && req.method === 'GET') {
      await handleGetDB(req, res);
      return;
    }

    if (parsedUrl.pathname === '/db.json' && req.method === 'POST') {
      const data = await parseBody(req);
      await handleSaveDB(req, res, data);
      return;
    }

    // Serve static files
    let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
    filePath = path.join(__dirname, filePath);

    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('404 Not Found');
        } else {
          res.writeHead(500);
          res.end('500 Internal Server Error');
        }
      } else {
        const ext = path.extname(filePath);
        const contentType = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml'
        }[ext] || 'application/octet-stream';
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  } catch (e) {
    console.error('Server error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`LunarAuth server running at http://localhost:${PORT}`);
  console.log(`Validation API: http://localhost:${PORT}/api/validate`);
  console.log('Using Supabase as database backend');
});
