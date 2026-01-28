const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Funções auxiliares
function nowIso() {
  return new Date().toISOString();
}

function safe(v) {
  return String(v ?? '');
}

function loadDB() {
  try {
    // Sempre tenta carregar de db.json primeiro (servidor)
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const db = JSON.parse(raw);
      db.users = db.users || [];
      db.apps = db.apps || [];
      db.keys = db.keys || [];
      db.resellers = db.resellers || [];
      
      // Migração para novo modelo de tempo
      const now = Date.now();
      db.keys.forEach(k => {
        if (typeof k.durationMs !== 'number') {
          const ms = parseDurMs(k.durationInput);
          k.durationMs = ms == null ? 0 : ms;
        }
        if (typeof k.remainingMs !== 'number') {
          if (k.firstUsedAt) {
            const legacyExpires = k.expiresAt ? new Date(k.expiresAt).getTime() : null;
            const rem = legacyExpires == null ? Math.max(0, k.durationMs) : Math.max(0, legacyExpires - now);
            k.remainingMs = rem;
            k.startedAt = k.startedAt || k.firstUsedAt;
            k.lastTickAt = k.lastTickAt || nowIso();
          } else {
            k.remainingMs = k.durationMs;
            k.startedAt = null;
            k.lastTickAt = null;
          }
        }
        if (typeof k.pausedByApp !== 'boolean') k.pausedByApp = false;
      });
      
      // Garante que todos os usuários têm Secret ID
      let dbChanged = false;
      db.users.forEach(u => {
        if (typeof u.secretId !== 'string' || !u.secretId) {
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
          let secretId = '';
          for (let i = 0; i < 15; i++) {
            secretId += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          u.secretId = secretId;
          dbChanged = true;
        }
        if (typeof u.secretLastUsedAt !== 'string') u.secretLastUsedAt = null;
      });
      
      // Salva se houve mudanças
      if (dbChanged) {
        saveDB(db);
      }
      
      return db;
    }
  } catch (e) {
    console.error('Erro ao carregar DB:', e);
  }
  
  return { users: [], apps: [], keys: [], resellers: [] };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Erro ao salvar DB:', e);
    return false;
  }
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
  if (!key.startedAt) return Math.max(0, key.remainingMs ?? 0);
  if (paused) return Math.max(0, key.remainingMs ?? 0);
  const last = key.lastTickAt ? new Date(key.lastTickAt).getTime() : null;
  if (last == null || Number.isNaN(last)) return Math.max(0, key.remainingMs ?? 0);
  const elapsed = Math.max(0, nowMs - last);
  return Math.max(0, (key.remainingMs ?? 0) - elapsed);
}

function persistTick(db, key, nowMs, appPaused) {
  if (!key) return false;
  const paused = !!key.paused || !!appPaused;
  if (!key.startedAt || paused) return false;
  const last = key.lastTickAt ? new Date(key.lastTickAt).getTime() : null;
  if (last == null || Number.isNaN(last)) {
    key.lastTickAt = nowIso();
    return true;
  }
  const elapsed = Math.max(0, nowMs - last);
  if (elapsed <= 0) return false;
  const next = Math.max(0, (key.remainingMs ?? 0) - elapsed);
  if (next === key.remainingMs) return false;
  key.remainingMs = next;
  key.lastTickAt = nowIso();
  return true;
}

// Função para validar Secret ID
function validateSecretId(db, secretId, appId) {
  const user = db.users.find(u => u.secretId === secretId);
  if (!user) {
    return { valid: false, reason: 'INVALID_SECRET' };
  }
  
  // Verifica se o usuário tem acesso ao AppID
  const apps = [];
  if (user.role === 'admin') {
    apps.push(...db.apps);
  } else {
    apps.push(...db.apps.filter(a => a.ownerUserId === user.id));
    apps.push(...db.apps.filter(a => 
      db.resellers.some(r => r.resellerUserId === user.id && r.appId === a.id)
    ));
  }
  
  const allowed = apps.some(a => a.id === appId);
  if (!allowed) {
    return { valid: false, reason: 'SECRET_APP_MISMATCH' };
  }
  
  // Atualiza último uso do Secret ID
  user.secretLastUsedAt = nowIso();
  saveDB(db);
  
  return { valid: true, userId: user.id };
}

// API de validação simplificada (usa apenas Secret ID + Key)
function handleValidate(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  
  // Obtém Secret ID do header ou query parameter
  // Node.js converte headers para lowercase automaticamente
  let secretId = '';
  
  // Tenta pegar do header (Node.js converte para lowercase, mas vamos verificar ambos)
  if (req.headers['x-auth-secret']) {
    secretId = safe(req.headers['x-auth-secret']).trim();
  } else {
    // Tenta todas as variações possíveis do header
    const headerKeys = Object.keys(req.headers);
    for (const key of headerKeys) {
      if (key.toLowerCase() === 'x-auth-secret') {
        secretId = safe(req.headers[key] || '').trim();
        break;
      }
    }
  }
  
  // Fallback para query parameter se não encontrou no header
  if (!secretId) {
    secretId = safe(query.secret || '').trim();
  }
  
  const key = safe(query.key).trim();
  const hwid = safe(query.hwid).trim();
  
  // Debug: log para verificar o que está chegando
  console.log('=== DEBUG VALIDATE ===');
  console.log('Headers recebidos:', Object.keys(req.headers));
  console.log('Secret ID recebido:', secretId ? secretId.substring(0, 8) + '...' : 'VAZIO');
  console.log('Key recebida:', key ? key.substring(0, 10) + '...' : 'VAZIO');
  console.log('HWID recebido:', hwid ? hwid.substring(0, 10) + '...' : 'VAZIO');
  
  // Validação básica
  if (!secretId || !key) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios', code: 'INVALID_SECRET' }));
    return;
  }
  
  const db = loadDB();
  
  // Debug: lista todos os Secret IDs no banco
  console.log('Secret IDs no banco:', db.users.map(u => u.secretId ? u.secretId.substring(0, 8) + '...' : 'SEM SECRET'));
  
  // Valida Secret ID e obtém o usuário (comparação exata)
  const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
  if (!user) {
    console.log('Secret ID não encontrado! Procurando:', secretId);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
    return;
  }
  
  console.log('Usuário encontrado:', user.username || user.email);
  
  // Obtém todos os AppIDs que o usuário tem acesso
  let accessibleApps = [];
  if (user.role === 'admin') {
    accessibleApps = db.apps;
  } else {
    // AppIDs próprios
    accessibleApps.push(...db.apps.filter(a => a.ownerUserId === user.id));
    // AppIDs de reseller
    accessibleApps.push(...db.apps.filter(a => 
      db.resellers.some(r => r.resellerUserId === user.id && r.appId === a.id)
    ));
  }
  
  // Procura a key em todos os AppIDs acessíveis
  let keyObj = null;
  let app = null;
  
  for (const accessibleApp of accessibleApps) {
    const foundKey = db.keys.find(k => k.key === key && k.appId === accessibleApp.id);
    if (foundKey) {
      keyObj = foundKey;
      app = accessibleApp;
      break;
    }
  }
  
  // Se não encontrou a key, retorna erro
  if (!keyObj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Chave inválida ou não encontrada', code: 'KEY_NOT_FOUND' }));
    return;
  }
  
  // Se não encontrou o app (não deveria acontecer, mas por segurança)
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Aplicativo não encontrado', code: 'APP_NOT_FOUND' }));
    return;
  }
  
  // Verifica se o app está ativo
  if (app.status !== 'on') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Aplicativo pausado', code: 'APP_PAUSED' }));
    return;
  }
  
  // Atualiza último uso do Secret ID
  user.secretLastUsedAt = nowIso();
  
  if (keyObj.paused) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Chave pausada', code: 'KEY_PAUSED' }));
    return;
  }
  
  const now = Date.now();
  const appPaused = app.status !== 'on';
  
  // Verifica HWID primeiro
  if (!hwid) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'HWID é obrigatório', code: 'HWID_REQUIRED' }));
    return;
  }
  
  // Primeiro uso - bind HWID e inicia contador
  if (!keyObj.hwid && hwid) {
    keyObj.hwid = hwid;
    keyObj.firstUsedAt = nowIso();
    if (!keyObj.startedAt) {
      keyObj.startedAt = nowIso();
      keyObj.lastTickAt = nowIso();
      // Garante que remainingMs está definido
      if (typeof keyObj.remainingMs !== 'number') {
        keyObj.remainingMs = keyObj.durationMs || 0;
      }
    }
    saveDB(db);
    // Calcula o tempo restante após iniciar
    const remaining = computeRemainingMs(keyObj, now, appPaused);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ 
      success: true, 
      message: 'Chave válida', 
      code: 'OK',
      remaining: Math.floor(remaining / 1000)
    }));
    return;
  }
  
  // Atualiza o tempo restante antes de verificar
  persistTick(db, keyObj, now, appPaused);
  
  // Verifica se expirou
  const remaining = computeRemainingMs(keyObj, now, appPaused);
  if (remaining <= 0 && keyObj.startedAt) {
    keyObj.remainingMs = 0;
    keyObj.lastTickAt = null;
    saveDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Chave expirada', code: 'KEY_EXPIRED' }));
    return;
  }
  
  // Verifica se HWID corresponde (apenas se já foi definido)
  if (keyObj.hwid && keyObj.hwid !== hwid) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, message: 'Esta chave já está em uso em outro dispositivo', code: 'HWID_MISMATCH' }));
    return;
  }
  
  // Se chegou aqui, está tudo OK
  // Atualiza o tempo restante novamente antes de retornar
  persistTick(db, keyObj, now, appPaused);
  const finalRemaining = computeRemainingMs(keyObj, now, appPaused);
  
  saveDB(db);
  
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ 
    success: true, 
    message: 'Chave válida', 
    code: 'OK',
    remaining: Math.floor(finalRemaining / 1000)
  }));
}

// Servidor HTTP
const server = http.createServer((req, res) => {
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
  
  // API de validação
  if (parsedUrl.pathname === '/api/validate' && req.method === 'GET') {
    handleValidate(req, res);
    return;
  }
  
  // API para pausar/despausar key usando Secret ID
  if (parsedUrl.pathname === '/api/pause-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const secretId = safe(data.secretId || '').trim();
        const key = safe(data.key || '').trim();
        const paused = data.paused === true;
        
        console.log(`[PAUSE-KEY] Recebido: secretId=${secretId.substring(0, 10)}... | key=${key.substring(0, 15)}... | paused=${paused}`);
        
        if (!secretId || !key) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios' }));
          return;
        }
        
        const db = loadDB();
        
        // Valida Secret ID
        const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
        if (!user) {
          console.log(`[PAUSE-KEY] Secret ID inválido: ${secretId.substring(0, 10)}... | Total users: ${db.users.length}`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
          return;
        }
        
        console.log(`[PAUSE-KEY] User encontrado: ${user.id} | Role: ${user.role}`);
        
        // Encontra a key (busca exata e também por prefixo se necessário)
        let keyObj = db.keys.find(k => k.key === key);
        if (!keyObj) {
          // Tenta encontrar sem hífens ou com formato diferente
          keyObj = db.keys.find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
        }
        if (!keyObj) {
          console.log(`[PAUSE-KEY] Key não encontrada: ${key.substring(0, 10)}... | Total de keys no DB: ${db.keys.length}`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Key não encontrada', code: 'KEY_NOT_FOUND' }));
          return;
        }
        
        console.log(`[PAUSE-KEY] Key encontrada: ${keyObj.key} | AppID: ${keyObj.appId} | Paused atual: ${keyObj.paused}`);
        
        // Verifica permissão (admin ou owner do app ou reseller)
        const app = db.apps.find(a => a.id === keyObj.appId);
        if (!app) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
          return;
        }
        
        let hasAccess = false;
        if (user.role === 'admin') {
          hasAccess = true;
        } else if (app.ownerUserId === user.id) {
          hasAccess = true;
        } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === keyObj.appId)) {
          hasAccess = true;
        }
        
        if (!hasAccess) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Sem permissão para gerenciar esta key', code: 'NO_PERMISSION' }));
          return;
        }
        
        // Atualiza o tempo restante antes de pausar/despausar
        const now = Date.now();
        const appPaused = app.status !== 'on';
        
        // IMPORTANTE: Se estava rodando (não pausado) e vai pausar, atualiza o tempo restante ANTES
        // Isso garante que o tempo seja congelado no valor correto
        if (paused && keyObj.startedAt && !keyObj.paused) {
          // Calcula tempo decorrido desde o último tick
          const last = keyObj.lastTickAt ? new Date(keyObj.lastTickAt).getTime() : null;
          if (last != null && !Number.isNaN(last)) {
            const elapsed = Math.max(0, now - last);
            if (elapsed > 0) {
              // Atualiza o tempo restante antes de pausar
              keyObj.remainingMs = Math.max(0, (keyObj.remainingMs || 0) - elapsed);
            }
          }
          // Atualiza lastTickAt para o momento da pausa
          keyObj.lastTickAt = nowIso();
        }
        
        // Pausa/despausa
        const oldPausedState = keyObj.paused;
        keyObj.paused = paused;
        
        console.log(`[PAUSE-KEY] Key: ${keyObj.key.substring(0, 10)}... | Estado anterior: ${oldPausedState} | Novo estado: ${paused} | Remaining antes: ${keyObj.remainingMs}ms`);
        
        // Se despausando e não tinha startedAt, inicia agora
        if (!paused && !keyObj.startedAt) {
          keyObj.startedAt = nowIso();
          keyObj.lastTickAt = nowIso();
          // Garante que remainingMs está definido
          if (typeof keyObj.remainingMs !== 'number') {
            keyObj.remainingMs = keyObj.durationMs || 0;
          }
        }
        
        // Se despausando, atualiza lastTickAt para o momento atual (reinicia contagem)
        if (!paused && keyObj.startedAt) {
          keyObj.lastTickAt = nowIso();
        }
        
        // Salva o banco ANTES de calcular remaining
        const saveResult = saveDB(db);
        if (!saveResult) {
          console.error('[PAUSE-KEY] Erro ao salvar DB!');
        }
        
        // Atualiza último uso do Secret ID
        user.secretLastUsedAt = nowIso();
        saveDB(db);
        
        const remaining = computeRemainingMs(keyObj, now, false);
        
        console.log(`[PAUSE-KEY] ✅ Key pausada/despausada com sucesso! Key: ${keyObj.key} | Paused: ${keyObj.paused} | Remaining: ${remaining}ms | DB salvo: ${saveResult}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ 
          success: true, 
          paused: keyObj.paused,
          remaining: Math.floor(remaining / 1000),
          key: keyObj.key
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para resetar key usando Secret ID
  if (parsedUrl.pathname === '/api/reset-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const secretId = safe(data.secretId || '').trim();
        const key = safe(data.key || '').trim();
        
        if (!secretId || !key) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios' }));
          return;
        }
        
        const db = loadDB();
        
        // Valida Secret ID
        const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
          return;
        }
        
        // Encontra a key (busca exata e também por prefixo se necessário)
        let keyObj = db.keys.find(k => k.key === key);
        if (!keyObj) {
          keyObj = db.keys.find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
        }
        if (!keyObj) {
          console.log(`[RESET-KEY] Key não encontrada: ${key.substring(0, 10)}...`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Key não encontrada', code: 'KEY_NOT_FOUND' }));
          return;
        }
        
        // Verifica permissão
        const app = db.apps.find(a => a.id === keyObj.appId);
        if (!app) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
          return;
        }
        
        let hasAccess = false;
        if (user.role === 'admin') {
          hasAccess = true;
        } else if (app.ownerUserId === user.id) {
          hasAccess = true;
        } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === keyObj.appId)) {
          hasAccess = true;
        }
        
        if (!hasAccess) {
          console.log(`[RESET-KEY] Sem permissão. User: ${user.id} | App Owner: ${app.ownerUserId}`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Sem permissão para gerenciar esta key', code: 'NO_PERMISSION' }));
          return;
        }
        
        // Reseta a key
        keyObj.remainingMs = keyObj.durationMs || 0;
        keyObj.startedAt = null;
        keyObj.lastTickAt = null;
        keyObj.paused = false;
        keyObj.hwid = null;
        keyObj.firstUsedAt = null;
        
        const saveResult = saveDB(db);
        console.log(`[RESET-KEY] ✅ Key resetada: ${keyObj.key} | DB salvo: ${saveResult}`);
        
        // Atualiza último uso do Secret ID
        user.secretLastUsedAt = nowIso();
        saveDB(db);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ 
          success: true, 
          remaining: Math.floor(keyObj.remainingMs / 1000)
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para resetar HWID usando Secret ID
  if (parsedUrl.pathname === '/api/reset-hwid' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const secretId = safe(data.secretId || '').trim();
        const key = safe(data.key || '').trim();
        
        if (!secretId || !key) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios' }));
          return;
        }
        
        const db = loadDB();
        
        // Valida Secret ID
        const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
          return;
        }
        
        // Encontra a key
        let keyObj = db.keys.find(k => k.key === key);
        if (!keyObj) {
          keyObj = db.keys.find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
        }
        if (!keyObj) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Key não encontrada', code: 'KEY_NOT_FOUND' }));
          return;
        }
        
        // Verifica permissão
        const app = db.apps.find(a => a.id === keyObj.appId);
        if (!app) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
          return;
        }
        
        let hasAccess = false;
        if (user.role === 'admin') {
          hasAccess = true;
        } else if (app.ownerUserId === user.id) {
          hasAccess = true;
        } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === keyObj.appId)) {
          hasAccess = true;
        }
        
        if (!hasAccess) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Sem permissão para gerenciar esta key', code: 'NO_PERMISSION' }));
          return;
        }
        
        // Reseta apenas o HWID (mantém tempo e status)
        keyObj.hwid = null;
        keyObj.firstUsedAt = null;
        // Não reseta startedAt, lastTickAt, paused, remainingMs
        
        saveDB(db);
        
        // Atualiza último uso do Secret ID
        user.secretLastUsedAt = nowIso();
        saveDB(db);
        
        console.log(`[RESET-HWID] ✅ HWID resetado para key: ${keyObj.key}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ 
          success: true,
          message: 'HWID resetado com sucesso'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para deletar key usando Secret ID
  if (parsedUrl.pathname === '/api/delete-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const secretId = safe(data.secretId || '').trim();
        const key = safe(data.key || '').trim();
        
        if (!secretId || !key) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios' }));
          return;
        }
        
        const db = loadDB();
        
        // Valida Secret ID
        const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
          return;
        }
        
        // Encontra a key
        let keyObj = db.keys.find(k => k.key === key);
        if (!keyObj) {
          keyObj = db.keys.find(k => k.key.replace(/-/g, '') === key.replace(/-/g, ''));
        }
        if (!keyObj) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Key não encontrada', code: 'KEY_NOT_FOUND' }));
          return;
        }
        
        // Verifica permissão
        const app = db.apps.find(a => a.id === keyObj.appId);
        if (!app) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
          return;
        }
        
        let hasAccess = false;
        if (user.role === 'admin') {
          hasAccess = true;
        } else if (app.ownerUserId === user.id) {
          hasAccess = true;
        } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === keyObj.appId)) {
          hasAccess = true;
        }
        
        if (!hasAccess) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Sem permissão para deletar esta key', code: 'NO_PERMISSION' }));
          return;
        }
        
        // Remove a key
        db.keys = db.keys.filter(k => k.id !== keyObj.id);
        saveDB(db);
        
        // Atualiza último uso do Secret ID
        user.secretLastUsedAt = nowIso();
        saveDB(db);
        
        console.log(`[DELETE-KEY] ✅ Key deletada: ${keyObj.key}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ 
          success: true,
          message: 'Key deletada com sucesso'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para obter status da key usando Secret ID
  if (parsedUrl.pathname === '/api/key-status' && req.method === 'GET') {
    const query = parsedUrl.query;
    const secretId = safe(query.secretId || '').trim();
    const key = safe(query.key || '').trim();
    
    if (!secretId || !key) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: 'Secret ID e Key são obrigatórios' }));
      return;
    }
    
    const db = loadDB();
    
    // Valida Secret ID
    const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
    if (!user) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
      return;
    }
    
    // Encontra a key
    const keyObj = db.keys.find(k => k.key === key);
    if (!keyObj) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: 'Key não encontrada', code: 'KEY_NOT_FOUND' }));
      return;
    }
    
    // Verifica permissão
    const app = db.apps.find(a => a.id === keyObj.appId);
    if (!app) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
      return;
    }
    
    let hasAccess = false;
    if (user.role === 'admin') {
      hasAccess = true;
    } else if (app.ownerUserId === user.id) {
      hasAccess = true;
    } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === keyObj.appId)) {
      hasAccess = true;
    }
    
    if (!hasAccess) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: 'Sem permissão para acessar esta key', code: 'NO_PERMISSION' }));
      return;
    }
    
    const now = Date.now();
    const appPaused = app.status !== 'on';
    persistTick(db, keyObj, now, appPaused);
    const remaining = computeRemainingMs(keyObj, now, appPaused);
    
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ 
      success: true,
      key: keyObj.key,
      paused: keyObj.paused || false,
      remaining: Math.floor(remaining / 1000),
      duration: Math.floor((keyObj.durationMs || 0) / 1000),
      startedAt: keyObj.startedAt,
      lastTickAt: keyObj.lastTickAt
    }));
    return;
  }
  
  // API para criar key usando Secret ID
  if (parsedUrl.pathname === '/api/create-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const secretId = safe(data.secretId || '').trim();
        const appId = safe(data.appId || '').trim();
        const duration = safe(data.duration || '').trim(); // ex: "1d"
        const name = safe(data.name || '').trim();
        
        if (!secretId || !appId || !duration) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID, AppID e duração são obrigatórios' }));
          return;
        }
        
        const db = loadDB();
        
        // Valida Secret ID
        const user = db.users.find(u => u.secretId && u.secretId.trim() === secretId.trim());
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Secret ID inválido', code: 'INVALID_SECRET' }));
          return;
        }
        
        // Verifica se o app existe e se o usuário tem acesso
        const app = db.apps.find(a => a.id === appId);
        if (!app) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'AppID não encontrado', code: 'APP_NOT_FOUND' }));
          return;
        }
        
        // Verifica permissão (admin ou owner ou reseller)
        let hasAccess = false;
        if (user.role === 'admin') {
          hasAccess = true;
        } else if (app.ownerUserId === user.id) {
          hasAccess = true;
        } else if (db.resellers.some(r => r.resellerUserId === user.id && r.appId === appId)) {
          hasAccess = true;
        }
        
        if (!hasAccess) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Sem permissão para criar keys neste AppID', code: 'NO_PERMISSION' }));
          return;
        }
        
        // Parse duração
        const durationMs = parseDurMs(duration);
        if (durationMs == null) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: 'Duração inválida. Use formato: 1s, 1m, 1h, 1d, 1w', code: 'INVALID_DURATION' }));
          return;
        }
        
        // Gera key
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let key = '';
        for (let i = 0; i < 16; i++) {
          if (i > 0 && i % 4 === 0) key += '-';
          key += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        // Prefixo do usuário (se tiver)
        const prefix = user.keyPrefix || '';
        if (prefix) {
          key = prefix + key;
        }
        
        // Cria a key
        const keyObj = {
          id: 'key_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
          key: key,
          appId: appId,
          name: name || `Key ${key.substring(0, 8)}`,
          durationInput: duration,
          durationMs: durationMs,
          remainingMs: durationMs,
          paused: false,
          hwid: null,
          firstUsedAt: null,
          startedAt: null,
          lastTickAt: null,
          createdAt: nowIso(),
          createdBy: user.id
        };
        
        db.keys.push(keyObj);
        saveDB(db);
        
        // Atualiza último uso do Secret ID
        user.secretLastUsedAt = nowIso();
        saveDB(db);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ 
          success: true, 
          key: keyObj.key,
          keyId: keyObj.id,
          duration: duration,
          remaining: Math.floor(durationMs / 1000)
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para salvar db.json (usado pelo dashboard quando em localhost)
  if (parsedUrl.pathname === '/db.json' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const db = JSON.parse(body);
        // Garante que todos os usuários têm Secret ID
        db.users.forEach(u => {
          if (typeof u.secretId !== 'string' || !u.secretId) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let secretId = '';
            for (let i = 0; i < 15; i++) {
              secretId += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            u.secretId = secretId;
          }
        });
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API para ler db.json (usado pelo dashboard quando em localhost)
  if (parsedUrl.pathname === '/db.json' && req.method === 'GET') {
    const db = loadDB();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(db));
    return;
  }
  
  // Servir arquivos estáticos
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, filePath);
  
  // Prevenir directory traversal
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
});

server.listen(PORT, () => {
  console.log(`Servidor LunarAuth rodando em http://localhost:${PORT}`);
  console.log(`API de validação: http://localhost:${PORT}/api/validate`);
  
  // Inicializa db.json se não existir
  if (!fs.existsSync(DB_FILE)) {
    const initialDB = { users: [], apps: [], keys: [], resellers: [] };
    saveDB(initialDB);
    console.log('db.json criado com sucesso');
  } else {
    // Verifica e corrige Secret IDs ao iniciar
    const db = loadDB();
    let changed = false;
    db.users.forEach(u => {
      if (typeof u.secretId !== 'string' || !u.secretId) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let secretId = '';
        for (let i = 0; i < 15; i++) {
          secretId += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        u.secretId = secretId;
        changed = true;
        console.log(`Secret ID gerado para usuário: ${u.username || u.email}`);
      }
    });
    if (changed) {
      saveDB(db);
      console.log('Secret IDs corrigidos no banco de dados');
    }
  }
});

