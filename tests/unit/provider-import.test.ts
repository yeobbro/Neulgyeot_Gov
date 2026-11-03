import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGangnamFacilityCsv, previewGangnamFacilityCsv } from "../../lib/server/services/provider-import";

const csv = [
  "시설명,시설코드,시설종류명(시설유형),시설종류상세명(시설종류),자치구(시)구분,시설장명,시군구코드,시군구명,시설주소,정원(수용인원),현인원,전화번호,우편번호",
  '"강남구립 역삼노인복지관",A4790,"(노인여가복지시설) 노인복지관",노인여가복지시설,자치구,,1168000000,강남구,"서울특별시 강남구 도곡로27길 27 (역삼동)",0,0,02-555-0101,06200',
  '"타지역 복지관",B0001,"노인복지관",노인여가복지시설,자치구,,1111000000,종로구,"서울특별시 종로구 종로 1",0,0,,03100',
  '"강남구 시설, 별관",A4791,"(재가노인복지시설) 재가노인복지시설",재가노인복지시설,자치구,,1168000000,강남구,"서울특별시 강남구 테헤란로 10, 2층",0,0,02-555-0102,06100',
].join("\n");

test("parses quoted commas and preserves official facility identifiers", () => {
  const rows = parseGangnamFacilityCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].name, "강남구 시설, 별관");
  assert.equal(rows[0].code, "A4790");
});

test("preview filters to Gangnam-gu address and warns records are unverified", () => {
  const result = previewGangnamFacilityCsv(csv);
  assert.equal(result.totalRows, 3);
  assert.equal(result.eligibleRows, 2);
  assert.equal(result.skippedRows, 1);
  assert.ok(result.warnings.some((w) => w.includes("미검증")));
  assert.equal(result.sample.length, 2);
});

test("rejects files without the source dataset columns", () => {
  assert.throws(() => parseGangnamFacilityCsv("name,code\nfoo,bar"), /필수 컬럼/);
});
