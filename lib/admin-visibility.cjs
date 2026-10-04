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
module.exports = { install, isAuthorizedDevice, validChange, publicVisibility };
