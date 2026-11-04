# OTP and PIN login on Hostinger

Deploy this combined website and auth package as a Node.js 20+ application on jbmrsports.com. It serves the existing website from dist and handles the app login routes on the same domain. Route the domain to the Node.js application rather than only uploading dist to static hosting. The included website retains its existing demo web login; the real OTP/PIN endpoints are for the iOS app.

Build the website using `npm run build` before starting the server. Use `npm install` as the install command and `npm start` as the start command.

Hostinger Entry File: `server.js`. This loads the Express server in `auth-server.cjs`.

Set these environment variables in Hostinger (do not place credentials in website files):

- `TWOFACTOR_API_KEY`: your existing 2Factor account API key.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Admin service-account JSON from project jbmrsports-cricket-live. Alternatively set FIREBASE_SERVICE_ACCOUNT_BASE64.
- `PORT`: use the port supplied by Hostinger.
- Optional App Review login: set `DEMO_LOGIN_ENABLED=true`, `DEMO_PHONE`, `DEMO_OTP`, and `DEMO_SESSION` as private environment variables. The bypass is disabled when these are absent.

Open `/health` on the deployed URL. The response must be JSON with service jbmr-auth. Routes are `/sendOtp`, `/verifyOtp`, `/verifyPinLogin`, `/savePin`, and `/api/scoring-archives`.

The server sends OTP through 2Factor AUTOGEN/OTP1, binds the session to the phone, and verifies the OTP before issuing a Firebase custom token. PIN records and completed archives use the named `criccricket` Firestore database. PINs are stored using a salted scrypt hash; legacy PIN hashes upgrade on successful PIN login.

The iOS app is configured with JBMRAuthAPIBaseURL=https://jbmrsports.com. After deployment, /health must return JSON before trying OTP. Real SMS testing requires a chosen recipient.

Login and scoring now use jbmrsports-cricket-live. User and PIN records are stored in the named criccricket Firestore database. Old cloud-storage-eaca9 users and PINs are not migrated; verify OTP and create a PIN again.
