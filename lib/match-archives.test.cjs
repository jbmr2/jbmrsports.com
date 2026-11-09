const test = require("node:test");
const assert = require("node:assert/strict");
const { readMatchArchives } = require("./match-archives.cjs");

const INSTALLATION = "6fca9fc7d4974919a43b149d32717119";
const MATCH_UID = "4b76ec7dfc1f4f7d875b9c2da45c3bba";

function fakeDoc(id, data, chunks = []) {
  const chunkDocs = chunks.map(([chunkID, json]) => ({ id: chunkID, get: field => field === "json" ? json : undefined }));
  return {
    id,
    data: () => data,
    ref: {
      collection: name => {
        assert.equal(name, "revisions");
        return { doc: revision => ({
          collection: child => {
            assert.equal(child, "chunks");
            return { get: async () => ({ docs: chunkDocs }) };
          }
        }) };
      }
    }
  };
}

function payload(ballCount = 1) {
  return {
    installation_id: INSTALLATION,
    tables: {
      matches: { id_2: { id: 2, match_uid: MATCH_UID } },
      innings: { id_9: { id: 9, match_id: 2 } },
      balls: Object.fromEntries(Array.from({ length: ballCount }, (_, index) => [
        `id_${index + 1}`, { id: index + 1, innings_id: 9, seq: index + 1 }
      ])),
      players: {}, teams: {}, tournaments: {}
    }
  };
}

function dbWith(docs) {
  return { collection: name => {
    assert.equal(name, "match_archives");
    return { get: async () => ({ docs }) };
  } };
}

test("discovers completed archives and reconstructs chunks in numeric order", async () => {
  const serialized = JSON.stringify(payload(3));
  const split = Math.floor(serialized.length / 2);
  const doc = fakeDoc(MATCH_UID, {
    match_uid: MATCH_UID, match_id: 2, status: "completed", revision: "rev-1", chunk_count: 2
  }, [["000001", serialized.slice(split)], ["000000", serialized.slice(0, split)]]);

  const result = await readMatchArchives(dbWith([doc]));
  assert.equal(result.length, 1);
  assert.equal(result[0].installation_id, INSTALLATION);
  assert.equal(result[0].archive_manifest.ball_record_count, 3);
  assert.equal(result[0].tables.balls.id_3.seq, 3);
});

test("does not include non-completed placeholder documents", async () => {
  const doc = fakeDoc("placeholder", { status: "draft" });
  assert.deepEqual(await readMatchArchives(dbWith([doc])), []);
});

test("reports missing chunks instead of treating archive as complete", async () => {
  const doc = fakeDoc(MATCH_UID, {
    match_uid: MATCH_UID, match_id: 2, status: "complete", revision: "rev-1", chunk_count: 2
  }, [["000000", JSON.stringify(payload())]]);
  await assert.rejects(readMatchArchives(dbWith([doc])), /expected 2 chunks, found 1/);
});

test("reports archive payloads that do not map to the manifest match", async () => {
  const wrong = payload();
  wrong.tables.matches.id_2.match_uid = "different-match";
  const doc = fakeDoc(MATCH_UID, {
    match_uid: MATCH_UID, match_id: 999, status: "completed", revision: "rev-1", chunk_count: 1
  }, [["000000", JSON.stringify(wrong)]]);
  await assert.rejects(readMatchArchives(dbWith([doc])), /does not map to a match row/);
});
