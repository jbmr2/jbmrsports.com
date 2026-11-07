const { createHash, createHmac, randomUUID } = require("node:crypto");
const { getDatabaseWithUrl } = require("firebase-admin/database");

const DATABASE_URL = "https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app";
const PATH = "manual_video_ad";
const MAX_BYTES = 100 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const keyFor = values => hmac(hmac(hmac(hmac(`AWS4${values.secret}`, values.day), "auto"), "s3"), "aws4_request");

function config() {
  const values = { account: process.env.R2_ACCOUNT_ID, access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET };
  if (!Object.values(values).every(Boolean)) throw Error("R2 storage is not configured on the server");
  return values;
}
function objectUri(bucket, key) {
  return `/${encode(bucket)}/${key.split("/").map(encode).join("/")}`;
}
function signedUploadURL(values, key, contentType, now = new Date()) {
  const host = `${values.account}.r2.cloudflarestorage.com`;
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${values.access}/${scope}`],
    ["X-Amz-Date", date], ["X-Amz-Expires", "300"],
    ["X-Amz-SignedHeaders", "content-type;host"],
  ].sort((a,b) => a[0].localeCompare(b[0])).map(([k,v]) => `${encode(k)}=${encode(v)}`).join("&");
  const canonical = ["PUT", objectUri(values.bucket, key), query,
    `content-type:${contentType}\nhost:${host}\n`, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`;
  const signature = createHmac("sha256", keyFor({ ...values, day })).update(stringToSign).digest("hex");
  return `https://${host}${objectUri(values.bucket, key)}?${query}&X-Amz-Signature=${signature}`;
}
function signedReadURL(values, key, now = new Date()) {
  const host = `${values.account}.r2.cloudflarestorage.com`;
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${values.access}/${scope}`],
    ["X-Amz-Date", date], ["X-Amz-Expires", "21600"], ["X-Amz-SignedHeaders", "host"],
  ].sort((a,b) => a[0].localeCompare(b[0])).map(([k,v]) => `${encode(k)}=${encode(v)}`).join("&");
  const canonical = ["GET", objectUri(values.bucket, key), query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const signature = createHmac("sha256", keyFor({ ...values, day }))
    .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
  return `https://${host}${objectUri(values.bucket, key)}?${query}&X-Amz-Signature=${signature}`;
}

function install(app, adminOnly) {
  const ref = () => getDatabaseWithUrl(DATABASE_URL).ref(PATH);
  app.get("/api/admin/manual-video-ad", adminOnly, async (_req, res) => {
    try {
      const value = (await ref().get()).val() || {};
      res.set("Cache-Control", "private, no-store").json({ enabled: value.enabled === true,
        title: value.title || "", fileName: value.fileName || "", size: Number(value.size) || 0,
        updatedAt: value.updatedAt || null, configured: Boolean(value.key) });
    } catch { res.status(503).json({ error: "Manual ad settings could not load" }); }
  });
  app.post("/api/admin/manual-video-ad/upload", adminOnly,
    require("express").raw({ type: "video/mp4", limit: MAX_BYTES }), async (req, res) => {
      const body = req.body;
      const name = String(req.headers["x-file-name"] || "manual-ad.mp4").replace(/[\\/\r\n\0]/g, "").slice(0, 120);
      if (!Buffer.isBuffer(body) || body.length < 1024 || body.length > MAX_BYTES || !/\.mp4$/i.test(name)) {
        return res.status(400).json({ error: "Choose a valid MP4 video under 100 MB" });
      }
      const key = `manual-ads/${randomUUID()}.mp4`;
      try {
        const values = config(), url = signedUploadURL(values, key, "video/mp4");
        const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "video/mp4" },
          body, signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw Error(`R2 upload failed (${response.status})`);
        res.json({ ok: true, key, fileName: name, size: body.length });
      } catch (error) {
        res.status(503).json({ error: error.message.startsWith("R2") ? error.message : "Ad video could not be uploaded" });
      }
    });
  app.put("/api/admin/manual-video-ad", adminOnly, async (req, res) => {
    const key = String(req.body?.key || "");
    const title = String(req.body?.title || "").trim().slice(0, 80);
    const fileName = String(req.body?.fileName || "").replace(/[\\/\r\n\0]/g, "").slice(0, 120);
    const size = Number(req.body?.size);
    const enabled = req.body?.enabled === true;
    if (!/^manual-ads\/[a-f0-9-]{36}\.mp4$/.test(key) || !title || !/\.mp4$/i.test(fileName) || !Number.isSafeInteger(size) || size < 1024 || size > MAX_BYTES) {
      return res.status(400).json({ error: "Upload an MP4 ad and enter a title first" });
    }
    try {
      await ref().set({ key, title, fileName, size, enabled, updatedAt: new Date().toISOString() });
      res.json({ ok: true });
    } catch { res.status(503).json({ error: "Manual ad settings could not save" }); }
  });
  const playlistRef = () => getDatabaseWithUrl(DATABASE_URL).ref("manual_video_ad_playlist");
  app.put("/api/admin/manual-video-ad/playlist", adminOnly, async (req, res) => {
    const ads = req.body?.ads;
    if (!Array.isArray(ads) || ads.length < 1 || ads.length > 10 || ads.some(ad =>
      !/^manual-ads\/[a-f0-9-]{36}\.mp4$/.test(String(ad?.key || "")) || typeof ad?.title !== "string")) {
      return res.status(400).json({ error: "Invalid pre-roll playlist" });
    }
    try {
      await playlistRef().set(ads.map(({ key, title }) => ({ key, title: title.slice(0, 80) })));
      res.json({ ok: true });
    } catch { res.status(503).json({ error: "Pre-roll playlist could not save" }); }
  });
  app.get("/api/manual-video-ad", async (_req, res) => {
    try {
      const [settings, playlist] = await Promise.all([ref().get(), playlistRef().get()]);
      const ads = Object.values(playlist.val() || {});
      const value = ads.length ? { ...ads[Math.floor(Math.random() * ads.length)], enabled: true } : settings.val();
      if (!value || value.enabled !== true || !/^manual-ads\/[a-f0-9-]{36}\.mp4$/.test(String(value.key || ""))) {
        return res.set("Cache-Control", "no-store").json({ enabled: false });
      }
      const url = signedReadURL(config(), value.key);
      res.set("Cache-Control", "no-store").json({ enabled: true, title: String(value.title || "Advertisement").slice(0, 80), url });
    } catch { res.set("Cache-Control", "no-store").json({ enabled: false }); }
  });
}

module.exports = { install, signedUploadURL, signedReadURL };
