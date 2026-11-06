# Production 상태 점검과 운영 준비 체크리스트

## 1. 점검 도구 (이 저장소에 포함)

| 명령 | 용도 | 안전성 |
|---|---|---|
| `npm run test:smoke` (`SMOKE_BASE_URL=…`) | 배포 환경 읽기 전용 스모크: 헬스, 리다이렉트, 401, 404, 보안 헤더, 화면 렌더링(1440·390px), 콘솔·페이지 오류, 로그인 API 읽기 | 브라우저의 GET 아닌 요청은 데모 로그인을 빼고 모두 **차단**합니다. 로그인 상태 점검은 `/api/health`가 `demoMode=true` + `persistent=false`일 때만 합니다 |
| `npm run check:env -- --profile=demo\|staging\|production\|worker [--env-file=…]` | 환경변수 점검 | 값을 출력하지 않습니다(이름, 설정 여부, 길이, URL 종류만) |
| `npm run test:pg` (`TEST_DATABASE_URL=…`) | 실제 PostgreSQL 16 통합 테스트 | localhost만 허용, 임의 DB를 만들고 삭제 |
| `GET /api/health` | 저장소 종류·영구 여부·데모 여부·DB 상태 | 공개, 내용 없음 |
| `GET /api/admin/ai-metrics` | AI 작업 지표(관리자) | 내용 없음 |
| 워커 `127.0.0.1:$AI_WORKER_HEALTH_PORT/healthz` | 워커 상태 | 로컬 전용 |

## 2. 2026-11-06 Production 점검 결과

대상은 `https://neulgyeot-municipality.vercel.app`, 배포 `dpl_CknhJPWMo265ZzBQmwrpg17rNy13`, 커밋 `4423777`(PR #4, main 최신)입니다.

- **빌드:** 성공(18초). 경고 2종이 있습니다.
  - `engines.node ">=20"`: Node 메이저 버전이 자동으로 올라갈 수 있습니다. 고정을 권장합니다.
  - esbuild install script 허용 목록 미등록.
- **런타임 오류(24시간):** 0건입니다.
- **별칭:** `neulgyeot-municipality.vercel.app`, `…-doyeop1225-2857.vercel.app`, `…-git-main-…vercel.app`.
- **`npm run test:smoke`:** **89/89 통과**.
  - 확인한 화면: 대시보드, 연계, 사례, AI 탭, 계획, 서비스 의뢰, 제공기관, 지도, 업무, 보고서, 감사, 관리자, 제공기관 포털(1440px), 주요 5개 화면(390px).
  - 확인한 API: 로그인 GET 9종 200, 비로그인 6종 401, 사례관리자의 관리자 지표 접근 403.
  - 그 밖에: 콘솔·페이지 오류 0, 차단된 쓰기 시도 0, 기관 AI 스위치 꺼짐, AI 작업 0건, AI 요청 버튼 숨김.
- **데모 로그인 사용:** 데모 모드가 제공하는 합성 계정 로그인만 썼습니다. 인증 우회는 아닙니다.
  - 로그인은 메모리 DB에 세션·감사 기록을 남깁니다(인스턴스 재시작 시 사라짐).
  - 그 밖의 생성·수정·승인은 하지 않았습니다.

## 3. 운영 준비 체크리스트

상태 표기: ✅ 완료 · 🟡 부분 · ⬜ 미완료 · 🔒 승인 필요

### 플랫폼
- ✅ 보안 헤더(CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy)
- ✅ 비로그인 API 401, 보호 페이지 로그인 리다이렉트, 404 페이지
- ✅ 영구 DB 연결 시 공개 세션 키와 데모 로그인 차단(이 브랜치)
- ⬜ `engines.node`를 정확한 메이저로 고정(Vercel 경고)
- ⬜ 운영 마이그레이션을 배포 파이프라인 단계로 분리
- 🔒 `SESSION_SECRET` 설정, `DEMO_MODE` 해제(실데이터 전환 시)

### 데이터베이스
- ✅ 001–006 마이그레이션, RLS, 권한, 동시성 — 로컬 PostgreSQL 16 + CI
- ✅ 트랜잭션 풀러 호환(코드 확인)
- ⬜ 운영 DB 선정(국내·공공 요건), 계정 3종, 백업·PITR·복구 리허설 — `docs/DATABASE_ARCHITECTURE.md`
- 🔒 스테이징·운영 DB 생성과 마이그레이션 적용, `VALIDATE CONSTRAINT ai_drafts_one_target`

### AI Intelligence
- ✅ Provider 어댑터, 허용 목록, 소견·자유 서술 차단, 합성 데이터 전용 게이트, 근거·수치·날짜 검증, 재시도·timeout·breaker·fallback
- ✅ 계약 검증: v1.1 OpenAPI 대비 요청 검증(`tests/unit/ai-contract.test.ts`), 시제품 실행 확인(2026-11-06)
- ✅ 작업 큐·워커: 중복 방지, 임대 복구, 재시도, 종료 처리 — 모의 Provider·스텁·실제 PG 프로세스
- ⬜ 실제 모델 추론 경로(`status: ok`) 검증 — 모델 서버 필요
- 🔒 워커 배포(내부망), 기관별 토큰 발급·KMS, 기관 `ai_enabled` 켜기

### 개인정보·규정
- ⬜ 개인정보 영향평가, 위탁 계약, 국외 처리 검토(현재 앱 실행 리전 `iad1`)
- ⬜ 공공기관 클라우드 보안인증(CSAP) 요구 여부 확인
- ⬜ 보존 기간 확정과 삭제 배치(`docs/AI_PRODUCTION_READINESS.md` §5)
