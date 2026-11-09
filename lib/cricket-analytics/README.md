# My Performance 2.0 — calculation engine

Pure CommonJS modules. No UI, authentication, routes, deployment, database writes,
Firebase initialization or runtime changes to existing features.

## Entry points

```js
const { analyzeArchives, analyzeFirestore } = require('./lib/cricket-analytics/index.cjs');
const analysis = analyzeArchives(reconstructedArchives);
// In an already authorized server context, using the named criccricket database:
const sameAnalysis = await analyzeFirestore(db);
```

`analyzeFirestore` reuses `../match-archives.cjs`; it does not implement a second
archive loader. Callers remain responsible for authorization. This phase does not
expose an endpoint or allow client-selected player IDs to bypass authorization.

`analyzeArchives` accepts archive-reader payloads or the `archives` array from the
existing authenticated API. Tables may be keyed objects or arrays. Inputs are not
mutated. Duplicate identical archives are counted once; conflicting payloads for
the same `match_uid` are rejected. Delivery IDs and innings/sequence duplicates
are errors. There is no permanent match-ID or player-ID allowlist in the engine.

## Identity and coverage

Player keys are JSON tuples of `installation_id` and `player_id`. Team keys are
similarly scoped. Match UIDs are canonical. Different player IDs never merge based
on names, and team membership is recorded per match. A player's displayed name is
a deterministic representative; `teamHistory` retains match-specific names.

A roster entry alone is not evidence of playing. `matchesPlayed` / batting
`matches` are null when an appearance cannot be proven. `confirmedMatchesPlayed`
is a lower bound based on lineup or batting/bowling participation; `uncertainMatchUids`
identifies gaps. `matchesBatted`, `matchesBowled` and innings counts use observed
activity. No balls faced is not the same as not batting: a non-striker can be run
out without facing a delivery. Empty zero-delivery innings do not fabricate batting
appearances. Exact selection cannot be inferred from an incomplete lineup.

## Calculation contract

- Bat runs come exclusively from `event.bat_runs`.
- Wides never count as batter balls faced. No-balls do count as faced, per product
  requirement, but never as legal balls. Non-delivery retirements/dead balls do not count.
- Bowler conceded runs = bat runs + wide runs + no-ball runs; excludes byes/leg-byes.
- Bowler wickets: bowled, caught (including aliases), lbw, stumped, hit wicket.
  Runout, retired out, timed out, obstructing the field, hit ball twice and handled
  ball do not credit the bowler. Retired hurt is not an out. A returning retired-hurt
  batter is counted once in that innings. Unsupported dismissal strings throw.
- Head-to-head dismissals mean dismissals credited to that bowler, not runouts.
- Boundary percentage = `(4*fours + 6*sixes) / batter runs * 100`.
  Boundaries use explicit `event.boundary` (0/4/6) when present. For legacy records,
  bat runs 4/6 with zero `completed_runs` indicate a boundary; all-running fours/sixes
  are not boundaries. Ambiguous mixed running/overthrow records throw.
- Batter/H2H dots = faced deliveries with zero batter runs (includes byes/leg-byes).
  Bowling dots = legal deliveries with zero team runs.
- A maiden requires a complete over delivered entirely by one bowler, with zero
  runs charged to that bowler. Partial/shared overs do not qualify; byes can occur.
- Wides/noBalls totals are penalty runs. Separate wideDeliveries/noBallDeliveries
  fields provide event counts.
- 30s = 30–49, 50s = 50–99, 100s = 100+. Hauls are exactly 2/3/4 and 5+.
- Highest score tie prefers not-out. Best bowling compares wickets, then fewer runs.
- Batting average = runs / dismissals. Bowling average = conceded / wickets;
  strike rate = legal balls / wickets. Undefined denominators return null.
- Rates are rounded only on output to six decimal places; aggregation uses integers.
- Overs are strings (`19.5`), never decimal arithmetic. Economy uses legal balls.
  Aggregation of different balls-per-over formats returns null for overs/economy.
- T20 defaults: powerplay 1–6, middle 7–15, death 16–20. ODI: 1–10, 11–40, 41–50.
  These are analytics phase conventions. Other formats/reduced innings require
  explicit settings. Super overs/Test/unlimited matches must be adapted explicitly;
  do not feed them under a guessed T20 configuration.

```js
analyzeArchives(archives, {
  formatForMatch: match => ({
    maxOvers: match.total_overs, ballsPerOver: 6,
    powerplayOvers: 3, deathOvers: 2 // example for a ten-over competition
  })
});
```

Phases are assigned using legal balls before each event, never a decimal-over value.
Missing required numeric fields, pending details, non-zero initial scores, sequence
gaps, conflicting extras and failed state/innings reconciliation throw an
`AnalyticsError` with code and record path. Penalty-run attribution, short-run
semantics, scoring dead balls and nonempty correction tables currently throw clear
unsupported errors instead of guessing. Expected retirement events are explicitly
non-deliveries; other representations need an adapter.

## Verification and output

```sh
node --test lib/cricket-analytics/analytics.test.cjs lib/match-archives.test.cjs
node lib/cricket-analytics/export-analysis.cjs /path/to/authorized-export.json /path/to/new-report-directory
```

The exporter reads only a local authorized response. It generates player/match/H2H/
opposition JSON and an innings reconciliation report with input SHA-256. It never
stores credentials or copies phone numbers, emails, photos, clip URLs or other
unneeded source fields. Artifacts fail on overwrite and are created owner-readable.

Reconciliation verifies each ball's before/after runs, wickets and legal-ball state,
then verifies player aggregates: batter runs + extras = team score; bowler conceded +
byes/leg-byes = team score; credited + non-credited wickets = final wickets. This is
not an independent stored player-scorecard oracle. Manual synthetic tests provide
independent expected individual metrics; real-archive reconciliation provides
coverage of the supplied four matches.
