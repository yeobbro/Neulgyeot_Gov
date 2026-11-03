# 기존 지자체 MVP(PR #3)에서의 이전 기록

기준: `yeobbro/Neulgyeot` 브랜치 `claude/neulgyeot-integrated-care` (HEAD `edb4db2`, PR #3), PR #2 `feature/dashboard-upgrade` (`c0e80a5`). 두 브랜치는 병원용 `main`(`e044bc6`)이 아닌 이전 `main`(`528072c`)을 기반으로 하므로 **병합하지 않고 참조·선별 포팅**했습니다. 병원 저장소에는 어떤 변경·push도 하지 않았습니다.

## 비교 요약
| 영역 | PR #3 | 이 저장소 |
|---|---|---|
| 역할 | admin / worker / provider / recipient / family | municipal_admin / case_manager / service_provider / auditor (가족·대상자 포털 제외) |
| 테넌트 | 단일 테넌트 | `tenants` + 모든 업무 테이블 `tenant_id` + 복합 FK + **PostgreSQL RLS** |
| DB | PGlite, Vercel `/tmp`(비영구) | `pg`(Managed PostgreSQL, `DATABASE_URL`) / PGlite는 테스트·인메모리 DEMO 전용. 운영에서 DB 없이 기동 거부(`DEMO_MODE=true` 제외) |
| 마이그레이션 | 세미콜론 분할 실행 | 전체 SQL `exec` 실행(DO 블록 지원), `schema_migrations` |
| 권한 | region scope SQL, 404 응답 | 유지 + 배정 사례 쓰기 제한, 제공기관 범위, ABAC(공식 판정 확정 권한), 거부 감사 로그 |
| 병원 연계 | 없음(병원 측 mock만 존재) | 수신 DTO/Zod v1.0, 카테고리별 동의·정책 판정, idempotency, 재제출, 상태 콜백 |
| 워크플로 | care_status 4단계 | 연계 8 / 사례 16 / 계획 9 / 서비스 9 상태 + 서버 전이 규칙 |
| AI | Anthropic SDK 요약/구조화 | 규칙 기반 기본 + 선택적 LLM(비식별 사실만), 문장별 근거 검증, draft→승인 |
| 음성 기록 | 있음 | **미포팅** (개인정보 위험·범위 외, 로드맵) |
| 테스트 | node test, e2e smoke | unit/API(33) + Playwright E2E 시나리오 5 + axe + 반응형 3 |

## 재사용(개념·패턴 포팅)
- `lib/server/db/client.ts`의 최소 `Db` 인터페이스 형태 → `pg` 구현 추가, `withTenant()` 추가
- `lib/server/auth/session.ts` HMAC 세션 토큰·`loadActor`(매 요청 DB 재조회) → tenant 포함·역할 다중화
- `lib/server/http.ts` route 래퍼·Zod 오류 응답·rate limit → CSRF 헤더 검사, RLS 트랜잭션, 거부 감사 추가
- `lib/server/errors.ts` AppError 체계
- `lib/domain/matching.ts`의 "단계별 제외 사유 + 미확인 조건 노출" 개념 → 권역·유형·운영·수용 신선도·요일 규칙으로 재작성
- 지역 트리 재귀 CTE, 404로 존재 은닉하는 방식

## 교체·폐기
- PGlite 영구 저장(`/tmp`, `.data/pglite`) → 폐기
- `recipient`/`family` 역할, 포털, family_links → 제외(별도 제품 C)
- 음성 기록·STT → 제외
- SDK 기반 AI 호출 → 서버 `fetch` + 엄격한 스키마/근거 검증, 키 없이 동작

## PR #2(디자인)
다크 톤 대시보드 디자인은 행정형 UI 요구(밝은 배경·네이비 사이드바·compact table)와 맞지 않아 채택하지 않았습니다.
