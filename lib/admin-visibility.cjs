const { getDatabaseWithUrl } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");
const DATABASE_URL = "https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app";
const SCORER = "80c7442eb2ca4aeabfb6779128d91b8a";

function isAuthorizedDevice(token, configuredHash = process.env.ADMIN_DEVICE_TOKEN_SHA256 || "") {
  if (!/^[a-f0-9]{64}$/.test(configuredHash) || !/^[a-f0-9]{64}$/.test(String(token || ""))) return false;
  const { createHash, timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(configuredHash, "hex"));
}
function validChange(body) {
  if (body?.scope === "settings" && body?.id === "ads") return typeof body?.show === "boolean";
  return ["tournaments", "matches"].includes(body?.scope)
    && /^\d{1,20}$/.test(String(body?.id || "")) && typeof body?.show === "boolean";
}
function publicVisibility(raw) {
  const result = { tournaments: {}, matches: {} };
  for (const scope of Object.keys(result)) {
    for (const [id, row] of Object.entries(raw?.[scope] || {})) {
      if (/^\d{1,20}$/.test(id) && typeof row?.show === "boolean") result[scope][id] = { show: row.show };
    }
  }
  result.settings = { ads: { show: raw?.settings?.ads?.show !== false } };
  return result;
}
async function archives() {
  const db = getFirestore("criccricket");
  const docs = await db.collection("scoring_archives").doc(SCORER).collection("matches").get();
  const payloads = [];
  for (const doc of docs.docs) {
    const row = doc.data();
    if (row.status !== "completed" || !row.revision) continue;
    const chunks = await doc.ref.collection("revisions").doc(row.revision).collection("chunks").get();
    const parts = chunks.docs.sort((a,b) => a.id.localeCompare(b.id)).map(x => x.get("json"));
    if (parts.length !== Number(row.chunk_count) || parts.some(x => typeof x !== "string")) throw Error("Invalid archive");
    payloads.push(JSON.parse(parts.join("")));
  }
  return payloads;
}
function install(app) {
  const db = () => getDatabaseWithUrl(DATABASE_URL);
  const adminOnly = (req, res, next) => {
    if (!process.env.ADMIN_DEVICE_TOKEN_SHA256) return res.status(503).json({ ok: false, error: "Admin device has not been configured on the server" });
    if (!isAuthorizedDevice(req.headers["x-admin-device-token"])) return res.status(403).json({ ok: false, error: "This admin device is not authorized" });
    next();
  };
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
        const comment=await db.collection("shorts_engagement").doc(key).collection("comments").doc(row.commentId).get();
        return {id:item.id,clipId:row.clipId,commentId:row.commentId,text:comment.data()?.text||"Deleted comment",name:comment.data()?.name||"User"};
      }));res.json({reports});
    }catch{res.status(503).json({error:"Comment reports unavailable"});}
  });
  app.put("/api/admin/shorts-reports/:id",adminOnly,async(req,res)=>{
    if(!/^[a-f0-9]{64}$/.test(req.params.id)||!["hide","dismiss"].includes(req.body.action))return res.status(400).json({error:"Invalid report decision"});
    try {
      const db=getFirestore("criccricket"),report=db.collection("shorts_reports").doc(req.params.id);
      await db.runTransaction(async tx=>{
        const row=(await tx.get(report)).data();if(!row)throw Error("Missing report");
        const key=require("node:crypto").createHash("sha256").update(row.clipId).digest("hex");const parent=db.collection("shorts_engagement").doc(key),comment=parent.collection("comments").doc(row.commentId);
        const [item,stats]=await Promise.all([tx.get(comment),tx.get(parent)]);
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
      const [scorer, completed, visibility] = await Promise.all([
        db().ref(`scorers_public/${SCORER}`).get(), archives(), db().ref("app_visibility").get()
      ]);
      res.set("Cache-Control", "private, no-store").json({ ok: true, scorer: scorer.val(), archives: completed, visibility: publicVisibility(visibility.val()) });
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
function allowsClip(matchID, tournamentID, rules) {
  if (rules?.tournaments?.[tournamentID]?.show === false) return false;
  const explicit = rules?.matches?.[matchID]?.show;
  return typeof explicit === "boolean" ? explicit : rules?.tournaments?.[tournamentID]?.show === true;
}
module.exports = { install, isAuthorizedDevice, validChange, publicVisibility, archives, allowsClip };
