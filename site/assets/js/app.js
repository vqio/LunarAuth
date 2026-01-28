(()=>{
  const DB_KEY='za_db_v1';
  const SESSION_KEY='za_session_v1';
  const ADMIN_EMAIL='ruanrlqcv22@gmail.com';

  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));

  const nowIso=()=>new Date().toISOString();
  const safe=v=>String(v??'');
  const normEmail=v=>safe(v).trim().toLowerCase();
  const normUser=v=>safe(v).trim();
  const uid=p=>`${p}_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0,24);
  const genSecretId=(len=15)=>{
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out='';
    for(let i=0;i<len;i++){
      out+=chars.charAt(Math.floor(Math.random()*chars.length));
    }
    return out;
  };

  function navigateTo(url){
    try{
      document.body.classList.add('is-leaving');
    } catch {}
    setTimeout(()=>{ location.href=url; }, 170);
  }

  function esc(str){
    return safe(str).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
  }

  function loadDB(){
    const isLocal=location.hostname==='localhost' && location.port==='3000';
    if(isLocal){
      try{
        const xhr=new XMLHttpRequest();
        xhr.open('GET','/db.json',false);
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.send(null);
        if(xhr.status===200){
          const db=JSON.parse(xhr.responseText||'{}');
          db.users=db.users||[];
          db.apps=db.apps||[];
          db.keys=db.keys||[];
          db.resellers=db.resellers||[];
          return db;
        }
      }catch{}
    }
    const raw=localStorage.getItem(DB_KEY);
    if(!raw){
      const db={users:[],apps:[],keys:[],resellers:[]};
      localStorage.setItem(DB_KEY,JSON.stringify(db));
      return db;
    }
    try{
      const db=JSON.parse(raw);
      db.users=db.users||[];
      db.apps=db.apps||[];
      db.keys=db.keys||[];
      db.resellers=db.resellers||[];

      // Migração leve para novo modelo de tempo de key
      const now=Date.now();
      db.keys.forEach(k=>{
        if(typeof k.durationMs!=='number'){
          const ms=parseDurMs(k.durationInput);
          k.durationMs=ms==null?0:ms;
        }
        if(typeof k.remainingMs!=='number'){
          if(k.firstUsedAt){
            const legacyExpires=k.expiresAt?new Date(k.expiresAt).getTime():null;
            const rem=legacyExpires==null?Math.max(0,k.durationMs):Math.max(0,legacyExpires-now);
            k.remainingMs=rem;
            k.startedAt=k.startedAt||k.firstUsedAt;
            k.lastTickAt=k.lastTickAt||nowIso();
          } else {
            k.remainingMs=k.durationMs;
            k.startedAt=null;
            k.lastTickAt=null;
          }
        }
        if(typeof k.pausedByApp!=='boolean') k.pausedByApp=false;
      });

      db.users.forEach(u=>{
        if(typeof u.keyPrefix!=='string') u.keyPrefix='';
        if(typeof u.secretId!=='string' || !u.secretId){
          u.secretId=genSecretId(15);
          if(typeof u.secretLastUsedAt!=='string') u.secretLastUsedAt=null;
        }
      });

      return db;
    }catch{
      const db={users:[],apps:[],keys:[],resellers:[]};
      localStorage.setItem(DB_KEY,JSON.stringify(db));
      return db;
    }
  }
  const saveDB=db=>{
    const isLocal=location.hostname==='localhost' && location.port==='3000';
    if(isLocal){
      try{
        const xhr=new XMLHttpRequest();
        xhr.open('POST','/db.json',false);
        xhr.setRequestHeader('Content-Type','application/json');
        xhr.send(JSON.stringify(db));
        if(xhr.status===200) return;
      }catch{}
    }
    localStorage.setItem(DB_KEY,JSON.stringify(db));
  };

  function getSession(){
    const raw=localStorage.getItem(SESSION_KEY);
    if(!raw) return null;
    try{ return JSON.parse(raw);}catch{return null;}
  }
  function setSession(userId){ localStorage.setItem(SESSION_KEY,JSON.stringify({userId,at:nowIso()})); }
  function clearSession(){ localStorage.removeItem(SESSION_KEY); }

  function toast(type,title,desc){
    const el=$('#toast');
    if(!el) return;
    el.classList.remove('success','error');
    if(type) el.classList.add(type);
    $('#toastTitle').textContent=safe(title||'Aviso');
    $('#toastDesc').textContent=safe(desc||'');
    el.classList.add('show');
    clearTimeout(el.__t);
    el.__t=setTimeout(()=>el.classList.remove('show'),3200);
  }

  function parseDurMs(input){
    const raw=safe(input).trim().toLowerCase();
    const m=raw.match(/^([0-9]+)\s*([smhdw])$/);
    if(!m) return null;
    const n=Number(m[1]);
    if(!Number.isFinite(n)||n<=0) return null;
    const u=m[2];
    const mult=u==='s'?1000:u==='m'?60000:u==='h'?3600000:u==='d'?86400000:604800000;
    return n*mult;
  }

  function formatDate(iso){
    if(!iso) return '-';
    const d=new Date(iso);
    if(Number.isNaN(d.getTime())) return '-';
    const dd=String(d.getDate()).padStart(2,'0');
    const mm=String(d.getMonth()+1).padStart(2,'0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  function getUserById(db,id){ return db.users.find(u=>u.id===id)||null; }
  function getUserByUsername(db,username){
    const u=normUser(username);
    return db.users.find(x=>normUser(x.username)===u)||null;
  }
  function getUserByEmail(db,email){
    const e=normEmail(email);
    return db.users.find(x=>normEmail(x.email)===e)||null;
  }
  function getCurrentUser(db){
    const s=getSession();
    if(!s?.userId) return null;
    return getUserById(db,s.userId);
  }

  const isAdmin=u=>u?.role==='admin';
  function roleLabel(u){ return u?.role==='admin'?'Admin':u?.role==='reseller'?'Reseller':'User'; }
  function planLabel(u){ return u?.plan==='premium_lifetime'?'Premium (Lifetime)':u?.plan==='premium'?'Premium':'Free'; }
  function limits(u){
    if(isAdmin(u)) return {maxApps:Infinity,maxKeysPerApp:Infinity};
    if(u?.plan==='premium'||u?.plan==='premium_lifetime') return {maxApps:Infinity,maxKeysPerApp:Infinity};
    return {maxApps:2,maxKeysPerApp:15};
  }

  function isPremium(u){
    return !!u && (u.plan==='premium' || u.plan==='premium_lifetime' || isAdmin(u));
  }

  function sanitizePrefix(prefix){
    const raw=safe(prefix).trim();
    if(!raw) return '';
    if(/\s/.test(raw)) return null;
    let out=raw;
    if(!out.endsWith('-')) out+= '-';
    return out;
  }

  function keyPrefixForUser(u){
    if(!u) return 'Lunar-Auth-';
    if(!isPremium(u)) return 'Lunar-Auth-';
    const sanitized=sanitizePrefix(u.keyPrefix);
    if(sanitized===null || sanitized==='') return 'Lunar-Auth-';
    return sanitized;
  }

  function genKey(){
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out='';
    for(let i=0;i<16;i++){
      if(i>0 && i%4===0) out+='-';
      out+=chars[Math.floor(Math.random()*chars.length)];
    }
    return out;
  }

  function formatRemainingPt(ms){
    const total=Math.max(0,Math.floor(ms));
    const s=Math.floor(total/1000);
    const days=Math.floor(s/86400);
    const hours=Math.floor((s%86400)/3600);
    const mins=Math.floor((s%3600)/60);
    const parts=[];
    if(days>0) parts.push(`${days}d`);
    if(hours>0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  function computeRemainingMs(key, nowMs, appPaused){
    if(!key) return 0;
    const paused=!!key.paused || !!appPaused;
    if(!key.startedAt) return Math.max(0, key.remainingMs ?? 0);
    if(paused) return Math.max(0, key.remainingMs ?? 0);
    const last=key.lastTickAt ? new Date(key.lastTickAt).getTime() : null;
    if(last==null || Number.isNaN(last)) return Math.max(0, key.remainingMs ?? 0);
    const elapsed=Math.max(0, nowMs - last);
    return Math.max(0, (key.remainingMs ?? 0) - elapsed);
  }

  function persistTick(db, key, nowMs, appPaused){
    if(!key) return false;
    const paused=!!key.paused || !!appPaused;
    if(!key.startedAt || paused) return false;
    const last=key.lastTickAt ? new Date(key.lastTickAt).getTime() : null;
    if(last==null || Number.isNaN(last)){
      key.lastTickAt=nowIso();
      return true;
    }
    const elapsed=Math.max(0, nowMs-last);
    if(elapsed <= 0) return false;
    const next=Math.max(0,(key.remainingMs ?? 0) - elapsed);
    if(next === key.remainingMs) return false;
    key.remainingMs=next;
    key.lastTickAt=nowIso();
    return true;
  }

  function freezeKey(db, key, nowMs, appPaused){
    const changed=persistTick(db, key, nowMs, appPaused);
    key.lastTickAt=null;
    return changed;
  }

  function canAccessApp(db,u,app){
    if(!u||!app) return false;
    if(isAdmin(u)) return true;
    if(app.ownerUserId===u.id) return true;
    return db.resellers.some(r=>r.resellerUserId===u.id && r.appId===app.id);
  }

  function canManageResellers(u,app){
    if(!u||!app) return false;
    return isAdmin(u) || app.ownerUserId===u.id;
  }

  function canManageApp(u, app){
    if(!u||!app) return false;
    return isAdmin(u) || app.ownerUserId===u.id;
  }

  function canManageKey(db,u,key,app){
    if(!u||!key||!app) return false;
    if(isAdmin(u)) return true;
    if(app.ownerUserId===u.id) return true;
    return key.createdByUserId===u.id;
  }

  function visibleApps(db,u){
    if(!u) return [];
    if(isAdmin(u)) return db.apps;
    return db.apps.filter(a=>a.ownerUserId===u.id || db.resellers.some(r=>r.resellerUserId===u.id && r.appId===a.id));
  }

  function visibleKeys(db,u,app){
    if(!u||!app) return [];
    if(isAdmin(u)) return db.keys.filter(k=>k.appId===app.id);
    if(app.ownerUserId===u.id) return db.keys.filter(k=>k.appId===app.id);
    return db.keys.filter(k=>k.appId===app.id && k.createdByUserId===u.id);
  }

  // ---------------- AUTH PAGE ----------------
  function initAuth(){
    const login=$('#loginForm');
    const reg=$('#registerForm');
    if(!login||!reg) return;

    const db=loadDB();
    if(getCurrentUser(db)){
      navigateTo('dashboard.html');
      return;
    }

    $$('.tab-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        $$('.tab-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const t=btn.getAttribute('data-tab');
        $('#loginForm').classList.toggle('active',t==='login');
        $('#registerForm').classList.toggle('active',t==='register');
      });
    });

    login.addEventListener('submit',(e)=>{
      e.preventDefault();
      const fd=new FormData(login);
      const id=safe(fd.get('identifier')).trim();
      const pass=safe(fd.get('password')).trim();
      const db2=loadDB();
      const user=(id.includes('@')?getUserByEmail(db2,id):getUserByUsername(db2,id));
      if(!user||user.password!==pass){
        toast('error','Login inválido','Usuário/email ou senha incorretos.');
        return;
      }
      setSession(user.id);
      toast('success','Bem-vindo','Entrando no painel...');
      setTimeout(()=>navigateTo('dashboard.html'),200);
    });

    reg.addEventListener('submit',(e)=>{
      e.preventDefault();
      const fd=new FormData(reg);
      const username=normUser(fd.get('username'));
      const email=normEmail(fd.get('email'));
      const password=safe(fd.get('password')).trim();
      const db2=loadDB();

      if(!username||!email||!password){
        toast('error','Erro','Preencha todos os campos.');
        return;
      }
      if(getUserByUsername(db2,username)){
        toast('error','Erro','Username já existe.');
        return;
      }
      if(getUserByEmail(db2,email)){
        toast('error','Erro','Email já existe.');
        return;
      }

      const role=(email===ADMIN_EMAIL)?'admin':'user';
      const plan=(email===ADMIN_EMAIL)?'premium_lifetime':'free';
      const user={id:uid('user'),username,email,password,role,plan,createdAt:nowIso(),secretId:genSecretId(15),secretLastUsedAt:null};
      db2.users.push(user);
      saveDB(db2);
      setSession(user.id);
      toast('success','Conta criada','Entrando no painel...');
      setTimeout(()=>navigateTo('dashboard.html'),200);
    });
  }

  // ---------------- SECRET ID VALIDATION ----------------
  function validateSecretId(secretId, appId) {
    const db = loadDB();
    const user = db.users.find(u => u.secretId === secretId);
    if(!user){
      return { valid:false, reason:'INVALID_SECRET' };
    }
    const apps = visibleApps(db, user);
    const allowed = apps.some(a => a.id === appId);
    if(!allowed){
      return { valid:false, reason:'SECRET_APP_MISMATCH' };
    }
    const u = db.users.find(u => u.id === user.id);
    if(u){
      u.secretLastUsedAt = nowIso();
      saveDB(db);
    }
    return { valid:true, userId:user.id };
  }

  // Função para simular validação de API (para demonstração)
  function simulateApiValidation(secretId, appId, key, hwid) {
    const db = loadDB();
    
    // Primeiro valida o Secret ID
    const secretValidation = validateSecretId(secretId, appId);
    if (!secretValidation.valid) {
      return secretValidation.reason;
    }

    // Depois valida a key normalmente
    const now = Date.now();
    const app = db.apps.find(a => a.id === appId);
    if (!app) return 'APP_NOT_FOUND';
    if (app.status !== 'on') return 'APP_PAUSED';

    const keyObj = db.keys.find(k => k.key === key && k.appId === appId);
    if (!keyObj) return 'KEY_NOT_FOUND';
    if (keyObj.paused) return 'KEY_PAUSED';

    // Atualiza o tempo restante
    persistTick(db, keyObj, now, app.status !== 'on');
    
    if (keyObj.remainingMs <= 0) return 'KEY_EXPIRED';
    if (!keyObj.hwid && hwid) {
      // Primeiro uso - bind HWID
      keyObj.hwid = hwid;
      keyObj.firstUsedAt = nowIso();
      if (!keyObj.startedAt) keyObj.startedAt = nowIso();
      keyObj.lastTickAt = nowIso();
      saveDB(db);
      return 'OK';
    }
    if (keyObj.hwid && keyObj.hwid !== hwid) return 'HWID_MISMATCH';
    if (!keyObj.hwid && !hwid) return 'HWID_REQUIRED';

    return 'OK';
  }

  // ---------------- DASHBOARD PAGE ----------------
  function initDashboard(){
    if(!$('#nav')) return;

    const db=loadDB();
    const user=getCurrentUser(db);
    if(!user){
      navigateTo('auth.html');
      return;
    }

    const initial=safe(user.username||'U').charAt(0).toUpperCase();
    $('#avatar').textContent=initial;
    $('#sidebarUsername').textContent=safe(user.username);
    $('#sidebarRole').textContent=`${roleLabel(user)} • ${planLabel(user)}`;
    const topUser=$('#topUser');
    if(topUser) topUser.textContent=safe(user.username);

    const logout=()=>{ clearSession(); navigateTo('auth.html'); };
    $('#logoutBtn')?.addEventListener('click',logout);
    $('#sidebarLogout')?.addEventListener('click',logout);

    const state={ selectedAppId:null, selectedKeyIds:new Set(), visibleKeyIds:[] , extendMode:'bulk', extendSingleId:null };

    function setActiveNav(page){
      $$('#nav a').forEach(a=>a.classList.toggle('active',a.getAttribute('data-page')===page));
    }
    function showPage(page){
      $$('.page').forEach(p=>p.classList.remove('active'));
      $(`#page-${page}`)?.classList.add('active');
      if(page==='dashboard') renderDashboard();
      if(page==='appids') renderAppIds();
      if(page==='implement') renderImplement();
      if(page==='resellers') renderResellers();
      if(page==='profile') renderProfile();
      if(page==='plans') renderPlans();
    }

    $$('#nav a').forEach(a=>{
      a.addEventListener('click',(e)=>{
        e.preventDefault();
        const page=a.getAttribute('data-page');
        if(!page) return;
        setActiveNav(page);
        showPage(page);
      });
    });

    $('#goProfileBtn')?.addEventListener('click',()=>{ setActiveNav('profile'); showPage('profile'); });
    $('#goAppidsBtn')?.addEventListener('click',()=>{ setActiveNav('appids'); showPage('appids'); });

    // Modals
    function openModal(id){ document.getElementById(id)?.classList.add('active'); }
    function closeModal(id){ document.getElementById(id)?.classList.remove('active'); }
    $$('[data-close]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.getAttribute('data-close'))));

    // Bulk actions
    $('#selectAllKeysBtn')?.addEventListener('click',()=>{
      if(!state.selectedAppId) return;
      const allSelected = state.visibleKeyIds.length>0 && state.visibleKeyIds.every(id=>state.selectedKeyIds.has(id));
      if(allSelected){
        state.visibleKeyIds.forEach(id=>state.selectedKeyIds.delete(id));
      } else {
        state.visibleKeyIds.forEach(id=>state.selectedKeyIds.add(id));
      }
      renderAppIds();
    });

    $('#bulkDeleteKeysBtn')?.addEventListener('click',()=>{
      if(!state.selectedAppId) return;
      if(state.selectedKeyIds.size===0){ toast('error','Seleção','Selecione keys para apagar.'); return; }
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      const app=db2.apps.find(a=>a.id===state.selectedAppId);
      if(!u2||!app) return;
      const toDelete=[...state.selectedKeyIds].map(id=>db2.keys.find(k=>k.id===id)).filter(Boolean);
      const deletable=toDelete.filter(k=>canManageKey(db2,u2,k,app));
      if(deletable.length===0){ toast('error','Sem permissão','Você não pode apagar essas keys.'); return; }
      db2.keys=db2.keys.filter(k=>!deletable.some(d=>d.id===k.id));
      saveDB(db2);
      deletable.forEach(k=>state.selectedKeyIds.delete(k.id));
      toast('success','Apagadas',`${deletable.length} key(s) removida(s).`);
      renderAppIds();
      renderProfile();
    });

    $('#bulkExtendKeysBtn')?.addEventListener('click',()=>{
      if(!state.selectedAppId) return;
      if(state.selectedKeyIds.size===0){ toast('error','Seleção','Selecione keys para adicionar tempo.'); return; }
      state.extendMode='bulk';
      state.extendSingleId=null;
      $('#extendDurationInput').value='';
      openModal('extendKeyModal');
    });

    $('#confirmExtendKeyBtn')?.addEventListener('click',()=>{
      const dur=safe($('#extendDurationInput')?.value).trim();
      const ms=parseDurMs(dur);
      if(ms==null){ toast('error','Erro','Tempo inválido. Use 1s, 1m, 1h, 1d.'); return; }
      if(!state.selectedAppId) return;

      const db2=loadDB();
      const u2=getCurrentUser(db2);
      const app=db2.apps.find(a=>a.id===state.selectedAppId);
      if(!u2||!app) return;

      const now=Date.now();
      const appPaused = app.status !== 'on';

      const ids = state.extendMode==='single' && state.extendSingleId
        ? [state.extendSingleId]
        : [...state.selectedKeyIds];

      const keys=ids.map(id=>db2.keys.find(k=>k.id===id)).filter(Boolean);
      const allowed=keys.filter(k=>canManageKey(db2,u2,k,app));
      if(allowed.length===0){ toast('error','Sem permissão','Você não pode alterar essas keys.'); return; }

      let changed=false;
      allowed.forEach(k=>{
        // Congela antes de alterar para não perder tempo
        freezeKey(db2,k,now,appPaused);
        k.remainingMs = Math.max(0,(k.remainingMs ?? 0) + ms);
        if(k.startedAt && !k.paused && !appPaused){
          k.lastTickAt=nowIso();
        }
        changed=true;
      });

      if(changed) saveDB(db2);
      closeModal('extendKeyModal');
      toast('success','Atualizado',`Tempo adicionado em ${allowed.length} key(s).`);
      renderAppIds();
    });

    // Create App
    function createApp(){
      const name=safe($('#appNameInput')?.value).trim();
      if(!name){ toast('error','Erro','Digite um nome para o AppID.'); return; }
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;
      const lim=limits(u2);
      const owned=db2.apps.filter(a=>a.ownerUserId===u2.id).length;
      if(!isAdmin(u2) && owned>=lim.maxApps){ toast('error','Limite do plano','Plano Free permite até 2 AppIDs.'); return; }
      db2.apps.push({id:uid('app'),name,ownerUserId:u2.id,status:'on',createdAt:nowIso()});
      saveDB(db2);
      $('#appNameInput').value='';
      closeModal('createAppModal');
      toast('success','AppID criado','AppID criado com sucesso.');
      renderDashboard();
      renderAppIds();
    }

    $('#openCreateAppBtn')?.addEventListener('click',()=>openModal('createAppModal'));
    $('#createAppBtn')?.addEventListener('click',()=>openModal('createAppModal'));
    $('#confirmCreateAppBtn')?.addEventListener('click',createApp);

    // Create Key
    $('#openCreateKeyBtn')?.addEventListener('click',()=>{
      if(!state.selectedAppId){ toast('error','Erro','Selecione um AppID.'); return; }
      openModal('createKeyModal');
    });

    $('#confirmCreateKeyBtn')?.addEventListener('click',()=>{
      const keyName=safe($('#keyNameInput')?.value).trim();
      const dur=safe($('#keyDurationInput')?.value).trim();
      if(!state.selectedAppId) return;
      if(!keyName){ toast('error','Erro','Digite o nome da key.'); return; }
      const ms=parseDurMs(dur);
      if(ms==null){ toast('error','Erro','Tempo inválido. Use 1s, 1m, 1h, 1d.'); return; }

      const db2=loadDB();
      const u2=getCurrentUser(db2);
      const app=db2.apps.find(a=>a.id===state.selectedAppId);
      if(!u2||!app) return;
      if(!canAccessApp(db2,u2,app)){ toast('error','Sem permissão','Você não tem acesso a este AppID.'); return; }

      if(!isAdmin(u2) && u2.plan==='free'){
        const lim=limits(u2);
        const count=db2.keys.filter(k=>k.appId===app.id).length;
        if(count>=lim.maxKeysPerApp){ toast('error','Limite do plano','Free permite até 15 keys por AppID.'); return; }
      }

      const createdAt=nowIso();
      const prefix=keyPrefixForUser(u2);
      const keyStr=`${prefix}${genKey()}`;
      db2.keys.push({
        id:uid('key'),
        appId:app.id,
        name:keyName,
        key:keyStr,
        durationInput:dur,
        durationMs:ms,
        remainingMs:ms,
        startedAt:null,
        lastTickAt:null,
        createdAt,
        paused:false,
        pausedByApp:false,
        hwid:null,
        firstUsedAt:null,
        createdByUserId:u2.id
      });
      saveDB(db2);
      $('#keyNameInput').value='';
      $('#keyDurationInput').value='';
      closeModal('createKeyModal');
      toast('success','Key criada','Key criada com sucesso.');
      renderAppIds();
      renderProfile();
    });

    // Resellers modal
    $('#openCreateResellerBtn')?.addEventListener('click',()=>openCreateReseller());
    $('#confirmCreateResellerBtn')?.addEventListener('click',()=>confirmCreateReseller());

    // Plans
    $('#openPlansBtn')?.addEventListener('click',()=>{ setActiveNav(null); showPage('plans'); });
    $('#backToProfileBtn')?.addEventListener('click',()=>{ setActiveNav('profile'); showPage('profile'); });
    $('#subscribePremiumBtn')?.addEventListener('click',()=>toast('error','Checkout','Checkout do Premium será configurado depois.'));

    // App detail subtabs
    $$('#appDetailCard .tabs2 button').forEach(btn=>{
      btn.addEventListener('click',()=>{
        $$('#appDetailCard .tabs2 button').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const st=btn.getAttribute('data-subtab');
        $('#subtab-keys').style.display=st==='keys'?'':'none';
        $('#subtab-resellers').style.display=st==='resellers'?'':'none';
      });
    });

    function renderDashboard(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      const apps=visibleApps(db2,u2);
      const label=$('#appsCountLabel');
      if(label) label.textContent=`${apps.length} AppID${apps.length===1?'':'s'} ativo${apps.length===1?'':'s'}`;

      const host=$('#appsCards');
      if(!host) return;
      host.innerHTML='';
      apps.slice(0,6).forEach(app=>{
        const owner=getUserById(db2,app.ownerUserId);
        const el=document.createElement('div');
        el.className='card third';
        el.innerHTML=`
          <div class="kpi">
            <div>
              <div class="card-title">${esc(app.name)}</div>
              <div class="card-desc">${esc(app.id)}${isAdmin(u2)?` • dono: ${esc(owner?.username||'-')}`:''}</div>
            </div>
            <span class="badge ${app.status==='on'?'green':'red'}">${app.status==='on'?'ON':'OFF'}</span>
          </div>
          <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div style="color:var(--muted);font-size:12px">${formatDate(app.createdAt)}</div>
            <button class="btn btn-ghost btn-small" data-open-app="${esc(app.id)}">Ver</button>
          </div>
        `;
        host.appendChild(el);
      });

      $$('[data-open-app]').forEach(btn=>btn.addEventListener('click',()=>{
        setActiveNav('appids');
        showPage('appids');
        selectApp(btn.getAttribute('data-open-app'));
      }));
    }

    function renderAppIds(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      const apps=visibleApps(db2,u2);
      const ownerTh=$('#appsOwnerTh');
      if(ownerTh) ownerTh.style.display=isAdmin(u2)?'':'none';

      const tbody=$('#appsTbody');
      tbody.innerHTML='';

      apps.forEach(app=>{
        const owner=getUserById(db2,app.ownerUserId);
        const canDel = canManageApp(u2, app);
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td><strong>${esc(app.name)}</strong><div style="color:var(--muted);font-size:11px">${esc(app.id)}</div></td>
          <td><span class="badge ${app.status==='on'?'green':'red'}">${app.status==='on'?'ON':'OFF'}</span></td>
          <td>${formatDate(app.createdAt)}</td>
          <td style="display:${isAdmin(u2)?'':'none'}">${esc(owner?.username||'-')}</td>
          <td><div class="row-actions">
            <button class="btn btn-ghost btn-small" data-select-app="${esc(app.id)}">Abrir</button>
            ${canDel ? `<button class=\"btn btn-danger btn-small\" data-delete-app=\"${esc(app.id)}\">Apagar</button>` : ''}
          </div></td>
        `;
        tbody.appendChild(tr);
      });

      $$('[data-select-app]').forEach(btn=>btn.addEventListener('click',()=>selectApp(btn.getAttribute('data-select-app'))));

      $$('[data-delete-app]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-delete-app');
        if(!id) return;
        deleteAppById(id);
      }));

      if(state.selectedAppId && !apps.some(a=>a.id===state.selectedAppId)){
        state.selectedAppId=null;
        $('#appDetailCard').style.display='none';
      }

      if(state.selectedAppId) renderSelectedApp();
    }

    function selectApp(appId){
      if(!appId) return;
      state.selectedAppId=appId;
      $('#appDetailCard').style.display='';
      renderSelectedApp();
    }

    function renderSelectedApp(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      const app=db2.apps.find(a=>a.id===state.selectedAppId);
      if(!u2||!app) return;

      if(!canAccessApp(db2,u2,app)){
        toast('error','Sem permissão','Você não tem acesso a este AppID.');
        state.selectedAppId=null;
        $('#appDetailCard').style.display='none';
        return;
      }

      $('#selectedAppTitle').textContent=app.name;
      $('#selectedAppDesc').textContent=app.id;

      // Toggle app ON/OFF (owner/admin)
      const toggleBtn=$('#toggleAppBtn');
      const canToggle=canManageResellers(u2,app);
      toggleBtn.disabled=!canToggle;
      toggleBtn.textContent=app.status==='on'?'Pausar':'Ativar';
      toggleBtn.onclick=()=>{
        if(!canToggle) return;
        const db3=loadDB();
        const a3=db3.apps.find(x=>x.id===app.id);
        if(!a3) return;
        const now=Date.now();
        if(a3.status==='on'){
          a3.status='off';
          // Pausar todas as keys do app e congelar tempo
          db3.keys.filter(k=>k.appId===a3.id).forEach(k=>{
            if(!k.paused){
              freezeKey(db3,k,now,false);
              k.paused=true;
              k.pausedByApp=true;
            } else {
              // já estava pausada manualmente
              freezeKey(db3,k,now,false);
              k.pausedByApp=false;
            }
          });
        } else {
          a3.status='on';
          // Retomar apenas keys pausadas pelo app
          db3.keys.filter(k=>k.appId===a3.id && k.pausedByApp).forEach(k=>{
            k.paused=false;
            k.pausedByApp=false;
            if(k.startedAt) k.lastTickAt=nowIso();
          });
        }
        saveDB(db3);
        renderDashboard();
        renderAppIds();
        toast('success','Atualizado','Status do AppID atualizado.');
      };

      const delBtn=$('#deleteAppBtn');
      if(delBtn){
        const canDel = canManageApp(u2, app);
        delBtn.disabled = !canDel;
        delBtn.onclick = ()=>{
          if(!canDel) return;
          deleteAppById(app.id);
        };
      }

      renderKeysTable(db2,u2,app);
      renderAppResellers(db2,u2,app);
    }

    function deleteAppById(appId){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      const app=db2.apps.find(a=>a.id===appId);
      if(!u2||!app) return;
      if(!canManageApp(u2, app)){
        toast('error','Sem permissão','Você não pode apagar este AppID.');
        return;
      }

      const ok = confirm(`Apagar o AppID "${app.name}"?\n\nIsso vai remover todas as keys e resellers vinculados.`);
      if(!ok) return;

      db2.keys = db2.keys.filter(k=>k.appId!==app.id);
      db2.resellers = db2.resellers.filter(r=>r.appId!==app.id);
      db2.apps = db2.apps.filter(a=>a.id!==app.id);
      saveDB(db2);

      if(state.selectedAppId===app.id){
        state.selectedAppId=null;
        state.selectedKeyIds.clear();
        $('#appDetailCard').style.display='none';
      }

      toast('success','AppID apagado','AppID e dados vinculados removidos.');
      renderDashboard();
      renderAppIds();
      renderResellers();
      renderProfile();
    }

    function renderKeysTable(db2,u2,app){
      const tbody=$('#keysTbody');
      tbody.innerHTML='';
      const keys=visibleKeys(db2,u2,app);

      const now=Date.now();
      const appPaused = app.status !== 'on';
      state.visibleKeyIds = keys.map(k=>k.id);

      if(keys.length===0){
        const tr=document.createElement('tr');
        tr.innerHTML='<td colspan="8" style="color:var(--muted);padding:16px">Nenhuma key encontrada</td>';
        tbody.appendChild(tr);
        return;
      }

      keys.forEach(k=>{
        const rem=computeRemainingMs(k, now, appPaused);
        const expired = rem <= 0 && !!k.startedAt;
        const effectivePaused = !!k.paused || !!appPaused;
        const status = appPaused ? 'APP PAUSADO' : effectivePaused ? 'PAUSADA' : expired ? 'EXPIRADA' : k.startedAt ? 'ATIVA' : 'NÃO INICIADA';
        const cls = appPaused ? 'gray' : effectivePaused ? 'gray' : expired ? 'red' : k.startedAt ? 'green' : 'gray';
        const creator=getUserById(db2,k.createdByUserId);
        const can=canManageKey(db2,u2,k,app);

        const actions=[];
        actions.push(`<button class="btn btn-ghost btn-small" data-copy-key="${esc(k.id)}">Copiar</button>`);
        if(can){
          actions.push(`<button class="btn btn-ghost btn-small" data-extend-key="${esc(k.id)}">+Tempo</button>`);
          actions.push(`<button class="btn btn-ghost btn-small" data-toggle-key="${esc(k.id)}">${k.paused?'Ativar':'Pausar'}</button>`);
          actions.push(`<button class="btn btn-ghost btn-small" data-reset-hwid="${esc(k.id)}">Reset HWID</button>`);
          actions.push(`<button class="btn btn-danger btn-small" data-del-key="${esc(k.id)}">Apagar</button>`);
        }

        const checked = state.selectedKeyIds.has(k.id);
        const timeCell = !k.startedAt
          ? `<span class="badge gray">NÃO INICIADA</span><div style="color:var(--muted);font-size:11px;margin-top:4px">Duração: ${esc(k.durationInput||'-')} • começa no 1º uso</div>`
          : `<strong>${esc(formatRemainingPt(rem))}</strong><div style="color:var(--muted);font-size:11px;margin-top:4px">Essa key tem ${esc(formatRemainingPt(rem))} ainda.</div>`;

        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td><input type="checkbox" data-key-check="${esc(k.id)}" ${checked?'checked':''} /></td>
          <td><strong>${esc(k.key)}</strong></td>
          <td>${esc(k.name)}</td>
          <td><span class="badge ${cls}">${status}</span></td>
          <td>${timeCell}</td>
          <td>${k.hwid?`<span style="font-size:11px;color:rgba(255,255,255,.85)">${esc(k.hwid)}</span>`:'<span style="color:var(--muted)">-</span>'}</td>
          <td>${esc(creator?.username||'-')}</td>
          <td><div class="row-actions">${actions.join('')}</div></td>
        `;
        tbody.appendChild(tr);
      });

      $$('[data-key-check]').forEach(chk=>chk.addEventListener('change',()=>{
        const id=chk.getAttribute('data-key-check');
        if(!id) return;
        if(chk.checked) state.selectedKeyIds.add(id);
        else state.selectedKeyIds.delete(id);
      }));

      $$('[data-copy-key]').forEach(btn=>btn.addEventListener('click',()=>{
        const db3=loadDB();
        const k=db3.keys.find(x=>x.id===btn.getAttribute('data-copy-key'));
        if(!k) return;
        navigator.clipboard?.writeText(k.key);
        toast('success','Copiado','Key copiada para a área de transferência.');
      }));

      $$('[data-toggle-key]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-toggle-key');
        const db3=loadDB();
        const u3=getCurrentUser(db3);
        const app3=db3.apps.find(a=>a.id===state.selectedAppId);
        const k=db3.keys.find(x=>x.id===id);
        if(!u3||!app3||!k) return;
        if(!canManageKey(db3,u3,k,app3)) return;
        const now=Date.now();
        const appPaused = app3.status !== 'on';
        if(!k.paused){
          freezeKey(db3,k,now,appPaused);
          k.paused=true;
        } else {
          k.paused=false;
          k.pausedByApp=false;
          if(k.startedAt && !appPaused){
            k.lastTickAt=nowIso();
          }
        }
        saveDB(db3);
        renderAppIds();
        toast('success','Atualizado','Status da key atualizado.');
      }));

      $$('[data-extend-key]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-extend-key');
        if(!id) return;
        state.extendMode='single';
        state.extendSingleId=id;
        $('#extendDurationInput').value='';
        openModal('extendKeyModal');
      }));

      $$('[data-reset-hwid]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-reset-hwid');
        const db3=loadDB();
        const u3=getCurrentUser(db3);
        const app3=db3.apps.find(a=>a.id===state.selectedAppId);
        const k=db3.keys.find(x=>x.id===id);
        if(!u3||!app3||!k) return;
        if(!canManageKey(db3,u3,k,app3)) return;
        k.hwid=null;
        k.firstUsedAt=null;
        saveDB(db3);
        renderAppIds();
        toast('success','Reset','HWID resetado com sucesso.');
      }));

      $$('[data-del-key]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-del-key');
        const db3=loadDB();
        const u3=getCurrentUser(db3);
        const app3=db3.apps.find(a=>a.id===state.selectedAppId);
        const k=db3.keys.find(x=>x.id===id);
        if(!u3||!app3||!k) return;
        if(!canManageKey(db3,u3,k,app3)) return;
        db3.keys=db3.keys.filter(x=>x.id!==id);
        saveDB(db3);
        renderAppIds();
        renderProfile();
        toast('success','Removida','Key removida.');
      }));
    }

    function renderAppResellers(db2,u2,app){
      const tbody=$('#appResellersTbody');
      tbody.innerHTML='';

      if(!canManageResellers(u2,app)){
        const tr=document.createElement('tr');
        tr.innerHTML='<td colspan="3" style="color:var(--muted);padding:16px">Somente o dono do AppID ou Admin gerencia resellers.</td>';
        tbody.appendChild(tr);
        return;
      }

      const res=db2.resellers.filter(r=>r.appId===app.id);
      if(res.length===0){
        const tr=document.createElement('tr');
        tr.innerHTML='<td colspan="3" style="color:var(--muted);padding:16px">Nenhum reseller adicionado</td>';
        tbody.appendChild(tr);
        return;
      }

      res.forEach(r=>{
        const ru=getUserById(db2,r.resellerUserId);
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td><strong>${esc(ru?.username||'-')}</strong></td>
          <td>${formatDate(r.createdAt)}</td>
          <td><div class="row-actions"><button class="btn btn-danger btn-small" data-remove-reseller="${esc(r.id)}">Remover</button></div></td>
        `;
        tbody.appendChild(tr);
      });

      $$('[data-remove-reseller]').forEach(btn=>btn.addEventListener('click',()=>{
        const id=btn.getAttribute('data-remove-reseller');
        const db3=loadDB();
        const u3=getCurrentUser(db3);
        const app3=db3.apps.find(a=>a.id===state.selectedAppId);
        if(!u3||!app3) return;
        if(!canManageResellers(u3,app3)) return;
        db3.resellers=db3.resellers.filter(r=>r.id!==id);
        saveDB(db3);
        renderAppIds();
        renderResellers();
        toast('success','Removido','Reseller removido do AppID.');
      }));
    }

    function openCreateReseller(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      if(!isAdmin(u2) && u2.role!=='user'){
        // reseller não cria outros resellers
      }

      const apps=isAdmin(u2)?db2.apps:db2.apps.filter(a=>a.ownerUserId===u2.id);
      const list=$('#resellerAppsList');
      list.innerHTML='';

      if(apps.length===0){
        list.innerHTML='<div style="color:var(--muted);font-size:12px">Crie um AppID primeiro.</div>';
      } else {
        apps.forEach(app=>{
          const row=document.createElement('label');
          row.style.display='flex';
          row.style.alignItems='center';
          row.style.gap='10px';
          row.style.padding='10px 12px';
          row.style.border='1px solid rgba(255,255,255,.08)';
          row.style.borderRadius='12px';
          row.style.background='rgba(0,0,0,.22)';
          row.innerHTML=`
            <input type="checkbox" value="${esc(app.id)}" style="width:16px;height:16px" />
            <div style="display:flex;flex-direction:column;gap:2px">
              <strong style="font-size:12px">${esc(app.name)}</strong>
              <span style="font-size:11px;color:var(--muted)">${esc(app.id)}</span>
            </div>
          `;
          list.appendChild(row);
        });
      }

      openModal('createResellerModal');
    }

    function confirmCreateReseller(){
      const username=normUser($('#resellerUsernameInput')?.value);
      if(!username){ toast('error','Erro','Digite o username do reseller.'); return; }
      const appIds=$$('#resellerAppsList input[type="checkbox"]:checked').map(i=>i.value);
      if(appIds.length===0){ toast('error','Erro','Selecione ao menos 1 AppID.'); return; }

      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      const resellerUser=getUserByUsername(db2,username);
      if(!resellerUser){ toast('error','Erro','Usuário reseller não encontrado.'); return; }
      if(resellerUser.id===u2.id){ toast('error','Erro','Você não pode adicionar você mesmo.'); return; }

      // Somente Admin ou dono de AppID pode adicionar
      const allowed=appIds.map(id=>db2.apps.find(a=>a.id===id)).filter(app=>app && (isAdmin(u2)||app.ownerUserId===u2.id));
      if(allowed.length===0){ toast('error','Erro','Nenhum AppID válido selecionado.'); return; }

      if(resellerUser.role!=='admin') resellerUser.role='reseller';

      allowed.forEach(app=>{
        const exists=db2.resellers.some(r=>r.resellerUserId===resellerUser.id && r.appId===app.id);
        if(!exists){
          db2.resellers.push({id:uid('res'),resellerUserId:resellerUser.id,appId:app.id,createdByUserId:u2.id,createdAt:nowIso()});
        }
      });

      saveDB(db2);
      $('#resellerUsernameInput').value='';
      closeModal('createResellerModal');
      toast('success','Reseller criado','Permissões atualizadas.');
      renderResellers();
      renderAppIds();
      renderProfile();
    }

    function renderResellers(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      const tbody=$('#resellersTbody');
      tbody.innerHTML='';

      // Apenas Admin ou dono de AppIDs vê listagem completa de permissões
      const canSee = isAdmin(u2) || db2.apps.some(a=>a.ownerUserId===u2.id);
      if(!canSee){
        const tr=document.createElement('tr');
        tr.innerHTML='<td colspan="4" style="color:var(--muted);padding:16px">Sem permissões para gerenciar resellers.</td>';
        tbody.appendChild(tr);
        $('#openCreateResellerBtn')?.setAttribute('disabled','disabled');
        return;
      }
      $('#openCreateResellerBtn')?.removeAttribute('disabled');

      const rows=isAdmin(u2)
        ? db2.resellers
        : db2.resellers.filter(r=>{
            const app=db2.apps.find(a=>a.id===r.appId);
            return app && app.ownerUserId===u2.id;
          });

      if(rows.length===0){
        const tr=document.createElement('tr');
        tr.innerHTML='<td colspan="4" style="color:var(--muted);padding:16px">Nenhum reseller encontrado</td>';
        tbody.appendChild(tr);
        return;
      }

      // Group by reseller user
      const grouped=new Map();
      rows.forEach(r=>{
        const key=r.resellerUserId;
        if(!grouped.has(key)) grouped.set(key,[]);
        grouped.get(key).push(r);
      });

      grouped.forEach((list,resellerUserId)=>{
        const ru=getUserById(db2,resellerUserId);
        const appNames=list.map(r=>{
          const app=db2.apps.find(a=>a.id===r.appId);
          return app?app.name: '-';
        });
        const createdAt=list.map(r=>r.createdAt).sort()[0];
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td><strong>${esc(ru?.username||'-')}</strong></td>
          <td>${esc(appNames.join(', '))}</td>
          <td>${formatDate(createdAt)}</td>
          <td><div class="row-actions"><button class="btn btn-danger btn-small" data-remove-all="${esc(resellerUserId)}">Remover</button></div></td>
        `;
        tbody.appendChild(tr);
      });

      $$('[data-remove-all]').forEach(btn=>btn.addEventListener('click',()=>{
        const rid=btn.getAttribute('data-remove-all');
        const db3=loadDB();
        const u3=getCurrentUser(db3);
        if(!u3) return;

        if(isAdmin(u3)){
          db3.resellers=db3.resellers.filter(r=>r.resellerUserId!==rid);
        } else {
          // remove only mappings where app owner is current user
          db3.resellers=db3.resellers.filter(r=>{
            if(r.resellerUserId!==rid) return true;
            const app=db3.apps.find(a=>a.id===r.appId);
            return !(app && app.ownerUserId===u3.id);
          });
        }
        saveDB(db3);
        toast('success','Removido','Reseller removido.');
        renderResellers();
        renderAppIds();
      }));
    }

    function renderProfile(){
      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      $('#profileUsername').textContent=safe(u2.username);
      $('#profileEmail').textContent=safe(u2.email);
      $('#profileRole').textContent=roleLabel(u2);
      $('#profilePlan').textContent=planLabel(u2);
      $('#profileCreatedAt').textContent=formatDate(u2.createdAt);

      const appsOwned=isAdmin(u2)?db2.apps.length:db2.apps.filter(a=>a.ownerUserId===u2.id).length;
      const keysOwned=isAdmin(u2)?db2.keys.length:db2.keys.filter(k=>{
        const a=db2.apps.find(x=>x.id===k.appId);
        return a && (a.ownerUserId===u2.id || k.createdByUserId===u2.id);
      }).length;
      const resCount=isAdmin(u2)?db2.resellers.length:db2.resellers.filter(r=>{
        const a=db2.apps.find(x=>x.id===r.appId);
        return a && a.ownerUserId===u2.id;
      }).length;

      $('#statApps').textContent=String(appsOwned);
      $('#statKeys').textContent=String(keysOwned);
      $('#statResellers').textContent=String(resCount);

      const box=$('#premiumPrefixBox');
      const input=$('#premiumPrefixInput');
      const saveBtn=$('#savePremiumPrefixBtn');
      if(box && input && saveBtn){
        const show=isPremium(u2);
        box.style.display=show?'':'none';
        if(show){
          input.value=u2.keyPrefix||'';
          saveBtn.onclick=()=>{
            const raw=safe(input.value);
            const sanitized=sanitizePrefix(raw);
            if(sanitized===null){
              toast('error','Prefixo inválido','Não pode ter espaço. Ex: Nevasca-');
              return;
            }
            const db3=loadDB();
            const u3=getCurrentUser(db3);
            if(!u3) return;
            if(!isPremium(u3)) return;
            u3.keyPrefix=sanitized||'';
            saveDB(db3);
            toast('success','Salvo','Prefixo atualizado.');
            renderProfile();
          };
        }
      }
      const secretEl=$('#profileSecretId');
      const copyBtn=$('#copyProfileSecretBtn');
      if(secretEl) secretEl.textContent=safe(u2.secretId||'-');
      if(copyBtn){
        copyBtn.onclick=()=>{
          const s=safe(u2.secretId||'');
          if(!s){ toast('error','Sem Secret','Secret ID não disponível.'); return; }
          navigator.clipboard.writeText(s).then(()=>{
            toast('success','Copiado','Secret ID copiado para a área de transferência.');
          }).catch(()=>{
            toast('error','Erro','Não foi possível copiar o Secret ID.');
          });
        };
      }
    }

    function renderPlans(){
      // layout já estático; só garante botões
    }

    function renderImplement(){
      const select=$('#implAppSelect');
      const keyInput=$('#implKeyInput');
      const hwidInput=$('#implHwidInput');
      const btn=$('#implLoginBtn');
      const resultEl=$('#implResult');
      if(!select || !keyInput || !hwidInput || !btn || !resultEl) return;

      const db2=loadDB();
      const u2=getCurrentUser(db2);
      if(!u2) return;

      const apps=visibleApps(db2,u2);
      select.innerHTML='';
      apps.forEach(app=>{
        const opt=document.createElement('option');
        opt.value=app.id;
        opt.textContent=`${app.name} (${app.id})`;
        select.appendChild(opt);
      });

      if(apps.length===0){
        const opt=document.createElement('option');
        opt.value='';
        opt.textContent='Crie um AppID primeiro';
        select.appendChild(opt);
        select.disabled=true;
      } else {
        select.disabled=false;
      }

      if(!hwidInput.value) hwidInput.value='PC-1';

      const showResult=(ok,msg,type)=>{
        resultEl.textContent=msg;
        resultEl.style.color = ok ? 'rgba(187,247,208,.95)' : type==='warn' ? 'rgba(253,230,138,.95)' : 'rgba(254,202,202,.95)';
      };

      btn.onclick=()=>{
        const appid=safe(select.value).trim();
        const key=safe(keyInput.value).trim();
        const hwid=safe(hwidInput.value).trim();
        if(!appid){ showResult(false,'Crie/seleciona um AppID.', 'warn'); return; }
        if(!key){ showResult(false,'Digite a key antes de clicar em Login.', 'warn'); return; }
        if(!hwid){ showResult(false,'Digite um HWID (mesmo que simulado).', 'warn'); return; }

        const res=window.LunarAuth?.validate({appid,key,hwid});
        if(!res){ showResult(false,'Validador não encontrado (LunarAuth).', 'warn'); return; }

        if(res.ok){
          showResult(true,`Login OK. Tempo restante: ${res.remaining}`, 'ok');
          toast('success','Login OK',`Tempo restante: ${res.remaining}`);
        } else {
          const map={
            APP_NOT_FOUND:'AppID não existe',
            APP_PAUSED:'AppID pausado',
            KEY_NOT_FOUND:'Key não existe nesse AppID',
            KEY_PAUSED:'Key pausada',
            KEY_EXPIRED:'Key expirada',
            HWID_REQUIRED:'HWID obrigatório',
            HWID_MISMATCH:'Key já foi usada em outro dispositivo'
          };
          const reason=map[res.code] || res.code || 'Erro';
          showResult(false,`Falhou: ${reason}`, 'err');
          toast('error','Login falhou',reason);
        }
      };
    }

    // Start
    renderDashboard();
    renderAppIds();
    renderResellers();
    renderProfile();
    showPage('dashboard');

    // Atualiza tempo restante (sem ficar contando quando pausado)
    setInterval(()=>{
      if(!state.selectedAppId) return;
      const activePage = document.querySelector('#page-appids.page.active');
      if(!activePage) return;
      const keysTabVisible = $('#subtab-keys') && $('#subtab-keys').style.display !== 'none';
      if(!keysTabVisible) return;

      const db2=loadDB();
      const app=db2.apps.find(a=>a.id===state.selectedAppId);
      if(!app) return;
      const appPaused = app.status !== 'on';
      const now=Date.now();
      let changed=false;
      db2.keys.filter(k=>k.appId===app.id).forEach(k=>{
        const before=k.remainingMs;
        const rem=computeRemainingMs(k, now, appPaused);
        if(k.startedAt && !k.paused && !appPaused){
          // Persistir tick
          if(rem !== before){
            k.remainingMs=rem;
            k.lastTickAt=nowIso();
            changed=true;
          }
        }
      });
      if(changed) saveDB(db2);
      renderAppIds();
    }, 5000);

    // Expose helper (prototype): validate key like API would
    window.LunarAuth={
      validate({appid,key,hwid}){
        const db2=loadDB();
        const app=db2.apps.find(a=>a.id===appid || a.name===appid);
        if(!app) return {ok:false,code:'APP_NOT_FOUND'};
        if(app.status!=='on') return {ok:false,code:'APP_PAUSED'};
        const k=db2.keys.find(x=>x.appId===app.id && x.key===key);
        if(!k) return {ok:false,code:'KEY_NOT_FOUND'};

        if(k.paused) return {ok:false,code:'KEY_PAUSED'};
        if(!hwid) return {ok:false,code:'HWID_REQUIRED'};

        // Start timer only after first successful validation
        const now=Date.now();
        if(!k.startedAt){
          k.startedAt=nowIso();
          k.firstUsedAt=k.firstUsedAt||k.startedAt;
          k.lastTickAt=nowIso();
          if(typeof k.durationMs!=='number'){
            const ms=parseDurMs(k.durationInput);
            k.durationMs=ms==null?0:ms;
          }
          if(typeof k.remainingMs!=='number') k.remainingMs=k.durationMs;
        } else {
          persistTick(db2,k,now,false);
        }

        const rem=computeRemainingMs(k, now, false);
        if(rem<=0){
          k.remainingMs=0;
          k.lastTickAt=null;
          saveDB(db2);
          return {ok:false,code:'KEY_EXPIRED'};
        }

        // HWID bind
        if(k.hwid && k.hwid!==hwid) return {ok:false,code:'HWID_MISMATCH'};
        if(!k.hwid){
          k.hwid=hwid;
          saveDB(db2);
        }

        return {ok:true,code:'OK',remaining:formatRemainingPt(rem)};
      }
    };
  }

  // Boot
  document.addEventListener('DOMContentLoaded',()=>{
    initAuth();
    initDashboard();
  });
})();
