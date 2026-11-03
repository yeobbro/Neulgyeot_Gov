# 늘곁 지자체용 · Neulgyeot Municipality

> KREWX Care Intelligence Platform — 지역사회 통합돌봄 업무 지원 SaaS **MVP (v0.1)**

지자체 통합돌봄 담당자가 **신청 → 조사·종합판정 → 개인별 지원계획 → 서비스 제공·연계 → 모니터링** 흐름을 처리하도록 돕는 행정형 B2G 웹 애플리케이션입니다. 병원 퇴원 연계는 별도 제품인 [늘곁 병원용](https://github.com/yeobbro/Neulgyeot)에서 **승인된 API 계약(DEMO v1.0)** 으로만 수신합니다.

> ⚠️ 이 시스템은 공공기관의 공식 행정 시스템이나 법정 판정을 대체하지 않습니다. 모든 기관·대상자·지역(가온시·누리군)은 **합성 DEMO 데이터**입니다. 실제 기관 연계, 외부 IdP, Managed PostgreSQL은 아직 연결되어 있지 않습니다.

## 제품 구성

| 제품 | 저장소 | 상태 |
|---|---|---|
| A. 늘곁 병원용 (Hospital EMR) | `yeobbro/Neulgyeot` | 별도 제품, 이 저장소에서 변경하지 않음 |
| **B. 늘곁 지자체용 (Municipality)** | 이 저장소 | MVP |
| C. 늘곁 패밀리 | 별도 | 이 MVP 범위 아님 |

## 주요 기능
- 역할: 시·군·구 관리자 / 사례관리 담당자 / 서비스 제공기관 / 감사 담당자 (RBAC + ABAC)
- 통합 현황 대시보드(실제 집계, 지표 클릭 → 목록), 병원 연계 접수함(동의·법적 근거 메타데이터, traceId, 버전 이력)
- 사례관리, 조사·욕구 평가(11개 영역, 무응답≠정상), 개인별 지원계획 + 통합지원회의(원클릭 승인 없음)
- 설명 가능한 규칙 기반 제공기관 매칭(수용 정보 신선도 반영), 서비스 의뢰·제공 결과, 제공기관 포털
- 모니터링·후속 업무, 합성 지역 자원 지도, 보고서(정의·산식·기준일·누락률), CSV(수식 주입 방지)
- AI 보조 3종(연계 요약, 사회복지 종합 소견서 초안, 회의 자료) — 규칙 기반 기본, 문장별 근거, draft→사람 승인
- PostgreSQL RLS 테넌트 격리, 감사 로그(본문 미저장, 추가 전용), CSRF/CSP/rate limit

## 빠른 시작
```bash
npm ci
npm run dev            # DATABASE_URL 없으면 인메모리 DEMO DB + 합성 데이터
# http://localhost:3000/login → DEMO 계정 선택
```

## 스크립트
| 명령 | 내용 |
|---|---|
| `npm run lint` / `npm run typecheck` | ESLint / tsc |
| `npm test` | 단위 + API 통합 테스트 (in-memory PGlite, RLS 포함) |
| `npm run build` | Next.js production build |
| `npm run test:e2e` | Playwright E2E + axe + 반응형 (서버가 `:3100`에서 실행 중이어야 함, `E2E_BASE_URL`로 변경) |
| `npm run db:migrate` | `DATABASE_URL` 대상 마이그레이션 |

## 문서
[제품 명세](docs/PRODUCT_SPEC.md) · [아키텍처](docs/ARCHITECTURE.md) · [DB](docs/DATABASE.md) · [API](docs/API.md) · [병원 연계](docs/INTEGRATION_WITH_HOSPITAL.md) · [AI](docs/AI_LOGIC.md) · [보안](docs/SECURITY.md) · [개인정보·법률 검토](docs/PRIVACY_AND_LEGAL_REVIEW.md) · [데모 가이드](docs/DEMO_GUIDE.md) · [테스트 보고서](docs/TEST_REPORT.md) · [배포](docs/DEPLOYMENT.md) · [로드맵](docs/ROADMAP.md) · [기존 MVP 이전](docs/MIGRATION_FROM_EXISTING_MUNICIPAL_MVP.md)
