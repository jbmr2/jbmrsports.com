# Admin publication controls

Deploy the updated auth server to Hostinger. Set `ADMIN_DEVICE_TOKEN_SHA256` to the value prepared in the admin project's private `hostinger-admin-device.env` file. With this setting empty or invalid, admin catalog/save requests are denied.

The admin app has no OTP/PIN login. Import the private `admin-device-key.txt` once using Device setup; the app stores it in iOS Keychain with `WhenUnlockedThisDeviceOnly`. It sends the key to the admin endpoints over HTTPS. The server compares its SHA-256 hash in constant time. These endpoints allow reading the admin catalog/completed archives and changing match/tournament visibility only. The key is not embedded in source or the application bundle. Rotate the server hash and reconfigure the device to revoke a key.

Private setup files are excluded from Git. Existing viewer OTP/PIN authentication remains in place.

Sources:
- Live/upcoming: `jbmrsports-cricket-live` RTDB, `scorers_public/80c7442eb2ca4aeabfb6779128d91b8a`.
- Completed: named Firestore database `criccricket`, scoring archive revisions.
- Publication decisions: RTDB `app_visibility/tournaments/{id}/show` and `app_visibility/matches/{id}/show`.

Policy:
- No decision: hidden.
- Tournament Yes: matches inherit Yes unless explicitly set to No.
- Tournament No: all its matches are hidden, including matches with Yes.
- Match Yes can approve a match when no tournament decision has been made.

The viewer polls the public, sanitized `/api/visibility` response every three seconds. Its home feed, schedule, tournaments, highlights, and shorts are derived from approved matches. A permission failure hides content until the permissions can be verified again. A match detail player is stopped when its match is withdrawn.

Do not distribute the new viewer build before deploying the endpoint and approving content: its default is hidden. No existing scoring records are modified by these controls.
