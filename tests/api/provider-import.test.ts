import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, asActor, DEMO_USERS } from "../helpers";
import { importGangnamFacilityCsv } from "../../lib/server/services/provider-import";
import type { Db } from "../../lib/server/db/client";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const csv = [
  "시설명,시설코드,시설종류명(시설유형),시설종류상세명(시설종류),자치구(시)구분,시설장명,시군구코드,시군구명,시설주소,정원(수용인원),현인원,전화번호,우편번호",
  '"강남구립 역삼노인복지관",A4790,"(노인여가복지시설) 노인복지관",노인여가복지시설,자치구,,1168000000,강남구,"서울특별시 강남구 도곡로27길 27 (역삼동)",0,0,02-555-0101,06200',
].join("\n");

test("public provider import is idempotent and keeps imported rows unverified", async () => {
  const result = await asActor(db, DEMO_USERS.admin, (tx, actor) => importGangnamFacilityCsv(tx, actor, csv));
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);

  const [provider] = await db.query<{ verification_status: string; is_synthetic: boolean; latitude: number | null; longitude: number | null; contact_label: string }>(
    "SELECT verification_status, is_synthetic, latitude, longitude, contact_label FROM service_providers WHERE source_record_id = $1",
    ["SEOUL-OA-20399:A4790"],
  );
  assert.equal(provider.verification_status, "imported_unverified");
  assert.equal(provider.is_synthetic, false);
  assert.equal(provider.latitude, null);
  assert.equal(provider.longitude, null);
  assert.equal(provider.contact_label, "02-555-0101");

  const second = await asActor(db, DEMO_USERS.admin, (tx, actor) => importGangnamFacilityCsv(tx, actor, csv));
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);
  const [count] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM service_providers WHERE source_record_id = $1", ["SEOUL-OA-20399:A4790"]);
  assert.equal(count.n, 1);
});
