# 데이터베이스 영구 저장 아키텍처 (현황 · 위험 · 권고)

작성일은 2026-11-06입니다. 이 문서는 조사와 설계만 담고 있습니다. 실제 DB 생성, 운영 환경변수 변경, 운영 마이그레이션은 하지 않았습니다.

## 1. 현재 구조 (코드로 확인)

| 영역 | 구현 | 위치 |
|---|---|---|
| 연결 선택 | `DATABASE_URL`이 있으면 `pg` Pool, 없으면 PGlite(메모리) | `lib/server/db/client.ts` `openDb`, `storageMode` |
| 운영 안전장치 | `NODE_ENV=production` + `DATABASE_URL` 없음 + `DEMO_MODE≠true`이면 기동을 거부합니다 | `getDb` |
| 프로세스 단위 캐시 | `globalThis.__ngMuniDb`에 DB를 1개 둡니다. PGlite는 인스턴스마다 따로 생기고 seed됩니다 | `getDb` |
| Pool | `max = DATABASE_POOL_MAX`(기본 5), `idleTimeoutMillis 10s`, SSL은 기본 검증(`sslmode=disable` URL만 해제) | `openPostgres` |
| 테넌트 컨텍스트 | 요청마다 트랜잭션 → `set_config('app.tenant_id', $1, true)` + `SET LOCAL ROLE neulgyeot_app` | `withTenant` |
| RLS | 모든 테넌트 테이블 `tenant_id = current_setting('app.tenant_id', true)`. FORCE가 없어 소유자 연결은 우회합니다. 소유자 연결은 로그인, 헬스, 연계 API 인증, 워커 테넌트 목록 조회에만 씁니다 | `002_rls`, `005_ai_jobs` |
| 권한 | `neulgyeot_app`은 NOLOGIN·NOBYPASSRLS. 감사 로그 등은 추가만 가능하고, `ai_jobs`는 DELETE가 없습니다 | `002_rls`, `005` |
| 마이그레이션 | `openDb`가 시작할 때 자동 적용합니다(트랜잭션별 1개, `schema_migrations`). `npm run db:migrate`, 워커는 `migrate:false` | `lib/server/db/migrate.ts` |
| 트랜잭션 | `route()`/`withPage()`가 요청 전체를 하나의 `withTenant` 트랜잭션으로 감쌉니다. AI 작업은 짧은 트랜잭션 3단계로 나눕니다 | `lib/server/http.ts`, `lib/server/ai/jobs.ts` |

### 1.1 커넥션 풀러 호환성 (확인함)

- 이름 붙은 prepared statement, 세션 수준 `SET`, advisory lock, `LISTEN/NOTIFY`, 임시 테이블은 **쓰지 않습니다**(코드 검색으로 확인).
- 테넌트 설정은 `set_config(…, true)`와 `SET LOCAL`로 **트랜잭션 범위**에서만 바뀝니다.

따라서 **PgBouncer 계열 트랜잭션 풀링과 호환**됩니다. 연결이 다른 요청과 섞여도 테넌트 설정이 새지 않습니다.

## 2. 현재 Production (2026-11-06 실측)

| 항목 | 결과 |
|---|---|
| `/api/health` | `storage.kind = "pglite-memory"`, `persistent = false`, `demoMode = true`, `db = "ok"` |
| Vercel 환경변수 | `DEMO_MODE`, `AI_FEATURE_ENABLED`만 있음(Production·Preview). `DATABASE_URL`·`SESSION_SECRET` 없음 |
| 저장 | **영구 저장 불가.** 인스턴스(Fluid compute)가 바뀌거나 재배포되면 초기 합성 데이터로 돌아갑니다. 인스턴스가 여러 개면 인스턴스마다 데이터가 다릅니다 |
| 세션 키 | 저장소에 공개된 대체 키를 씁니다. **누구나 세션을 위조할 수 있으므로** 합성 데모에서만 허용됩니다 |

인스턴스별 분리는 코드(`globalThis` 캐시 + 인스턴스별 seed)로 확인했습니다. 실제로 서로 다른 인스턴스의 데이터가 갈리는 것은 쓰기가 필요하므로 Production에서 실험하지 않았습니다.

**영구 저장이 불가능해 실제 업무에 쓸 수 없는 기능**은 다음과 같습니다(데모로는 동작).

- 연계 접수와 처리, 사례·평가·계획·회의·서비스 의뢰·모니터링 기록
- 초안 승인과 사례 기록
- 감사 로그
- 기관 설정(`ai_enabled` 포함)
- 제공기관 가용량, 공공 디렉터리 가져오기
- AI 작업 큐: 워커가 공유할 DB가 없으므로 메모리 DB에서는 원리상 처리할 수 없습니다

**DEMO와 실데이터가 섞일 위험과 이번 조치**

- 지금은 DB가 메모리뿐이라 섞일 대상이 없습니다.
- 위험은 **나중에 `DATABASE_URL`을 넣으면서 `DEMO_MODE=true`를 그대로 두는 경우**입니다. 이 경우 기존 코드에서는 다음이 남았습니다.
  1. 비밀번호 없는 데모 로그인이 운영 DB에서 계속 켜져 있습니다.
  2. 공개된 대체 세션 키가 계속 허용됩니다.
- **이 브랜치에서 막았습니다.**
  - Production에서 `DATABASE_URL`이 있으면 대체 키를 쓰지 않습니다(요청 실패로 닫힘).
  - 데모 로그인은 `DEMO_LOGIN=true`를 명시해야만 켜집니다. 합성 스테이징 전용입니다.
  - `npm run check:env -- --profile=production`이 이런 설정을 오류로 잡습니다.

## 3. 서버리스(Vercel) 환경의 DB 연결

| 문제 | 대응 |
|---|---|
| 인스턴스마다 Pool이 생겨 연결 수가 폭증할 수 있음 | 공급자의 **트랜잭션 풀러 엔드포인트**를 `DATABASE_URL`로 씁니다. 앱 쪽은 `DATABASE_POOL_MAX=1–5`. `check:env`가 경고합니다 |
| 함수 리전과 DB 리전이 멀면 요청당 여러 쿼리마다 지연이 붙음 | 함수 리전을 DB와 같은 리전(예: 서울 `icn1`)으로 맞춥니다. 현재 빌드·함수는 `iad1`(미국 동부)입니다 |
| 유휴 연결 정리 | `idleTimeoutMillis 10s`(현재). 운영 전에 Fluid compute의 연결 정리 권장 방식을 다시 확인해야 합니다 |
| 시작할 때 자동 마이그레이션 | 운영에서는 배포 파이프라인의 `db:migrate` 단계로 분리하는 것이 안전합니다(여러 인스턴스가 동시에 마이그레이션하는 것을 피함). **다음 단계 작업** |
| DB 장애 | `/api/health`가 503을 돌려주고, 요청은 오류로 끝납니다. 메모리 DB로 **자동 전환하지 않는 것이 맞습니다**(실데이터와 데모가 섞이는 것을 막기 위해) |

## 4. 공급자 비교 (가격은 2026-11 공개 자료 기준, 계정 생성·가입은 하지 않음)

| 공급자 | 서울 리전 | 비용(소규모) | 풀링 | 백업/PITR | 공공 인증(CSAP) | 평가 |
|---|---|---|---|---|---|---|
| **NAVER Cloud – Cloud DB for PostgreSQL** | 예(국내) | 시간 종량제. 최소 사양 가격은 공개 페이지에서 확인하지 못함 | 별도 구성 | 자동 백업 최대 30일, 해당 기간 내 시점 복구, 자동 failover | **CSAP SaaS 표준등급**(2024-04, 공공기관용 존) | **실데이터 운영 후보 1순위.** 지자체 도입 요건과 맞추기 쉽습니다. Vercel과 거리·네트워크 구성이 과제입니다 |
| AWS RDS for PostgreSQL | 예(ap-northeast-2) | db.t4g.micro 약 $18/월, small 약 $37/월(컴퓨트만, 스토리지·백업 별도) | RDS Proxy(별도 요금) 또는 PgBouncer | 자동 백업·PITR | 공공 도입 시 별도 확인 | 성숙도 높음, 운영 부담 중간 |
| Supabase | 예(Seoul) | Pro $25/월~(Micro 컴퓨트 포함), PITR은 $100/월(7일) | 내장 풀러 | 일일 백업 7일 | 별도 확인 | **사용자 방침상 지금은 사용하지 않음.** WORIT과 분리 필요 |
| Neon | **서울 없음**(아시아는 싱가포르·시드니) | Free(100 CU-h·1 GB/프로젝트) / Launch $0.106/CU-h, 스토리지 $0.35/GB-월 | 내장(최대 10,000) | Launch 최대 7일, Scale 30일 | — | **합성 데이터 스테이징 용도로는 적합(무료로 시작 가능).** 실데이터는 국외이전 문제로 부적합 |
| 로컬 / Docker PostgreSQL 16 | — | 무료 | — | — | — | **현재 테스트 표준**(`npm run test:pg`) |

### 권고

1. **지금:** 로컬·Docker PostgreSQL로 검증합니다(`docs/LOCAL_POSTGRES_TESTING.md`, CI `postgres` 잡). 비용은 0입니다.
2. **합성 데이터 스테이징이 필요해지면:** 무료 또는 저가 관리형 DB 1개를 둡니다(예: Neon Free 또는 AWS RDS micro). Preview 환경에만 연결하고, `DEMO_LOGIN=true` 명시와 합성 seed만 씁니다. **비용이 생길 수 있으므로 승인 후 진행합니다.**
3. **실데이터 운영:** 국내 리전과 공공 인증 요건을 충족하는 DBaaS(예: NAVER Cloud 공공존 Cloud DB for PostgreSQL)를 씁니다. 다음이 함께 필요합니다.
   - 앱 호스팅도 같은 요건(국내 처리, 인증)을 충족하는지 검토합니다. 현재 앱은 Vercel `iad1`(미국)에서 실행되므로 **개인정보 국외 처리 이슈**가 있습니다.
   - 운영 계정을 분리합니다(소유자 / 앱 / 워커).
   - 스테이징 인스턴스를 따로 두고, 백업·복구 리허설을 합니다.

공공기관에 CSAP 인증이 필수인지, 국외 처리가 허용되는지는 **도입 기관의 정보보호·개인정보 담당 부서와 법무 검토로 확정**해야 합니다. 이 문서는 그 판단을 대신하지 않습니다.

## 5. 실행 계획 (각 단계 승인 필요)

| 단계 | 작업 | 산출물·검증 |
|---|---|---|
| 0 (완료) | 로컬 PG 통합 테스트, CI `postgres` 잡, 환경 점검 도구, 영구 DB 대비 세션·데모 차단 | `npm run test:pg`, `npm run check:env` |
| 1 | 운영 마이그레이션을 배포 단계로 분리(시작 시 자동 적용을 운영에서는 끔) | 설계 PR |
| 2 | 합성 스테이징 DB 1개(Preview 전용) + 함수 리전을 DB와 맞춤 | `check:env --profile=staging`, `test:smoke`(Preview URL) |
| 3 | 운영 DB 선정(공공 요건 검토) → 계정 3종, 백업·PITR, 모니터링 | 복구 리허설 기록 |
| 4 | `db:migrate`(스테이징 → 운영), `VALIDATE CONSTRAINT ai_drafts_one_target` | 마이그레이션 검증 쿼리(`docs/LOCAL_POSTGRES_TESTING.md`) |
| 5 | `DEMO_MODE` 해제, `SESSION_SECRET` 설정, `check:env --profile=production` 0 오류 → 배포 | 스모크 테스트 |
