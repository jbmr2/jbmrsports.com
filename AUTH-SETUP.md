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

The server sends OTP through 2Factor AUTOGEN/OTP1, binds the session to the phone, and verifies the OTP before issuing a Firebase custom token. Completed archives use the named `criccricket` Firestore database. PINs are stored using a salted scrypt hash; legacy PIN hashes upgrade on successful PIN login.

The iOS app is configured with JBMRAuthAPIBaseURL=https://jbmrsports.com. After deployment, /health must return JSON before trying OTP. Real SMS testing requires a chosen recipient.

Login and scoring now use jbmrsports-cricket-live. User profiles are stored in the named criccricket Firestore database. Old cloud-storage-eaca9 users and PINs are not migrated; verify OTP and create a PIN again.

## Moving PIN records to MySQL

Use a dedicated Hostinger MySQL database for auth, with a separate app user.
Hostinger's database setup writes `DB_NAME`, `DB_USER`, and `DB_PASSWORD`
into the Node.js environment. Create the tables in `sql/pin-auth.sql` using
that database. The app connects to Hostinger's local MySQL listener on
`127.0.0.1:3306`.

Run `node scripts/import-phone-pins.cjs` with access to the existing Firebase
project to review counts. During the cutover, pause PIN setup on the old
backend and run `node scripts/import-phone-pins.cjs --apply` from the host that
can reach MySQL. Resolve any skipped records before proceeding. Import preserves
the account UID and existing verifier and never overwrites a MySQL PIN. Run it
before opening PIN setup on the new backend. Then verify OTP, PIN setup, an
imported user's PIN login, rate limiting, and account deletion with test accounts.

This stage moves PIN records, OTP challenges, and login rate limits. Firebase Auth still provides
the session accepted by installed iOS clients and protected data routes.
Keep the Firebase project and the old PIN records until the new login and the
account migration have been verified. The import does not delete source data.

## MySQL login sessions

Create the account and session tables with `sql/mysql-accounts.sql`. Run
`node scripts/import-app-accounts.cjs` to count eligible Firebase phone users.
Run it with `--apply` from the Hostinger app environment before rolling out the updated app. Use
`JBMR_MYSQL_SESSIONS=false` to disable the new endpoints if needed. This preserves account IDs, including disabled
accounts. Pause account creation on the legacy login routes during the final
import so both login versions retain the same account IDs.

The new login endpoints currently serve imported accounts. The updated client can use `/api/auth/sendOtp`, `/api/auth/verifyOtp`,
`/api/auth/verifyPin`, `/api/auth/session`, and `/api/auth/logout`. Tokens
expire after 30 days. MySQL stores only token hashes. Existing iOS clients
continue to use the legacy routes until the updated app has been rolled out.
