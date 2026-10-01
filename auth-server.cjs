const path = require("node:path");
const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!raw && !encoded) throw new Error("Firebase service account is required for login");
const credentials = JSON.parse(raw || Buffer.from(encoded, "base64").toString("utf8"));
if (credentials.project_id !== "cloud-storage-eaca9") {
  throw new Error("Use the cloud-storage-eaca9 service account for the app login");
}
if (!process.env.TWOFACTOR_API_KEY) throw new Error("TWOFACTOR_API_KEY is required");
initializeApp({ credential: cert(credentials) });
const { handleSendOtp, handleVerifyOtp, handleVerifyPinLogin } = require("./lib/otp-2factor.cjs");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "jbmr-auth", provider: "2factor", template: "OTP1" }));
app.post("/sendOtp", handleSendOtp);
app.post("/verifyOtp", handleVerifyOtp);
app.post("/verifyPinLogin", handleVerifyPinLogin);
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
app.use((_req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
