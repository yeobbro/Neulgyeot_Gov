/**
 * Explainable rule-based provider matching.
 *
 * Output is a list of CANDIDATES for a case manager to review. It never
 * decides welfare eligibility, legal target status or entitlement.
 */
import { CAPACITY_LABEL, SERVICE_TYPE_LABEL, type CapacityStatus, type ServiceType } from "./enums";

/** Capacity information older than this is shown as "확인 필요". */
export const CAPACITY_FRESH_DAYS = 14;

export type CapacityView = { status: CapacityStatus; label: string; confirmedAt: string | null; stale: boolean };

export function capacityFreshness(
  snapshot: { status: CapacityStatus; confirmedAt: string | null } | null,
  now: Date,
  freshDays = CAPACITY_FRESH_DAYS,
): CapacityView {
  if (!snapshot || !snapshot.confirmedAt) return { status: "unknown", label: CAPACITY_LABEL.unknown, confirmedAt: null, stale: true };
  const ageDays = (now.getTime() - new Date(snapshot.confirmedAt).getTime()) / 86_400_000;
  if (ageDays > freshDays) {
    return { status: "unknown", label: `확인 필요 (마지막 확인 ${Math.floor(ageDays)}일 전: ${CAPACITY_LABEL[snapshot.status]})`, confirmedAt: snapshot.confirmedAt, stale: true };
  }
  return { status: snapshot.status, label: CAPACITY_LABEL[snapshot.status], confirmedAt: snapshot.confirmedAt, stale: false };
}

export type MatchProvider = {
  id: string;
  name: string;
  isActive: boolean;
  serviceAreas: { regionUnitId: string; serviceType: ServiceType }[];
  capacity: Partial<Record<ServiceType, { status: CapacityStatus; confirmedAt: string | null }>>;
  visitDays: string[]; // e.g. ["mon","wed"]
  isSynthetic: boolean;
};

export type MatchRequest = {
  serviceType: ServiceType;
  regionUnitIds: string[]; // the case's region + ancestors
  preferredDays?: string[];
};

export type MatchCandidate = {
  providerId: string;
  providerName: string;
  rank: number;
  reasons: string[];
  cautions: string[];
  capacity: CapacityView;
  isSynthetic: boolean;
};
export type MatchExclusion = { providerId: string; providerName: string; reason: string };

const DAY_LABEL: Record<string, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };

export function matchProviders(req: MatchRequest, providers: MatchProvider[], now: Date) {
  const candidates: (MatchCandidate & { score: number })[] = [];
  const excluded: MatchExclusion[] = [];
  const regions = new Set(req.regionUnitIds);
  const typeLabel = SERVICE_TYPE_LABEL[req.serviceType];

  for (const p of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!p.isActive) {
      excluded.push({ providerId: p.id, providerName: p.name, reason: "운영 중이 아닌 기관" });
      continue;
    }
    const offers = p.serviceAreas.filter((a) => a.serviceType === req.serviceType);
    if (offers.length === 0) {
      excluded.push({ providerId: p.id, providerName: p.name, reason: `'${typeLabel}' 서비스를 제공하지 않음` });
      continue;
    }
    if (!offers.some((a) => regions.has(a.regionUnitId))) {
      excluded.push({ providerId: p.id, providerName: p.name, reason: "대상자 권역이 제공 권역에 포함되지 않음" });
      continue;
    }
    const reasons = [`대상자 주소 권역과 서비스 제공 권역이 일치함`, `요청한 서비스 유형(${typeLabel})을 제공함`];
    const cautions: string[] = [];
    const cap = capacityFreshness(p.capacity[req.serviceType] ?? null, now);
    let score = 0;
    if (cap.stale) cautions.push("수용 가능 여부 확인 필요 — 최신 확인 정보 없음");
    else if (cap.status === "available") {
      reasons.push("최근 수용 가능 상태가 확인됨");
      score += 3;
    } else if (cap.status === "limited") {
      cautions.push("제한적 수용 — 대기 가능성 확인 필요");
      score += 1;
    } else if (cap.status === "full") {
      cautions.push("최근 확인 기준 수용 불가(대기)");
      score -= 2;
    }
    if (req.preferredDays?.length) {
      const overlap = req.preferredDays.filter((d) => p.visitDays.includes(d));
      if (overlap.length) {
        reasons.push(`방문 일정 조건이 일치함 (${overlap.map((d) => DAY_LABEL[d] ?? d).join("·")})`);
        score += 1;
      } else cautions.push("희망 방문 요일과 운영 요일이 다름");
    }
    if (p.isSynthetic) cautions.push("DEMO 합성 기관 데이터");
    candidates.push({ providerId: p.id, providerName: p.name, rank: 0, reasons, cautions, capacity: cap, isSynthetic: p.isSynthetic, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
  return {
    candidates: candidates.map(({ score: _s, ...c }, i) => ({ ...c, rank: i + 1 })),
    excluded,
    notice: "추천 결과는 담당자 검토용 후보이며, 복지 자격·법적 대상자 여부·서비스 수급 권리를 판정하지 않습니다.",
  };
}
