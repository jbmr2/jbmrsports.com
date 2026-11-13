const { getDatabaseWithUrl } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");
const DATABASE_URL = "https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app";
const SCORER = "80c7442eb2ca4aeabfb6779128d91b8a";
const SCORERS = [SCORER, "994bd24b405943c790d9b8b32d3e13e2", "6fca9fc7d4974919a43b149d32717119"];
function feedScorerInstallations(value) {
  const ids = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "installation_id" || key === "scorer_installation") && typeof child === "string" && child.trim()) ids.add(child.trim());
      visit(child);
    }
  };
  visit(value);
  return [...ids];
}
let lastArchiveDiagnostics = { invalidArchives: 0, invalidMatchUIDs: [] };
function latestScorer(payloads) {
  const valid = payloads.filter(row => row && row.tables)
    .sort((a, b) => Number(a.synced_at || 0) - Number(b.synced_at || 0));
  if (!valid.length) return null;

  const latest = valid.at(-1);
  const tables = {};
  for (const payload of valid) {
    const source = String(payload.installation_id || "");
    for (const [name, value] of Object.entries(payload.tables || {})) {
      const rows = Array.isArray(value)
        ? Object.fromEntries(value.map((row, index) => {
          const id = String(row?.id ?? index);
          return [source ? `${source}:${id}` : id, { ...row, source_installation_id: source }];
        }))
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, row]) => {
            const id = String(row?.id ?? key);
            return [source ? `${source}:${id}` : id, { ...row, source_installation_id: source }];
          }))
          : {};
      tables[name] = { ...(tables[name] || {}), ...rows };
    }
  }
  return { ...latest, tables };
}

function isAuthorizedDevice(token, configuredHash = process.env.ADMIN_DEVICE_TOKEN_SHA256 || "") {
  if (!/^[a-f0-9]{64}$/.test(configuredHash) || !/^[a-f0-9]{64}$/.test(String(token || ""))) return false;
  const { createHash, timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(configuredHash, "hex"));
}
function isSafeVisibilityID(value) {
  const id = String(value || "");
  // RTDB child keys must never receive path separators or traversal characters.
  // Tournament/match IDs are usually numeric, but archived/imported records may
  // use stable slugs or UUID-like IDs. Keep the accepted alphabet deliberately
  // narrow while supporting both plain and source-qualified identifiers.
  return /^(?:[A-Za-z0-9_-]{1,128}|[a-f0-9]{32}:[A-Za-z0-9_-]{1,128})$/.test(id);
}
function validChange(body) {
  if (body?.scope === "settings" && body?.id === "ads") return typeof body?.show === "boolean";
  return ["tournaments", "matches"].includes(body?.scope)
    && isSafeVisibilityID(body?.id) && typeof body?.show === "boolean";
}
function publicVisibility(raw) {
  const result = { tournaments: {}, matches: {} };
  for (const scope of Object.keys(result)) {
    for (const [id, row] of Object.entries(raw?.[scope] || {})) {
      if (isSafeVisibilityID(id) && typeof row?.show === "boolean") result[scope][id] = { show: row.show };
    }
  }
  result.settings = { ads: { show: raw?.settings?.ads?.show !== false } };
  return result;
}
async function archives() {
  const db = getFirestore("criccricket");
  let invalidArchives = 0;
  const invalidMatchUIDs = [];
  const payloads = await require("./match-archives.cjs").readMatchArchives(db, {
    onInvalidArchive: ({ matchUID }) => {
      invalidArchives += 1;
      invalidMatchUIDs.push(String(matchUID));
      console.warn("JBMR incomplete archive excluded", matchUID);
    }
  });
  lastArchiveDiagnostics = { invalidArchives, invalidMatchUIDs };
  console.info("JBMR Firestore archive query", JSON.stringify({ collection: "match_archives", completed: payloads.length, invalidArchives,
    ballRecords: payloads.reduce((total, payload) => total + Number(payload.archive_manifest?.ball_record_count || 0), 0) }));
  return require('./archive-media.cjs').preserveArchiveMedia(payloads);
}
function archiveDiagnostics() { return { ...lastArchiveDiagnostics, invalidMatchUIDs: [...lastArchiveDiagnostics.invalidMatchUIDs] }; }
function install(app) {
  const db = () => getDatabaseWithUrl(DATABASE_URL);
  const adminOnly = (req, res, next) => {
    if (!process.env.ADMIN_DEVICE_TOKEN_SHA256) return res.status(503).json({ ok: false, error: "Admin device has not been configured on the server" });
    if (!isAuthorizedDevice(req.headers["x-admin-device-token"])) return res.status(403).json({ ok: false, error: "This admin device is not authorized" });
    next();
  };
  require("./manual-video-ads.cjs").install(app, adminOnly);
  app.get("/api/visibility", async (_req, res) => {
    try {
      const snapshot = await db().ref("app_visibility").get();
      res.set("Cache-Control", "no-store").json({ ok: true, visibility: publicVisibility(snapshot.val()) });
    } catch { res.status(503).json({ ok: false, error: "Visibility permissions could not load" }); }
  });
  app.get("/api/admin/players", adminOnly, async (_req, res) => {
    try {
      const [live, completed, links] = await Promise.all([db().ref(`scorers_public/${SCORER}`).get(), archives(), db().ref(`player_download_links/${SCORER}`).get()]);
      const all = new Map();
      for (const payload of [live.val(), ...completed].filter(Boolean)) {
        for (const row of Object.values(payload.tables?.players || {})) {
          if (!row || !/^\d+$/.test(String(row.id))) continue;
          all.set(String(row.id), { id: String(row.id), name: row.name || "Player", phone: links.val()?.[String(row.id)]?.phone ?? "" });
        }
      }
      res.set("Cache-Control", "private,no-store").json({players: Array.from(all.values()).sort((a,b)=>a.name.localeCompare(b.name))});
    } catch { res.status(503).json({error:"Player links could not load"}); }
  });
  app.put("/api/admin/players/:id/phone", adminOnly, async (req, res) => {
    const phone = String(req.body.phone || "").trim();
    if (!/^\d{1,20}$/.test(req.params.id) || (phone !== "" && !/^\d{10}$/.test(phone))) return res.status(400).json({error:"Enter the player's verified 10-digit mobile number"});
    try {
      const [live, completed] = await Promise.all([db().ref(`scorers_public/${SCORER}`).get(), archives()]);
      if (![live.val(),...completed].filter(Boolean).some(p=>Object.values(p.tables?.players||{}).some(x=>String(x?.id)===req.params.id))) return res.status(404).json({error:"Scoring player not found"});
      await db().ref(`player_download_links/${SCORER}/${req.params.id}`).set({phone,updatedAt:new Date().toISOString()});
      require("./shorts.cjs").invalidateCatalog();
      res.json({ok:true});
    } catch { res.status(503).json({error:"Player link could not save"}); }
  });
  app.get("/api/admin/shorts-reports",adminOnly,async(_req,res)=>{
    try {
      const db = getFirestore("criccricket");
      const list = await db.collection("shorts_reports").where("status","==","pending").limit(50).get();
      const reports=await Promise.all(list.docs.map(async item=>{
        const row=item.data();const key=require("node:crypto").createHash("sha256").update(row.clipId).digest("hex");
        let comment=await db.collection("shorts_engagement").doc(row.clipId).collection("comments").doc(row.commentId).get();
        if (!comment.exists) comment=await db.collection("shorts_engagement").doc(key).collection("comments").doc(row.commentId).get();
        return {id:item.id,clipId:row.clipId,commentId:row.commentId,text:comment.data()?.text||"Deleted comment",name:comment.data()?.name||"User"};
      }));res.json({reports});
    }catch{res.status(503).json({error:"Comment reports unavailable"});}
  });
  app.put("/api/admin/shorts-reports/:id",adminOnly,async(req,res)=>{
    if(!/^[A-Za-z0-9_-]{1,512}$/.test(req.params.id)||!["hide","dismiss"].includes(req.body.action))return res.status(400).json({error:"Invalid report decision"});
    try {
      const db=getFirestore("criccricket"),report=db.collection("shorts_reports").doc(req.params.id);
      await db.runTransaction(async tx=>{
        const row=(await tx.get(report)).data();if(!row)throw Error("Missing report");
        if (!/^rtdb-ball-\d+-\d+$/.test(row.clipId) || typeof row.commentId !== "string" || row.commentId.includes("/")) throw Error("Invalid report");
        const key=require("node:crypto").createHash("sha256").update(row.clipId).digest("hex");
        let parent=db.collection("shorts_engagement").doc(row.clipId),comment=parent.collection("comments").doc(row.commentId);
        let item=await tx.get(comment);
        if (!item.exists) { parent=db.collection("shorts_engagement").doc(key); comment=parent.collection("comments").doc(row.commentId); item=await tx.get(comment); }
        const stats=await tx.get(parent);
        if(req.body.action==="hide"&&item.exists&&!item.data().hidden){tx.update(comment,{hidden:true});tx.set(parent,{comments:Math.max(0,(stats.data()?.comments||0)-1)},{merge:true});}
        tx.update(report,{status:req.body.action==="hide"?"removed":"dismissed",resolvedAt:new Date()});
      });res.json({ok:true});
    }catch{res.status(503).json({error:"Report action could not save"});}
  });
  app.get("/api/admin/r2-usage", adminOnly, async (_req, res) => {
    try {
      const usage = await require("./r2-usage.cjs").getUsage();
      res.set("Cache-Control", "private, no-store").json({ ok: true, usage });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message.startsWith("R2") ? error.message : "R2 storage is temporarily unavailable" });
    }
  });
  app.get("/api/admin/catalog", adminOnly, async (_req, res) => {
    try {
      const [feedSnapshot, completed, visibility] = await Promise.all([
        db().ref("tournament_feed").get(), archives(), db().ref("app_visibility").get()
      ]);
      const feedIDs = feedScorerInstallations(feedSnapshot.val());
      const sourceIDs = [...new Set([...SCORERS, ...feedIDs])];
      const scorers = await Promise.all(sourceIDs.map(id => db().ref(`scorers_public/${id}`).get()));
      const scorerPayloads = scorers.map((snapshot, index) => ({ ...(snapshot.val() || {}), installation_id: sourceIDs[index] }));
      res.set("Cache-Control", "private, no-store").json({ ok: true, scorer: latestScorer(scorerPayloads), archives: completed, archiveDiagnostics: archiveDiagnostics(), visibility: publicVisibility(visibility.val()) });
    } catch { res.status(502).json({ ok: false, error: "Admin catalog could not load" }); }
  });
  app.put("/api/admin/visibility", adminOnly, async (req, res) => {
    if (!validChange(req.body)) return res.status(400).json({ ok: false, error: "Invalid visibility change" });
    try {
      const { scope, id, show } = req.body;
      await db().ref(`app_visibility/${scope}/${id}`).set({ show });
      res.json({ ok: true });
    } catch { res.status(502).json({ ok: false, error: "Permission could not be saved" }); }
  });
}
function scopedVisibilityID(installationID, id) {
  return installationID && /^[a-f0-9]{32}$/.test(String(installationID)) ? `${installationID}:${id}` : String(id);
}
function allowsClip(matchID, tournamentID, rules, installationID = "") {
  const scopedMatch = scopedVisibilityID(installationID, matchID);
  const tournamentIDs = Array.isArray(tournamentID) ? tournamentID : [tournamentID];
  const scopedTournaments = tournamentIDs.map(id => scopedVisibilityID(installationID, id));
  // Accept numeric IDs, source-qualified IDs, and the tournament UID. This keeps
  // admin visibility compatible with both RTDB feed records and Firestore archives.
  const parentValues = tournamentIDs.flatMap((id, index) => [
    rules?.tournaments?.[String(id)]?.show,
    rules?.tournaments?.[scopedTournaments[index]]?.show
  ]).filter(value => typeof value === 'boolean');
  const parent = parentValues.includes(false) ? false : parentValues.includes(true) ? true : undefined;
  if (parent === false) return false;
  const explicit = rules?.matches?.[scopedMatch]?.show ?? rules?.matches?.[matchID]?.show;
  return typeof explicit === "boolean" ? explicit : parent === true;
}
module.exports = { install, isAuthorizedDevice, isSafeVisibilityID, validChange, publicVisibility, archives, archiveDiagnostics, allowsClip, scopedVisibilityID, latestScorer };
