# OTP and PIN login on Hostinger

Deploy this combined website and auth package as a Node.js 20+ application on jbmrsports.com. It serves the existing website from dist and handles the app login routes on the same domain. Route the domain to the Node.js application rather than only uploading dist to static hosting. The included website retains its existing demo web login; the real OTP/PIN endpoints are for the iOS app.

Build the website using `npm run build` before starting the server. Use `npm install` as the install command and `npm start` as the start command.

Set these environment variables in Hostinger (do not place credentials in website files):

- `TWOFACTOR_API_KEY`: your existing 2Factor account API key.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Admin service-account JSON from project cloud-storage-eaca9. Alternatively set FIREBASE_SERVICE_ACCOUNT_BASE64.
- `PORT`: use the port supplied by Hostinger.

Open `/health` on the deployed URL. The response must be JSON with service jbmr-auth. POST routes are `/sendOtp`, `/verifyOtp`, and `/verifyPinLogin`.

The server sends OTP through 2Factor AUTOGEN/OTP1, binds the session to the phone, and verifies the OTP before issuing a Firebase custom token. PIN records remain in Firebase. Later PIN login issues another Firebase custom token without sending SMS.

The iOS app is configured with JBMRAuthAPIBaseURL=https://jbmrsports.com. After deployment, /health must return JSON before trying OTP. Real SMS testing requires a chosen recipient.

The login Firebase project is separate from the scoring archive project. Scoring data in criccricket does not change the login project.
