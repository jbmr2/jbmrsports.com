const { createHash } = require('node:crypto');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const SCORER = '80c7442eb2ca4aeabfb6779128d91b8a';
const DBURL = 'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app';
const digest = value => createHash('sha256').update(value).digest('hex');
const rows = value => Object.values(value || {}).filter(x => x && typeof x === 'object');
function phone(value) { const digits = String(value || '').replace(/\D/g, ''); return /^91\d{10}$/.test(digits) ? digits.slice(2) : /^\d{10}$/.test(digits) ? digits : ''; }
function playerPhones(player) {
  return Object.prototype.hasOwnProperty.call(player, 'download_phone') ? [player.download_phone] : [player.phone,player.phone_number,player.mobile,player.mobile_number,player.contact_number];
}
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
let catalogCache, loadingCatalog;
async function catalogs() {
  if (catalogCache && Date.now() - catalogCache.at < 60000) return catalogCache.payloads;
  if (!loadingCatalog) loadingCatalog = (async () => {
    const [live, archived, links] = await Promise.all([
      getDatabaseWithUrl(DBURL).ref(`scorers_public/${SCORER}`).get(),
      require('./admin-visibility.cjs').archives(),
      getDatabaseWithUrl(DBURL).ref(`player_download_links/${SCORER}`).get()
    ]);
    const payloads = [live.val(), ...archived].filter(Boolean);
    const mapping = links.val() || {};
    for (const payload of payloads) for (const player of rows(payload.tables?.players)) {
      if (mapping[String(player.id)] && typeof mapping[String(player.id)].phone === 'string') player.download_phone = mapping[String(player.id)].phone;
    }
    catalogCache = { at: Date.now(), payloads }; return payloads;
  })().finally(() => { loadingCatalog = null; });
  return loadingCatalog;
}
async function findClip(id) {
  const match = /^rtdb-ball-(\d+)-(\d+)$/.exec(id);
  if (!match) return null;
  const visibility = (await getDatabaseWithUrl(DBURL).ref('app_visibility').get()).val() || {};
  for (const payload of await catalogs()) {
    const tables = payload.tables || {};
    const row = rows(tables.matches).find(x => String(x.id) === match[1]);
    if (!row) continue;
    if (!require('./admin-visibility.cjs').allowsClip(match[1], String(row.tournament_id), visibility)) return null;
    const innings = new Set(rows(tables.innings).filter(x => String(x.match_id) === match[1]).map(x => String(x.id)));
    const ball = rows(tables.balls).find(x => String(x.id) === match[2] && innings.has(String(x.innings_id)));
    if (ball && (ball.clip_status === 'ready' || ball.clip?.status === 'ready') && ball.clip?.url) return {tables, ball, matchID:match[1], ballID:match[2]};
  }
  return null;
}
function performancePackages(payloads, verifiedPhone, visibility) {
  const packages = [], seen = new Set();
  for (const payload of payloads) {
    const tables = payload.tables || {};
    const players = rows(tables.players).filter(player => playerPhones(player).some(value => phone(value) && phone(value) === phone(verifiedPhone)));
    for (const player of players) for (const inning of rows(tables.innings)) {
      const matchID=String(inning.match_id), match=rows(tables.matches).find(x=>String(x.id)===matchID);
      if(!match || !require('./admin-visibility.cjs').allowsClip(matchID,String(match.tournament_id),visibility))continue;
      const balls=rows(tables.balls).filter(x=>String(x.innings_id)===String(inning.id)).sort((a,b)=>Number(a.seq)-Number(b.seq));
      const event=b=>{let e=b.event||b.event_json||{};if(typeof e==='string'){try{return JSON.parse(e)}catch{return {}}}return e};
      const batting=balls.filter(b=>String(b.striker_id)===String(player.id));
      const wickets=balls.filter(b=>String(b.bowler_id)===String(player.id)&&['bowled','caught','caught and bowled','caught & bowled','lbw','stumped','hit wicket'].includes(String(event(b).dismissal||'').toLowerCase().replace(/_/g,' ')));
      for(const role of ['batting','bowling']) {
        const selected=role==='batting'?batting:wickets;
        if(!selected.length)continue;
        const id=`${matchID}-${inning.id}-${player.id}-${role}`;
        if(seen.has(id))continue;seen.add(id);
        const ready=selected.filter(b=>(b.clip_status==='ready'||b.clip?.status==='ready')&&b.clip?.url);
        const runs=batting.reduce((n,b)=>n+Number(event(b).bat_runs||0),0), faced=batting.filter(b=>!Number(event(b).wide_runs||0)&&!event(b).dead_ball).length;
        const team=id=>rows(tables.teams).find(t=>String(t.id)===String(id))?.name||'Team';
        packages.push({id,matchID,playerName:player.name||'Player',role,runs,balls:faced,wickets:wickets.length,totalClips:selected.length,
          title:role==='batting'?`${runs} Runs`:`${wickets.length} ${wickets.length===1?'Wicket':'Wickets'}`,
          matchTitle:`${team(match.team_a_id)} vs ${team(match.team_b_id)}`,matchNumber:match.match_no||match.match_number||match.id,
          tournament:rows(tables.tournaments).find(t=>String(t.id)===String(match.tournament_id))?.name||'Tournament',
          updatedAt:match.ended_at||match.created_at||'',clips:ready.map(b=>({id:`rtdb-ball-${matchID}-${b.id}`,matchID,ballID:String(b.id),videoURL:b.clip.url,
          label:`Over ${b.over_index||0} · Ball ${b.seq||0}`,result:String(b.kind==='wicket'?'W':event(b).bat_runs||0)}))});
      }
    }
  }
  return packages.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||Number(b.matchID)-Number(a.matchID));
}
function install(app, authenticated) {
  const db = () => getFirestore('criccricket');
  const doc = id => db().collection('shorts_engagement').doc(digest(id));
  const valid = async (req,res,next) => {
    if (!/^rtdb-ball-\d+-\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid clip'});
    try { req.clip = await findClip(req.params.id); if (!req.clip) return res.status(404).json({error:'Clip is unavailable'}); next(); }
    catch { res.status(503).json({error:'Clips could not load'}); }
  };
  const limited = async (req,res,next) => {
    try {
      const key = digest(`${req.user.uid}:${Math.floor(Date.now()/60000)}`);
      await db().runTransaction(async tx => {
        const ref=db().collection('shorts_rate_limits').doc(key), row=(await tx.get(ref)).data();
        if ((row?.count||0)>=30) throw Error('RATE');
        tx.set(ref,{count:(row?.count||0)+1, expiresAt:new Date(Date.now()+120000)});
      }); next();
    } catch { res.status(429).json({error:'Please wait before trying again'}); }
  };
  app.get('/api/my-performance',authenticated,async(req,res)=>{
    try {
      const user=await getAuth().getUser(req.user.uid);
      const [payloads,rules]=await Promise.all([catalogs(),getDatabaseWithUrl(DBURL).ref('app_visibility').get()]);
      const linked=payloads.some(p=>rows(p.tables?.players).some(player=>playerPhones(player).some(value=>phone(value)&&phone(value)===phone(user.phoneNumber))));
      res.set('Cache-Control','private,no-store').json({ok:true,linked,packages:performancePackages(payloads,user.phoneNumber,rules.val()||{})});
    }catch{res.status(503).json({error:'Your performance packages could not load'});}
  });
  app.get('/api/shorts/:id', valid, async (req,res) => {
    try {
      const row=(await doc(req.params.id).get()).data() || {};
      res.set('Cache-Control','no-store').json({ok:true,likes:row.likes||0,views:row.views||0,comments:row.comments||0});
    } catch { res.status(503).json({error:'Shorts stats unavailable'}); }
  });
  app.get('/api/shorts/:id/me',authenticated,valid,async(req,res)=>{
    try { res.json({liked:(await doc(req.params.id).collection('likes').doc(req.user.uid).get()).exists, canDownload:ownsBall(req.clip.tables,req.clip.matchID,req.clip.ballID,(await getAuth().getUser(req.user.uid)).phoneNumber)}); }
    catch {res.status(503).json({error:'Permissions could not load'});}
  });
  app.put('/api/shorts/:id/like',authenticated,limited,valid,async(req,res)=>{
    if(typeof req.body.liked!=='boolean')return res.status(400).json({error:'Invalid like'});
    try {
      const ref=doc(req.params.id),like=ref.collection('likes').doc(req.user.uid);
      await db().runTransaction(async tx=>{const [row,old]=await Promise.all([tx.get(ref),tx.get(like)]);if(old.exists===req.body.liked)return;
        if(req.body.liked)tx.set(like,{createdAt:FieldValue.serverTimestamp()});else tx.delete(like);
        tx.set(ref,{likes:Math.max(0,(row.data()?.likes||0)+(req.body.liked?1:-1)),clipId:req.params.id},{merge:true});});
      res.json({ok:true});
    }catch{res.status(503).json({error:'Like could not save'});}
  });
  app.post('/api/shorts/:id/view',valid,async(req,res)=>{
    if(!/^[a-f0-9-]{36}$/i.test(req.body.device||''))return res.status(400).json({error:'Invalid view session'});
    try {const ref=doc(req.params.id),view=ref.collection('views').doc(digest(req.body.device+new Date().toISOString().slice(0,10)));
      await db().runTransaction(async tx=>{const [seen,row]=await Promise.all([tx.get(view),tx.get(ref)]);if(seen.exists)return;tx.set(view,{at:FieldValue.serverTimestamp()});tx.set(ref,{views:(row.data()?.views||0)+1,clipId:req.params.id},{merge:true});});res.json({ok:true});
    }catch{res.status(503).json({error:'View could not save'});}
  });
  app.get('/api/shorts/:id/comments',valid,async(req,res)=>{
    try {const list=await doc(req.params.id).collection('comments').orderBy('createdAt','desc').limit(100).get();
      res.set('Cache-Control','no-store').json({comments:list.docs.filter(x=>!x.data().hidden).map(x=>({id:x.id,uid:x.data().uid,name:x.data().name,text:x.data().text,createdAt:x.data().createdAt?.toDate().toISOString()}))});
    }catch{res.status(503).json({error:'Comments could not load'});}
  });
  app.post('/api/shorts/:id/comments',authenticated,limited,valid,async(req,res)=>{
    const text=String(req.body.text||'').trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
    if(!text||text.length>500)return res.status(400).json({error:'Comment must contain 1-500 characters'});
    try {const user=await getAuth().getUser(req.user.uid);const ref=doc(req.params.id),comment=ref.collection('comments').doc();
      await db().runTransaction(async tx=>{const row=await tx.get(ref);tx.set(comment,{uid:req.user.uid,name:user.displayName||'Cricket fan',text,createdAt:FieldValue.serverTimestamp(),hidden:false});tx.set(ref,{comments:(row.data()?.comments||0)+1},{merge:true});});res.json({ok:true});
    }catch{res.status(503).json({error:'Comment could not save'});}
  });
  app.delete('/api/shorts/:id/comments/:comment',authenticated,valid,async(req,res)=>{
    try {const ref=doc(req.params.id),comment=ref.collection('comments').doc(req.params.comment);
      await db().runTransaction(async tx=>{const [row,item]=await Promise.all([tx.get(ref),tx.get(comment)]);if(!item.exists)return;if(item.data().uid!==req.user.uid)throw Error('FORBIDDEN');tx.delete(comment);tx.set(ref,{comments:Math.max(0,(row.data()?.comments||0)-(item.data()?.hidden?0:1))},{merge:true});});res.json({ok:true});
    }catch{res.status(403).json({error:'Comment could not be deleted'});}
  });
  app.post('/api/shorts/:id/comments/:comment/report',authenticated,limited,valid,async(req,res)=>{
    try {const comment=doc(req.params.id).collection('comments').doc(req.params.comment);if(!(await comment.get()).exists)return res.status(404).json({error:'Comment unavailable'});
      await db().collection('shorts_reports').doc(digest(`${req.params.id}:${req.params.comment}:${req.user.uid}`)).set({clipId:req.params.id,commentId:req.params.comment,reporter:req.user.uid,status:'pending',createdAt:FieldValue.serverTimestamp()});res.json({ok:true});
    }catch{res.status(503).json({error:'Report could not save'});}
  });
  app.post('/api/shorts/:id/download',authenticated,valid,async(req,res)=>{
    try {
      const user=await getAuth().getUser(req.user.uid);
      if(!ownsBall(req.clip.tables,req.clip.matchID,req.clip.ballID,user.phoneNumber))return res.status(403).json({error:'Download only your batting/bowling clips. Sign in with the number attached to your scoring player profile.'});
      const base=process.env.R2_PUBLIC_BASE_URL;
      if(!base || !process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET)return res.status(503).json({error:'Private clip downloads are not configured'});
      const original=new URL(req.clip.ball.clip.url),prefix=new URL(base);
      const root=prefix.pathname.replace(/\/$/,'')+'/';
      if(original.origin!==prefix.origin||!original.pathname.startsWith(root))return res.status(403).json({error:'Only original R2 clips can be downloaded'});
      const key=decodeURIComponent(original.pathname.slice(root.length));
      if(!key||!/[.](mp4|mov|m4v)$/i.test(key))return res.status(403).json({error:'Original video file is unavailable'});
      const config={account:process.env.R2_ACCOUNT_ID,access:process.env.R2_ACCESS_KEY_ID,secret:process.env.R2_SECRET_ACCESS_KEY,bucket:process.env.R2_BUCKET};
      const signed=require('./r2-usage.cjs').signedObjectRequest(config,key);
      const upstream=await fetch(signed.url,{headers:signed.headers,signal:AbortSignal.timeout(180000)});
      if(!upstream.ok)return res.status(502).json({error:'R2 clip download failed'});
      res.set('Content-Type',upstream.headers.get('content-type')||'video/mp4');res.set('Cache-Control','private,no-store');
      res.set('Content-Disposition',`attachment; filename="${req.params.id}.mp4"`);
      const {Readable}=require('node:stream');const stream=Readable.fromWeb(upstream.body);
      res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{if(!res.headersSent)res.status(503).json({error:'Download unavailable'});else res.destroy();}
  });
}
module.exports={install,ownsBall,phone,performancePackages, invalidateCatalog: () => { catalogCache = null; }};
