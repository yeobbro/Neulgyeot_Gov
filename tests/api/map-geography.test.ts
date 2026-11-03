import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { mapData } from "../../lib/server/services/insights";
import { asActor, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

test("map reference geography uses real Gangnam-gu administrative dong names and coordinates", async () => {
  const data = await asActor(db, DEMO_USERS.admin, (tx, actor) => mapData(tx, actor));

  assert.equal(data.municipality?.name, "서울특별시 강남구");
  assert.deepEqual(data.regions.map((r) => r.name), ["역삼1동", "대치4동", "수서동", "세곡동"]);
  assert.ok(data.regions.every((r) => r.is_synthetic === false));
  assert.ok(data.regions.every((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)));
  assert.ok(data.regions.every((r) => r.location_precision === "approximate_administrative_area_center"));
  assert.match(data.notice, /공식 행정경계/);
});

test("case manager map hides case counts and unmet demand outside assigned regions", async () => {
  const data = await asActor(db, DEMO_USERS.cmHaesol, (tx, actor) => mapData(tx, actor));
  const inScope = data.regions.find((r) => r.id === "rg_haesol");
  const outOfScope = data.regions.find((r) => r.id === "rg_maru");

  assert.ok(inScope);
  assert.ok(outOfScope);
  assert.notEqual(inScope.openCases, null);
  assert.equal(outOfScope.openCases, null);
  assert.deepEqual(outOfScope.gaps, []);
});
