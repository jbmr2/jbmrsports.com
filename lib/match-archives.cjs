const COMPLETED_STATUSES = new Set([
  "complete", "completed", "finished", "ended", "result"
]);

const APPROVED_INSTALLATIONS = new Set([
  "80c7442eb2ca4aeabfb6779128d91b8a",
  "994bd24b405943c790d9b8b32d3e13e2",
  "6fca9fc7d4974919a43b149d32717119"
]);

function isValidInstallationID(value) {
  return /^[a-f0-9]{32}$/i.test(String(value || '').trim());
}

function statusKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ");
}

function entries(value) {
  if (Array.isArray(value)) return value.filter(row => row && typeof row === "object");
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, row]) => {
    if (!row || typeof row !== "object") return null;
    return row.id == null ? { ...row, id: key } : row;
  }).filter(Boolean);
}

function archiveError(id, message) {
  return new Error(`Archive ${id}: ${message}`);
}

async function reconstructArchive(doc) {
  const manifest = doc.data() || {};
  const id = doc.id;
  const status = statusKey(manifest.status);
  if (!COMPLETED_STATUSES.has(status)) return null;

  const matchUID = String(manifest.match_uid || id);
  if (!matchUID || matchUID !== id) throw archiveError(id, "match_uid does not match document ID");

  const revision = String(manifest.revision || "").trim();
  const chunkCount = Number(manifest.chunk_count);
  if (!revision) throw archiveError(id, "active revision is missing");
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 10000) {
    throw archiveError(id, "chunk_count is invalid");
  }

  // Firestore allows child collections under a parent document that has no
  // fields. Read the revision's chunks directly; revision.exists is not required.
  const chunksSnapshot = await doc.ref.collection("revisions").doc(revision).collection("chunks").get();
  const chunks = chunksSnapshot.docs.map(chunk => {
    if (!/^\d+$/.test(chunk.id)) throw archiveError(id, `chunk ID ${chunk.id} is not numeric`);
    return { id: Number(chunk.id), json: chunk.get("json") };
  }).sort((a, b) => a.id - b.id);

  if (chunks.length !== chunkCount) {
    throw archiveError(id, `expected ${chunkCount} chunks, found ${chunks.length}`);
  }
  const firstID = chunks[0]?.id;
  if (firstID !== 0 && firstID !== 1) throw archiveError(id, "chunk sequence must start at 0 or 1");
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index].id !== firstID + index) throw archiveError(id, "chunk sequence has a gap");
    if (typeof chunks[index].json !== "string") throw archiveError(id, `chunk ${chunks[index].id} has no JSON string`);
  }

  let payload;
  try {
    payload = JSON.parse(chunks.map(chunk => chunk.json).join(""));
  } catch {
    throw archiveError(id, "chunk JSON could not be reconstructed");
  }
  if (!payload || typeof payload !== "object" || !payload.tables || typeof payload.tables !== "object") {
    throw archiveError(id, "reconstructed payload has no tables object");
  }

  const installationID = String(manifest.installation_id || payload.installation_id || "");
  // Scorer installations are generated dynamically. Keep the historical
  // allowlist for compatibility while accepting valid generated IDs.
  if (!APPROVED_INSTALLATIONS.has(installationID) && !isValidInstallationID(installationID)) {
    throw archiveError(id, "scorer installation ID is missing or not approved");
  }

  const tableMatches = entries(payload.tables.matches);
  if (!tableMatches.length) throw archiveError(id, "payload has no match rows");
  const manifestMatchID = manifest.match_id == null ? "" : String(manifest.match_id);
  const matchedRows = tableMatches.filter(row => {
    const rowUID = String(row.match_uid || row.matchUid || "");
    const rowID = String(row.id ?? "");
    return rowUID === matchUID || (manifestMatchID && rowID === manifestMatchID);
  });
  if (!matchedRows.length) throw archiveError(id, "manifest does not map to a match row in the payload");

  const ballRows = entries(payload.tables.balls);
  const inningsRows = entries(payload.tables.innings);
  if (!ballRows.length || !inningsRows.length) throw archiveError(id, "payload has no innings or ball records");

  payload.installation_id = installationID;
  payload.archive_manifest = {
    match_uid: matchUID,
    match_id: manifest.match_id ?? null,
    tournament_id: manifest.tournament_id ?? null,
    revision,
    chunk_count: chunkCount,
    chunk_ids: chunks.map(chunk => String(chunk.id).padStart(6, "0")),
    ball_record_count: ballRows.length,
    innings_record_count: inningsRows.length,
    matched_match_row_count: matchedRows.length
  };
  return payload;
}

async function readMatchArchives(db) {
  const snapshot = await db.collection("match_archives").get();
  const archives = [];
  for (const doc of snapshot.docs) {
    const payload = await reconstructArchive(doc);
    if (payload) archives.push(payload);
  }
  return archives;
}

module.exports = { readMatchArchives, reconstructArchive, APPROVED_INSTALLATIONS, isValidInstallationID };
