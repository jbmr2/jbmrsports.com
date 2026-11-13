const { createHash } = require('node:crypto');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const SCORER = '80c7442eb2ca4aeabfb6779128d91b8a';
const DBURL = 'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app';
const digest = value => createHash('sha256').update(value).digest('hex');
// Firebase tables may be arrays or objects keyed by their scorer IDs. Preserve
// those keys as row IDs when an imported row doesn't contain an explicit id.
const rows = value => Object.entries(value || {}).flatMap(([key, row]) => {
  if (!row || typeof row !== 'object') return [];
  if (row.id == null) row.id = key;
  return [row];
});
function stripControlCharacters(value) {
  return Array.from(String(value)).filter(character => {
    const point = character.codePointAt(0) || 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  }).join('');
}
const { phone, mappedPhones } = require('./player-ownership.cjs');
// Only server-resolved mappings grant ownership. Archive contact fields and
// phone-shaped player IDs are never proof of a logged-in user's identity.
function playerPhones(player) { return [phone(player.download_phone)].filter(Boolean); }
function performancePlayerPhones(player) { return [phone(player.performance_phone)].filter(Boolean); }
function ownsBall(tables, matchID, ballID, verifiedPhone) {
  if (!phone(verifiedPhone)) return false;
  const match = rows(tables.matches).find(x => String(x.id) === matchID);
  if (!match) return false;
  const innings = new Set(rows(tables.innings).filter(x => String(x.match_id) === matchID).map(x => String(x.id)));
  const ball = rows(tables.balls).find(x => String(x.id) === ballID && innings.has(String(x.innings_id)));
  if (!ball) return false;
  let event = ball.event || ball.event_json || {};
  if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = {}; } }
  const playerIDs = new Set([ball.striker_id, ball.bowler_id, event.out_batter_id].filter(x => x != null).map(String));
  return rows(tables.players).some(player => playerIDs.has(String(player.id)) &&
    playerPhones(player).some(value => phone(value) && phone(value) === phone(verifiedPhone)));
}
function applyPlayerDirectory(tables, directory, overrides) {
  for (const player of rows(tables.players)) {
    const number = mappedPhones(player, directory, overrides)[0] || '';
    player.performance_phone = number;
    player.download_phone = number;
  }
}

let catalogCache, loadingCatalog;
async function catalogs() {
  if (catalogCache && Date.now() - catalogCache.at < 60000) return catalogCache.payloads;
  if (!loadingCatalog) loadingCatalog = (async () => {
    const db = getDatabaseWithUrl(DBURL);
    const feed = (await db.ref('tournament_feed').get()).val() || {};
    const sources = [...new Set([SCORER, '994bd24b405943c790d9b8b32d3e13e2', '6fca9fc7d4974919a43b149d32717119',
      ...Object.keys(feed).filter(id => /^[a-f0-9]{32}$/i.test(id))])];
    const [feeds, archived] = await Promise.all([
      Promise.all(sources.map(id => db.ref(`scorers_public/${id}`).get())),
      require('./admin-visibility.cjs').archives()
    ]);
    const payloads = [...feeds.map((snapshot,index) => ({...(snapshot.val() || {}), installation_id:sources[index]})), ...archived].filter(Boolean);
    catalogCache = { at: Date.now(), payloads }; return payloads;
  })().finally(() => { loadingCatalog = null; });
  return loadingCatalog;
}
async function playerMappings() {
  // Identity revocations are read fresh, independently of the scoring cache.
  const db = getDatabaseWithUrl(DBURL);
  const [directory, links] = await Promise.all([
    db.ref('player_directory').get(), db.ref('player_download_links').get()
  ]);
  return { playerDirectory: directory.val() || {}, playerDownloadLinks: links.val() || {} };
}
async function mappedCatalogs() {
  const [payloads, mappings] = await Promise.all([catalogs(), playerMappings()]);
  return payloads.map(payload => {
    const tables = { ...payload.tables, players: rows(payload.tables?.players).map(player => ({ ...player })) };
    const source = payload.installation_id;
    applyPlayerDirectory(tables, source ? mappings.playerDirectory[source] : {}, source ? mappings.playerDownloadLinks[source] : {});
    return { ...payload, tables };
  });
}
async function performanceForPhone(verifiedPhone) {
  // Reuse the same manifest-driven catalog as analytics and completed matches.
  // Keep this response uncached: publication decisions can change independently.
  const [payloads, visibility] = await Promise.all([
    mappedCatalogs(), getDatabaseWithUrl(DBURL).ref('app_visibility').get()
  ]);
  const normalized = phone(verifiedPhone);
  const linked = !!normalized && payloads.some(payload => rows(payload.tables?.players)
    .some(player => performancePlayerPhones(player).some(value => value === normalized)));
  const packages = performancePackages(payloads, verifiedPhone, visibility.val() || {});
  const matchCount = new Set(packages.map(item => JSON.stringify([item.installationID, item.matchID]))).size;
  const readyClipCount = packages.reduce((count, item) => count + item.clips.length, 0);
  const totalClipCount = packages.reduce((count, item) => count + item.totalClips, 0);
  const status = !normalized ? 'login_phone_missing' : !linked ? 'player_not_linked'
    : !packages.length ? 'no_visible_performance' : readyClipCount ? 'clips_ready' : 'clips_pending';
  return { linked, packages, diagnostic: { status, matchCount, packageCount: packages.length,
    readyClipCount, pendingClipCount: Math.max(0, totalClipCount - readyClipCount) } };
}
function selectClip(payloads, id, visibility, verifiedPhone = '') {
  const match = /^rtdb-ball-(\d+)-(\d+)$/.exec(id);
  if (!match) return null;
  // Old app clip IDs do not include a scorer. If the number identifies more
  // than one match, fail closed rather than select a video by caller identity.
  const owners = new Set(), uids = new Set();
  for (const payload of payloads) {
    for (const row of rows(payload.tables?.matches).filter(row => String(row.id) === match[1])) {
      owners.add(String(payload.installation_id || ''));
      const uid = row.match_uid || (String(payload.archive_manifest?.match_id) === match[1] ? payload.archive_manifest?.match_uid : null);
      if (uid) uids.add(String(uid));
    }
  }
  if (owners.size > 1 || uids.size > 1) return null;
  let fallback = null;
  for (const payload of payloads) {
    const tables = payload.tables || {};
    const row = rows(tables.matches).find(x => String(x.id) === match[1]);
    if (!row) continue;
    if (!require('./admin-visibility.cjs').allowsClip(match[1], String(row.tournament_id), visibility, payload.installation_id)) continue;
    const innings = new Set(rows(tables.innings).filter(x => String(x.match_id) === match[1]).map(x => String(x.id)));
    const ball = rows(tables.balls).find(x => String(x.id) === match[2] && innings.has(String(x.innings_id)));
    if (!ball || !(ball.clip_status === 'ready' || ball.clip?.status === 'ready') || !ball.clip?.url) continue;
    const candidate = {tables, ball, matchID:match[1], ballID:match[2]};
    if (!fallback) fallback = candidate;
    if (!phone(verifiedPhone) || ownsBall(tables,match[1],match[2],verifiedPhone)) return candidate;
  }
  return fallback;
}
async function findClip(id, verifiedPhone = '') {
  const [visibility, payloads] = await Promise.all([
    getDatabaseWithUrl(DBURL).ref('app_visibility').get(), phone(verifiedPhone) ? mappedCatalogs() : catalogs()
  ]);
  return selectClip(payloads,id,visibility.val() || {},verifiedPhone);
}
function performancePackages(payloads, verifiedPhone, visibility) {
  const packages = [], seen = new Set();
  for (const payload of payloads) {
    const tables = payload.tables || {};
    const players = rows(tables.players).filter(player => performancePlayerPhones(player).some(value => value === phone(verifiedPhone)));
    for (const player of players) for (const inning of rows(tables.innings)) {
      const matchID=String(inning.match_id), match=rows(tables.matches).find(x=>String(x.id)===matchID);
      if(!match || !require('./admin-visibility.cjs').allowsClip(matchID,String(match.tournament_id),visibility,payload.installation_id))continue;
      const balls=rows(tables.balls).filter(x=>String(x.innings_id)===String(inning.id)).sort((a,b)=>Number(a.seq)-Number(b.seq));
      const event=b=>{let e=b.event||b.event_json||{};if(typeof e==='string'){try{return JSON.parse(e)}catch{return {}}}return e};
      const batting=balls.filter(b=>String(b.striker_id)===String(player.id));
      const wickets=balls.filter(b=>String(b.bowler_id)===String(player.id)&&['bowled','caught','caught and bowled','caught & bowled','lbw','stumped','hit wicket'].includes(String(event(b).dismissal||'').toLowerCase().replace(/_/g,' ')));
      const fours=batting.filter(b=>Number(event(b).bat_runs)===4), sixes=batting.filter(b=>Number(event(b).bat_runs)===6);
      for(const category of ['innings','fours','sixes','wickets']) {
        const role=category==='wickets'?'bowling':'batting';
        const selected={innings:batting,fours,sixes,wickets}[category];
        if(!selected.length)continue;
        const id=`${payload.installation_id || 'legacy'}:${matchID}-${inning.id}-${player.id}-${category}`;
        if(seen.has(id))continue;seen.add(id);
        const ready=selected.filter(b=>(b.clip_status==='ready'||b.clip?.status==='ready')&&b.clip?.url);
        const runs=batting.reduce((n,b)=>n+Number(event(b).bat_runs||0),0), faced=batting.filter(b=>!Number(event(b).wide_runs||0)&&!event(b).dead_ball).length;
        const team=id=>rows(tables.teams).find(t=>String(t.id)===String(id))?.name||'Team';
        packages.push({id,matchID,installationID:payload.installation_id || null,playerName:player.name||'Player',role,category,runs,balls:faced,wickets:wickets.length,fours:fours.length,sixes:sixes.length,totalClips:selected.length,
          title:category==='innings'?'Your Innings':category==='fours'?(fours.length>=3?'Boundary Boss':'Boundary Blitz'):category==='sixes'?(sixes.length>=3?'Six Machine':'Maximum Moments'):(wickets.length>=5?'Five-Wicket Star':wickets.length>=2?'Wicket Hunter':'The Breakthrough'),
          subtitle:category==='innings'?`${runs} runs · ${faced} balls`:category==='fours'?`${fours.length} ${fours.length===1?'four':'fours'} · ${fours.length*4} boundary runs`:category==='sixes'?`${sixes.length} ${sixes.length===1?'six':'sixes'} · ${sixes.length*6} boundary runs`:`${wickets.length} ${wickets.length===1?'wicket':'wickets'} · Your bowling highlights`,
          matchTitle:`${team(match.team_a_id)} vs ${team(match.team_b_id)}`,matchNumber:match.match_number||match.match_no||match.id,
          tournament:rows(tables.tournaments).find(t=>String(t.id)===String(match.tournament_id))?.name||'Tournament',
          updatedAt:match.ended_at||match.created_at||'',clips:ready.map(b=>({id:`rtdb-ball-${matchID}-${b.id}`,matchID,ballID:String(b.id),videoURL:b.clip.url,
          label:`Over ${b.over_index||0} · Ball ${b.seq||0}`,result:String(b.kind==='wicket'?'W':event(b).bat_runs||0)}))});
      }
    }
  }
  return packages.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||Number(b.matchID)-Number(a.matchID));
}
function r2Config() {
  const config = {
    account: process.env.R2_ACCOUNT_ID,
    access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  };
  return Object.values(config).every(Boolean) ? config : null;
}
function r2ObjectKey(clip, config = r2Config()) {
  if (!config || !clip?.url) return null;
  try {
    return require('./clip-object.cjs').clipObjectKey(clip, config, process.env.R2_PUBLIC_BASE_URL);
  } catch {
    return null;
  }
}
async function r2ObjectExists(key, config) {
  if (!key || !config) return false;
  try {
    const signed = require('./r2-usage.cjs').signedObjectRequest(config, key, 'HEAD');
    const response = await fetch(signed.url, {
      method: 'HEAD',
      headers: signed.headers,
      signal: AbortSignal.timeout(7000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
function install(app, authenticated, deps = {}) {
  const db = () => getFirestore('criccricket');
  const rawDoc = id => db().collection('shorts_engagement').doc(id);
  const legacyDoc = id => db().collection('shorts_engagement').doc(digest(id));
  const resolveDoc = async id => {
    const current = rawDoc(id);
    if ((await current.get()).exists) return current;
    const legacy = legacyDoc(id);
    if (!(await legacy.get()).exists) return current;
    const currentHasChildren = await Promise.all(['likes','views','comments'].map(name=>current.collection(name).limit(1).get()));
    return currentHasChildren.some(snapshot=>!snapshot.empty) ? current : legacy;
  };
  const valid = async (req,res,next) => {
    if (!/^rtdb-ball-\d+-\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid clip'});
    if (req.simulatorPreview) {
      try {
        const data = await require('./simulator-preview.cjs').data();
        req.clip = selectClip([...Object.values(data.scorers), ...data.archives], req.params.id, data.rules);
        if (!req.clip) return res.status(404).json({ error: 'Clip is unavailable' });
        req.engagementRef = await resolveDoc(req.params.id); return next();
      } catch { return res.status(503).json({ error: 'Clips could not load' }); }
    }
    try { const verifiedPhone = req.user ? (await getAuth().getUser(req.user.uid)).phoneNumber : ""; req.clip = await findClip(req.params.id, verifiedPhone); if (!req.clip) return res.status(404).json({error:'Clip is unavailable'}); req.engagementRef = await resolveDoc(req.params.id); next(); }
    catch { res.status(503).json({error:'Clips could not load'}); }
  };
  const limited = deps.rateLimit || (async (req,res,next) => {
    if (req.simulatorPreview) return next();
    try {
      const minute = Math.floor(Date.now()/60000), scopes = [];
      if (req.user?.uid) scopes.push({id:`user_${digest(req.user.uid)}_${minute}`,max:30});
      if (req.ip) scopes.push({id:`ip_${digest(req.ip)}_${minute}`,max:300});
      if (!scopes.length) return res.status(429).json({error:'Please wait before trying again'});
      const refs=scopes.map(scope=>db().collection('shorts_rate_limits').doc(scope.id));
      await db().runTransaction(async tx=>{
        const snapshots=await Promise.all(refs.map(ref=>tx.get(ref)));
        if(snapshots.some((snapshot,index)=>(snapshot.data()?.count||0)>=scopes[index].max))throw Error('RATE');
        refs.forEach((ref,index)=>tx.set(ref,{count:(snapshots[index].data()?.count||0)+1,expiresAt:new Date(Date.now()+120000)}));
      }); next();
    } catch { res.status(429).json({error:'Please wait before trying again'}); }
  });
  const optionallyAuthenticated = async (req,res,next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'').trim();
    if (!token) return next();
    try { req.user = await getAuth().verifyIdToken(token); next(); }
    catch { res.status(401).json({error:'Please sign in again'}); }
  };
  app.get('/api/my-performance',authenticated,limited,async(req,res)=>{
    try {
      if (req.simulatorPreview) return res.set('Cache-Control','private,no-store')
        .json({ ok: true, ...await require('./simulator-preview.cjs').performance(req) });
      if (deps.performanceForRequest) {
        return res.set('Cache-Control','private,no-store').json({ ok: true, ...await deps.performanceForRequest(req) });
      }
      const user=await getAuth().getUser(req.user.uid);
      const result=await performanceForPhone(user.phoneNumber);
      res.set('Cache-Control','private,no-store').json({ok:true,...result});
    }catch{res.status(503).json({ok:false,error:'Performance data is temporarily unavailable. Check Firebase connection and retry.',diagnostic:{status:'data_source_unavailable'}});}
  });
  require('./my-performance-api.cjs').install(app, authenticated, {
    analyticsForRequest: deps.analyticsForRequest,
    getAuth: () => getAuth(),
    getPlayerMappings: playerMappings,
    getArchives: async () => {
      const [payloads, visibility] = await Promise.all([
        catalogs(), getDatabaseWithUrl(DBURL).ref('app_visibility').get()
      ]);
      const rules = visibility.val() || {};
      return payloads.filter(payload => {
        if (!payload?.archive_manifest) return false;
        const match = rows(payload.tables?.matches).find(row =>
          String(row.match_uid || '') === String(payload.archive_manifest.match_uid)
          || String(row.id) === String(payload.archive_manifest.match_id));
        return match && require('./admin-visibility.cjs').allowsClip(
          String(match.id), String(match.tournament_id), rules, payload.installation_id
        );
      });
    },
    rateLimit: limited
  });
  app.get('/api/shorts/:id', limited, valid, async (req,res) => {
    try {
      const parent=req.engagementRef;
      const [likes,views,comments]=await Promise.all([
        parent.collection('likes').count().get(),
        parent.collection('views').count().get(),
        parent.collection('comments').where('hidden','==',false).count().get(),
      ]);
      res.set('Cache-Control','no-store').json({ok:true,likes:likes.data().count,views:views.data().count,comments:comments.data().count});
    } catch { res.status(503).json({error:'Shorts stats unavailable'}); }
  });
  app.get('/api/shorts/:id/me',authenticated,limited,valid,async(req,res)=>{
    try {
      const user = await getAuth().getUser(req.user.uid);
      const owned = ownsBall(req.clip.tables,req.clip.matchID,req.clip.ballID,user.phoneNumber);
      const config = r2Config();
      const key = owned ? r2ObjectKey(req.clip.ball.clip, config) : null;
      const [liked, storedInR2] = await Promise.all([
        req.engagementRef.collection('likes').doc(req.user.uid).get(),
        r2ObjectExists(key, config),
      ]);
      res.set('Cache-Control','private,no-store').json({liked:liked.exists,canDownload:owned && storedInR2});
    }
    catch {res.status(503).json({error:'Permissions could not load'});}
  });
  app.put('/api/shorts/:id/like',authenticated,limited,valid,async(req,res)=>{
    if(typeof req.body?.liked!=='boolean')return res.status(400).json({error:'Invalid like'});
    try {
      const like=req.engagementRef.collection('likes').doc(req.user.uid);
      await db().runTransaction(async tx=>{const old=await tx.get(like);if(old.exists===req.body.liked)return;
        if(req.body.liked)tx.set(like,{createdAt:FieldValue.serverTimestamp()});else tx.delete(like);});
      res.json({ok:true});
    }catch{res.status(503).json({error:'Like could not save'});}
  });
  app.post('/api/shorts/:id/view',limited,valid,async(req,res)=>{
    if(!/^[a-f0-9-]{36}$/i.test(req.body?.device||''))return res.status(400).json({error:'Invalid view session'});
    try {const view=req.engagementRef.collection('views').doc(digest(req.body.device+new Date().toISOString().slice(0,10)));
      await db().runTransaction(async tx=>{const seen=await tx.get(view);if(!seen.exists)tx.set(view,{at:FieldValue.serverTimestamp()});});res.json({ok:true});
    }catch{res.status(503).json({error:'View could not save'});}
  });
  app.get('/api/shorts/:id/comments',optionallyAuthenticated,limited,valid,async(req,res)=>{
    try {const list=await req.engagementRef.collection('comments').orderBy('createdAt','desc').limit(100).get();
      res.set('Cache-Control','no-store').json({comments:list.docs.filter(x=>!x.data().hidden).map(x=>({id:x.id,authorId:digest(x.data().uid||'').slice(0,24),isMine:req.user?.uid===x.data().uid,name:x.data().name,text:x.data().text,createdAt:x.data().createdAt?.toDate().toISOString()}))});
    }catch{res.status(503).json({error:'Comments could not load'});}
  });
  app.post('/api/shorts/:id/comments',authenticated,limited,valid,async(req,res)=>{
    const text=stripControlCharacters(String(req.body?.text||'').trim());
    if(!text||text.length>500)return res.status(400).json({error:'Comment must contain 1-500 characters'});
    try {const user=await getAuth().getUser(req.user.uid);const comment=req.engagementRef.collection('comments').doc();
      const name=String(user.displayName||'Cricket fan').slice(0,100);
      await comment.set({uid:req.user.uid,name,text,createdAt:FieldValue.serverTimestamp(),hidden:false});res.json({ok:true});
    }catch{res.status(503).json({error:'Comment could not save'});}
  });
  app.delete('/api/shorts/:id/comments/:comment',authenticated,limited,valid,async(req,res)=>{
    try {const comment=req.engagementRef.collection('comments').doc(req.params.comment);
      await db().runTransaction(async tx=>{const item=await tx.get(comment);if(!item.exists)return;if(item.data().uid!==req.user.uid)throw Error('FORBIDDEN');tx.delete(comment);});res.json({ok:true});
    }catch{res.status(403).json({error:'Comment could not be deleted'});}
  });
  app.post('/api/shorts/:id/comments/:comment/report',authenticated,limited,valid,async(req,res)=>{
    try {const comment=req.engagementRef.collection('comments').doc(req.params.comment);if(!(await comment.get()).exists)return res.status(404).json({error:'Comment unavailable'});
      await db().collection('shorts_reports').doc(digest(`${req.params.id}:${req.params.comment}:${req.user.uid}`)).set({clipId:req.params.id,commentId:req.params.comment,reporter:req.user.uid,status:'pending',createdAt:FieldValue.serverTimestamp()});res.json({ok:true});
    }catch{res.status(503).json({error:'Report could not save'});}
  });
  app.post('/api/shorts/:id/download',authenticated,limited,valid,async(req,res)=>{
    try {
      const user=await getAuth().getUser(req.user.uid);
      if(!ownsBall(req.clip.tables,req.clip.matchID,req.clip.ballID,user.phoneNumber))return res.status(403).json({error:'Download only your batting/bowling clips. Sign in with the number attached to your scoring player profile.'});
      if(!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET)return res.status(503).json({error:'Private clip downloads are not configured'});
      let key;
      const config = r2Config();
      key = r2ObjectKey(req.clip.ball.clip, config);
      if (!key) return res.status(403).json({error:'Only original R2 video clips can be downloaded'});
      const signed=require('./r2-usage.cjs').signedObjectRequest(config,key);
      const upstream=await fetch(signed.url,{headers:signed.headers,signal:AbortSignal.timeout(180000)});
      if(!upstream.ok)return res.status(502).json({error:upstream.status===404?'Original clip is missing from R2. Regenerate this clip.':[401,403].includes(upstream.status)?'R2 read access denied. Check the server bucket token.':`R2 clip download failed (${upstream.status})`});
      res.set('Content-Type',upstream.headers.get('content-type')||'video/mp4');res.set('Cache-Control','private,no-store');
      res.set('Content-Disposition',`attachment; filename="${req.params.id}.mp4"`);
      const {Readable}=require('node:stream');const stream=Readable.fromWeb(upstream.body);
      res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{if(!res.headersSent)res.status(503).json({error:'Download unavailable'});else res.destroy();}
  });
}
module.exports={install,ownsBall,phone,performancePackages,applyPlayerDirectory,playerMappings,selectClip, invalidateCatalog: () => { catalogCache = null; }};
