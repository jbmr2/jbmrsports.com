# Player analytics API

All routes require the existing Firebase ID token:

```http
Authorization: Bearer <Firebase ID token>
```

The server verifies the Firebase ID token, looks up that UID with Firebase Admin, and obtains the verified phone number from the user record. Ownership is resolved from the existing RTDB mappings `player_directory/{scorerInstallation}` and `player_download_links/{scorerInstallation}`. Directory entries are matched by scorer player ID and, when present, `public_player_uid`; link records are matched by scorer player ID. Phone fields embedded in archive player rows are not used to authorize analytics. The resolved identity is namespaced by scorer installation and must also exist in the corresponding archive's player table. A requested `playerId` is never used for ownership. Phone numbers are used only for matching and are never returned. Admin routes remain on the existing separate admin-device authorization and do not grant access to these self-service routes.

## Routes

- `GET /api/my-performance/analytics/overview`
- `GET /api/my-performance/analytics/batting`
- `GET /api/my-performance/analytics/bowling`
- `GET /api/my-performance/analytics/head-to-head`
- `GET /api/my-performance/analytics/opposition`

All routes return only the requesting account's mapped player identity or identities. Overview returns runs, wickets, batting average/strike rate, bowling economy, fours, sixes, and matches played. If historical selection cannot be proven, `matches` is `null` and `uncertainMatchUids` explains the gap.

Batting and bowling include career aggregates plus tournament aggregates. They also include a `matches` page of match-wise statistics, ordered newest first by the source match date; records without a valid date follow dated records and return `matchDate: null`. Match rows include team display names where available. Head-to-head includes batter/bowler display names where available, otherwise the name fields are `null`. Opposition rows include `teamName` where a source team label is available, otherwise `null`. `limit` is capped at 50 (default 20); `cursor` is a numeric offset. The response returns `pagination.nextCursor` for the match list and `pagination.headToHeadNextCursor` for pairings. Pass the relevant cursor to load the next page. Responses are `private, no-store`.

## Example response

```json
{
  "ok": true,
  "status": "ready",
  "linked": true,
  "players": [{
    "playerId": "42",
    "playerName": "Player Name",
    "installationId": "scorer-installation-id",
    "matchesPlayed": null,
    "confirmedMatchesPlayed": 2,
    "uncertainMatchUids": ["archive-uid"],
    "runs": 86,
    "wickets": 3,
    "average": 43,
    "strikeRate": 123.188406,
    "economy": 7.5,
    "sixes": 4,
    "fours": 7
  }],
  "pagination": { "limit": 20, "nextCursor": null, "headToHeadNextCursor": null }
}
```

Other statuses include `player_not_linked` and `login_phone_missing`; these return an empty `players` array. Invalid scoring records return HTTP 422 with a stable validation code. Unavailable Firebase services return HTTP 503. Missing or expired authentication is rejected by existing middleware with HTTP 401.

The older `GET /api/my-performance` clip-package route remains as-is. This integration adds only the nested `/analytics/*` routes; it does not modify clip, like/download, authentication, live scoring, admin authorization or Firebase records.
