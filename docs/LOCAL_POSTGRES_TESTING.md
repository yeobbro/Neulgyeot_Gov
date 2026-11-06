# 로컬 PostgreSQL 통합 테스트 (무료 · 합성 데이터 전용)

## 현재 DB 방침

- 정식 서비스용 영구 PostgreSQL은 아직 없습니다. 유료 DB 서비스도 만들지 않습니다.
- 검증은 Docker 또는 로컬 PostgreSQL 16에서만 합니다.
- 데이터는 합성 seed만 씁니다.
- WORIT·WORIT-Staging을 비롯한 공유, 스테이징, 운영 DB는 절대 쓰지 않습니다. 테스트 헬퍼는 `localhost`, `127.0.0.1`, `::1`이 아닌 호스트를 거부합니다.
- Vercel(Production/Preview)은 지금 `DATABASE_URL`이 없습니다. 인스턴스마다 메모리 DEMO DB(PGlite)를 쓰며 데이터는 남지 않습니다. 자세한 내용은 `docs/DEPLOYMENT.md`에 있습니다.

## 실행

```bash
docker compose -f docker-compose.test.yml up -d --wait
#   Docker Hub 요청 제한(429)이 나면:
#   POSTGRES_TEST_IMAGE=public.ecr.aws/docker/library/postgres:16-alpine docker compose -f docker-compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://gov_test:test-only-local@127.0.0.1:55433/gov_test npm run test:pg
docker compose -f docker-compose.test.yml down
```

- 컨테이너 저장소는 tmpfs입니다. 내리면 데이터가 남지 않습니다.
- Docker 없이 로컬에 PostgreSQL 16이 설치되어 있으면, 같은 형식의 관리자 URL을 `TEST_DATABASE_URL`에 주면 됩니다.
- `TEST_DATABASE_URL`이 없으면 `npm run test:pg`의 모든 테스트가 **skip**됩니다. 일반 `npm test`(PGlite)는 영향을 받지 않습니다.
- CI(`.github/workflows/ci.yml`의 `postgres` 잡)는 서비스 컨테이너로 같은 테스트를 실행합니다.

## 테스트가 하는 일

실행할 때마다 임의 이름의 DB를 만들고, 끝나면 `DROP DATABASE … WITH (FORCE)`로 지웁니다.

- DB 소유자는 **슈퍼유저가 아닌 `CREATEROLE` 역할**(`neulgyeot_test_owner`)입니다. 관리형 PostgreSQL의 소유자 계정과 같은 조건에서 마이그레이션합니다.
- 앱 쿼리는 `neulgyeot_app`(NOLOGIN, NOBYPASSRLS)으로 전환해 RLS 아래에서 실행합니다.

| 파일 | 검증 내용 |
|---|---|
| `tests/pg/pg-migrations.test.ts` | 001–006 적용과 재실행 무변화, 소유자·앱 역할 속성, 전체 테넌트 테이블 RLS·정책, 권한(ai_jobs DELETE 없음, 감사 로그 append-only), 전체 롤백 후 재적용, legacy 데이터 006 backfill(이중 승인 분리), `ai_drafts_one_target` NOT VALID → VALIDATE 실패 → 정리 → VALIDATE 성공, 005 down의 원자적 거부 |
| `tests/pg/pg-security.test.ts` | 실제 연결 풀에서 RLS(교차 테넌트 조회·수정·삽입, 테넌트 미설정), 승인 권한 API, 두 검토자의 동시 선택·승인·보류, 잠금 대기 중 커밋된 형제 초안 감지, 동시 AI 요청(같은 키·같은 초안) |
| `tests/pg/pg-worker.test.ts` | 워커 4개(한 풀) 정확히 1회 처리, 임대 만료 후 이어받기와 이전 임대 기록 차단, network·503 재시도와 시도 상한, **워커 OS 프로세스 3개**(`scripts/ai-worker.mts`) + 계약 스텁 서버로 정확히 1회 처리, SIGTERM 정상 종료, 로그에 비밀값 없음 |

## 운영 DB를 만들 때 (승인 필요, 지금은 하지 않음)

1. 스테이징과 운영을 **별도 인스턴스**로 둡니다. Preview 환경에만 스테이징 `DATABASE_URL`을 넣습니다.
2. 소유자 계정은 `CREATEROLE`, 앱 계정과 워커 계정은 따로 둡니다.
3. `npm run db:migrate`로 적용하고, `schema_migrations`와 `to_regclass('public.ai_jobs')`로 확인합니다.
4. `ai_drafts_one_target` 위반 행을 점검·정리한 뒤 `VALIDATE CONSTRAINT`를 실행합니다.
