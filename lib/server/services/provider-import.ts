import { createHash } from "node:crypto";
import { SERVICE_TYPES, type ServiceType } from "../../domain/enums";
import type { Actor } from "../auth/session";
import { isAdmin } from "../authz";
import { audit } from "../audit";
import type { Db } from "../db/client";

export const GANGNAM_SOCIAL_FACILITIES_SOURCE =
  "https://data.seoul.go.kr/dataList/OA-20399/S/1/datasetView.do";

type SourceRow = {
  name: string;
  code: string;
  facilityType: string;
  category: string;
  districtCode: string;
  districtName: string;
  address: string;
  capacity: string;
  currentCount: string;
  phone: string;
  postalCode: string;
};

export type ProviderImportPreview = {
  totalRows: number;
  eligibleRows: number;
  skippedRows: number;
  duplicateCodes: string[];
  warnings: string[];
  sample: Array<Pick<SourceRow, "name" | "code" | "facilityType" | "address">>;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(value.trim()); value = "";
    } else value += ch;
  }
  out.push(value.trim());
  return out;
}

export function parseGangnamFacilityCsv(csv: string): SourceRow[] {
  if (csv.length > 2_000_000) throw new Error("CSV는 2MB 이하만 가져올 수 있습니다.");
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("헤더와 데이터 행이 포함된 CSV를 입력해 주세요.");
  const headers = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  const index = (name: string) => headers.indexOf(name);
  const required = ["시설명", "시설코드", "시설종류명(시설유형)", "시설주소", "시군구코드", "시군구명"];
  const missing = required.filter((h) => index(h) < 0);
  if (missing.length) throw new Error(`필수 컬럼이 없습니다: ${missing.join(", ")}`);
  const val = (cells: string[], name: string) => {
    const i = index(name);
    return i < 0 ? "" : (cells[i] ?? "").replace(/^"|"$/g, "").trim();
  };
  return lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    return {
      name: val(c, "시설명"),
      code: val(c, "시설코드"),
      facilityType: val(c, "시설종류명(시설유형)"),
      category: val(c, "시설종류상세명(시설종류)"),
      districtCode: val(c, "시군구코드"),
      districtName: val(c, "시군구명"),
      address: val(c, "시설주소"),
      capacity: val(c, "정원(수용인원)"),
      currentCount: val(c, "현인원"),
      phone: val(c, "전화번호"),
      postalCode: val(c, "우편번호"),
    } satisfies SourceRow;
  }).filter((r) => r.name && r.code && r.address);
}

function classifyFacility(row: SourceRow): ServiceType[] {
  const type = `${row.facilityType} ${row.category}`;
  if (/노인요양|장기요양/.test(type)) return ["ltc_link", "home_care"];
  if (/재가노인|방문요양|주야간보호|방문목욕|방문간호/.test(type)) return ["home_care", "ltc_link"];
  if (/노인복지관|노인여가|노인일자리|경로당/.test(type)) return ["social_participation"];
  if (/장애인복지관|장애인지역사회재활/.test(type)) return ["local_special", "social_participation"];
  if (/치매안심|인지/.test(type)) return ["cognitive_emotional"];
  if (/건강가정|가족/.test(type)) return ["family_caregiver"];
  return [];
}

function regionForAddress(address: string, regions: Array<{ id: string; name: string }>) {
  return regions.find((r) => r.name !== "서울특별시 강남구" && address.includes(r.name.replace(/동$/, "동")))
    ?? regions.find((r) => r.name === "서울특별시 강남구");
}

function stableId(prefix: string, key: string) {
  return `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 18)}`;
}

function normalizeRows(rows: SourceRow[]) {
  const seen = new Set<string>();
  const duplicateCodes: string[] = [];
  const eligible: SourceRow[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (row.districtCode !== "1168000000" && row.districtName !== "강남구") continue;
    if (!row.address.includes("서울특별시 강남구")) {
      warnings.push(`${row.name}: 주소가 강남구 관내 주소 형식과 일치하지 않아 제외했습니다.`);
      continue;
    }
    if (seen.has(row.code)) { duplicateCodes.push(row.code); continue; }
    seen.add(row.code);
    eligible.push(row);
  }
  return { eligible, duplicateCodes, warnings };
}

export function previewGangnamFacilityCsv(csv: string): ProviderImportPreview {
  const rows = parseGangnamFacilityCsv(csv);
  const { eligible, duplicateCodes, warnings } = normalizeRows(rows);
  return {
    totalRows: rows.length,
    eligibleRows: eligible.length,
    skippedRows: rows.length - eligible.length,
    duplicateCodes,
    warnings: [...warnings, "가져온 기관은 모두 '미검증' 상태로 등록되며, 관리자 확인 전 기관 매칭에 사용되지 않습니다."],
    sample: eligible.slice(0, 8).map(({ name, code, facilityType, address }) => ({ name, code, facilityType, address })),
  };
}

export async function importGangnamFacilityCsv(tx: Db, actor: Actor, csv: string) {
  if (!isAdmin(actor)) throw new Error("관리자 권한이 필요합니다.");
  const rows = parseGangnamFacilityCsv(csv);
  const { eligible, duplicateCodes, warnings } = normalizeRows(rows);
  if (!eligible.length) throw new Error("강남구 관내 주소로 확인된 기관이 없습니다. 원본 CSV와 필터 조건을 확인해 주세요.");

  const regions = await tx.query<{ id: string; name: string }>(
    "SELECT id, name FROM region_units WHERE tenant_id = $1 AND level IN ('sigungu','eupmyeondong')",
    [actor.tenantId],
  );
  const district = regions.find((r) => r.name === "서울특별시 강남구");
  if (!district) throw new Error("테넌트의 강남구 행정구역 참조가 없습니다.");

  let inserted = 0;
  let updated = 0;
  for (const row of eligible) {
    const sourceRecordId = `SEOUL-OA-20399:${row.code}`;
    const providerId = stableId("pv_pub", sourceRecordId);
    const organizationId = stableId("org_pub", sourceRecordId);
    const region = regionForAddress(row.address, regions) ?? district;
    const services = classifyFacility(row).filter((s) => (SERVICE_TYPES as readonly string[]).includes(s));
    const phone = row.phone || "공개 데이터 미제공";
    const capacity = Number.parseInt(row.capacity.replace(/[^0-9]/g, ""), 10);
    const current = Number.parseInt(row.currentCount.replace(/[^0-9]/g, ""), 10);

    const [existing] = await tx.query<{ id: string }>(
      "SELECT id FROM service_providers WHERE tenant_id = $1 AND source_record_id = $2",
      [actor.tenantId, sourceRecordId],
    );
    if (!existing) {
      await tx.query(
        `INSERT INTO organizations (id, tenant_id, kind, name, region_unit_id, external_code, is_synthetic)
         VALUES ($1,$2,'provider',$3,$4,$5,false)
         ON CONFLICT (tenant_id, external_code) WHERE external_code IS NOT NULL DO NOTHING`,
        [organizationId, actor.tenantId, row.name, region.id, sourceRecordId],
      );
      await tx.query(
        `INSERT INTO service_providers
          (id, tenant_id, organization_id, name, provider_type, address_label, coords_synthetic, contact_label,
           operating_hours, visit_days, conditions, data_source, is_active, is_synthetic, source_record_id,
           source_url, source_updated_at, verification_status, latitude, longitude, location_source)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,'운영시간 확인 필요','{}',$8,$9,true,false,$10,$11,NULL,
                 'imported_unverified',NULL,NULL,'주소 좌표 미확인')`,
        [providerId, actor.tenantId, organizationId, row.name, row.facilityType || row.category, row.address,
          phone, [Number.isFinite(capacity) && capacity > 0 ? `공개 정원 ${capacity}명` : "", Number.isFinite(current) && current > 0 ? `공개 현원 ${current}명` : "", "실제 서비스 제공 범위·수용 현황은 기관 확인 필요"].filter(Boolean).join(" · "),
          "서울열린데이터광장 OA-20399", sourceRecordId, GANGNAM_SOCIAL_FACILITIES_SOURCE],
      );
      inserted++;
    } else {
      await tx.query(
        `UPDATE service_providers SET name=$3, provider_type=$4, address_label=$5, contact_label=$6,
          conditions=$7, data_source=$8, verification_status='imported_unverified', verified_at=NULL, verified_by=NULL,
          updated_at=now() WHERE tenant_id=$1 AND source_record_id=$2`,
        [actor.tenantId, sourceRecordId, row.name, row.facilityType || row.category, row.address, phone,
          [Number.isFinite(capacity) ? `공개 정원 ${capacity}명` : "", Number.isFinite(current) ? `공개 현원 ${current}명` : "", "실제 서비스 제공 범위·수용 현황은 기관 확인 필요"].filter(Boolean).join(" · "),
          "서울열린데이터광장 OA-20399"],
      );
      updated++;
    }

    for (const serviceType of services) {
      await tx.query(
        `INSERT INTO provider_service_areas (tenant_id, provider_id, region_unit_id, service_type)
         VALUES ($1,$2,$3,$4) ON CONFLICT (provider_id, region_unit_id, service_type) DO NOTHING`,
        [actor.tenantId, providerId, region.id, serviceType],
      );
    }
  }

  await audit(tx, actor, "provider.public_directory_import", { type: "service_provider", id: "SEOUL-OA-20399" }, "success", {
    source: "서울열린데이터광장 OA-20399",
    inserted,
    updated,
    skipped: rows.length - eligible.length,
    duplicateCodes,
  });
  return { inserted, updated, skipped: rows.length - eligible.length, duplicateCodes, warnings };
}

export async function setProviderVerification(tx: Db, actor: Actor, providerId: string, verified: boolean) {
  if (!isAdmin(actor)) throw new Error("관리자 권한이 필요합니다.");
  const [provider] = await tx.query<{ id: string; is_synthetic: boolean; source_record_id: string | null }>(
    "SELECT id, is_synthetic, source_record_id FROM service_providers WHERE id=$1 AND tenant_id=$2",
    [providerId, actor.tenantId],
  );
  if (!provider || !provider.source_record_id || provider.is_synthetic) throw new Error("공개 데이터로 가져온 기관만 검증할 수 있습니다.");
  await tx.query(
    `UPDATE service_providers SET verification_status=$3, verified_at=CASE WHEN $3='verified' THEN now() ELSE NULL END,
      verified_by=CASE WHEN $3='verified' THEN $4 ELSE NULL END, is_active=CASE WHEN $3='verified' THEN true ELSE false END,
      updated_at=now() WHERE id=$1 AND tenant_id=$2`,
    [providerId, actor.tenantId, verified ? "verified" : "imported_unverified", actor.id],
  );
  await audit(tx, actor, verified ? "provider.public_directory_verified" : "provider.public_directory_verification_revoked", { type: "service_provider", id: providerId }, "success");
  return { ok: true, verificationStatus: verified ? "verified" : "rejected" };
}
