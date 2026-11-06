# AI Intelligence 운영 준비 (설계 · 검증 결과)

이 문서는 실제 AI 연결 **전에** 필요한 실행 구조, 기관 설정, 토큰, 모니터링, 보존, 계약 검증을 정리합니다.

이 브랜치는 다음 작업을 하지 않습니다.

- 운영 DB 마이그레이션, 운영 환경변수 변경
- Vercel 배포, 워커 배포, 스케줄 등록
- 실제 AI 서버 연결

> 상태 표기: **구현** = 코드와 테스트가 있음 · **설계** = 문서만 있음 · **승인 대기** = 운영 환경 변경이 필요함

## 1. 워커 실행 방식 비교와 권고

### 1.1 전제

| 항목 | 내용 |
|---|---|
| AI 추론 시간 | 로컬 모델 실측 75–174초(CPU). 모델·부하에 따라 수 분 이상 걸릴 수 있음 |
| Vercel 함수 실행 시간 | Hobby 최대 300초. Pro/Enterprise 최대 800초(베타로 1800초) |
| Vercel Cron | 함수와 같은 실행 시간 한도. 실패해도 재시도하지 않음. 중복 실행될 수 있음. Hobby는 하루 1회만 |
| 네트워크 | AI Intelligence는 기관 내부망 또는 전용 서버에 두는 설계. Vercel 함수에서 내부망으로 가는 경로가 없음 |

Vercel 수치 출처는 [Functions limits](https://vercel.com/docs/functions/limitations), [Cron jobs](https://vercel.com/docs/cron-jobs), [Cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)입니다. 2026-11 기준이며, 운영 결정 전에 다시 확인해야 합니다.

### 1.2 비교

| 항목 | A. Vercel Cron + 짧은 워커 | **B. 독립 상시 워커 (권고)** | C. 외부 큐 서비스 + 워커 |
|---|---|---|---|
| 처리 시간 | 300–800초 한도. 긴 추론은 잘림 | 제한 없음. job timeout·임대로 관리 | 워커 형태에 따라 다름(대부분 B와 같음) |
| AI 서버 접근 | 내부망 접근 불가. 공개 엔드포인트 필요 → 공격면 증가 | AI 서버 옆(같은 망)에 배치 | B와 같음 |
| 동시성·중복 | Cron 중복 실행 가능. `SKIP LOCKED` + 임대로 방어 가능 | 여러 인스턴스 안전(구현·검증됨) | 큐 의미론에 의존. 그래도 DB 임대 필요 |
| 재시도 | Cron 자체 재시도 없음. 큐가 담당 | 큐가 담당(network/503만) | 이중 재시도 위험 |
| 장애 복구 | 다음 Cron까지 지연 | 임대 만료 후 다른 인스턴스가 이어받음(검증됨) | 큐 가시성 타임아웃 |
| 모니터링 | Vercel 로그 | `/healthz` + JSON 로그 + DB 지표 | 큐 대시보드 + 워커 |
| 테넌트 격리 | 같음(`withTenant`/RLS) | 같음 | 큐 메시지에 tenant를 넣어야 함 → 추가 검증 필요 |
| 비용 | 함수 실행 시간 과금(대기 시간도 과금) | 작은 VM/컨테이너 1–2대 | 큐 서비스 + 워커 |
| 배포 복잡도 | 낮음 | 중간(프로세스 관리자, 비밀, 망) | 높음(새 인프라, 새 장애 지점) |
| 엔드포인트 노출 | 워커 실행 URL 필요(CRON_SECRET) | **없음** | 없음 |

### 1.3 권고

**B. 독립 상시 워커를 AI Intelligence 서버와 같은 내부망에 둡니다.** 이유는 다음과 같습니다.

1. 추론 시간이 서버리스 한도에 가깝거나 넘습니다.
2. 내부망 AI 서버에 서버리스가 닿지 않습니다.
3. 워커를 실행하는 HTTP 엔드포인트가 없으므로, 외부 요청으로 무단 실행될 수 없습니다.
4. 기존 PostgreSQL을 큐로 그대로 씁니다(`ai_jobs`). 새 인프라가 없습니다.

A는 AI가 공개 HTTPS로 접근 가능한 관리형 서비스이고 추론이 수십 초 이내일 때만 대안이 됩니다. 이 경우에도 CRON_SECRET 검증, 짧은 job timeout, 1회 처리량 제한이 필요합니다.

C는 처리량이 DB 큐 한계를 넘을 때 다시 검토합니다. 기준은 대략 분당 수백 건입니다.

### 1.4 구현 상태: 구현 (모의 Provider로 검증, 배포·스케줄 없음)

| 요구사항 | 구현 |
|---|---|
| 인증된 내부 실행 | `scripts/ai-worker.mts`. `AI_WORKER_ENABLED=true`, `DATABASE_URL`, 유효한 Provider 설정이 없으면 시작을 거부합니다. https가 아니면 localhost만 허용합니다. 앱에는 작업을 실행하는 엔드포인트가 없습니다 |
| 테넌트별 작업 조회 | `listAiEnabledTenants`(owner 연결로 id만 조회) → 테넌트마다 `claimJobs`(RLS, 비소유자 역할) |
| 선점·임대·중복 방지 | `FOR UPDATE SKIP LOCKED` + `lease_owner`/`lease_expires_at`. 결과는 임대(소유자 + 시도 번호)를 가진 경우에만 저장합니다 |
| timeout | 요청 20초(HTTP), job 300초(`AI_WORKER_JOB_TIMEOUT_MS`). 임대는 job timeout보다 길어야 시작됩니다 |
| retry / circuit breaker | network·503만 백오프 재시도. breaker가 열려 있으면 시도를 차감하지 않고 연기합니다. half-open에서는 시험 호출 1회만 허용합니다 |
| graceful shutdown | SIGTERM/SIGINT → 새 선점 중단 → 유예 시간(기본 30초) 뒤 미완료 작업을 반환(pending, 시도 환불). 늦게 온 결과는 폐기 |
| 실패 복구 | 프로세스가 죽으면 임대 만료 후 다른 인스턴스가 이어받습니다. 마지막 시도였다면 `lease_expired`로 실패합니다 |
| 감사 | `ai.job.enqueue/retry/defer/release/complete/fail/cancel/stale` |
| 헬스 체크 | `AI_WORKER_HEALTH_PORT`의 `127.0.0.1/healthz`. 상태, 마지막 tick, 진행 중 작업 수, breaker 상태, 카운터를 돌려주며 내용은 없습니다 |

검증 결과입니다.

- 단위·API 테스트는 `tests/api/ai-worker.test.ts`, `ai-jobs.test.ts`입니다.
- 이 작업에서 **로컬 PostgreSQL 16(테스트 전용)** 으로 추가 확인했습니다.
  - 워커 프로세스 3개가 작업 12건을 4/5/3으로 나눠 처리했습니다. 모두 시도 1회, AI 초안 12건, 중복 0건이었습니다.
  - 처리 중인 워커를 `kill -9`로 종료했습니다. 임대가 유효한 동안 다른 워커는 손대지 않았고, 만료 뒤 구조 워커가 시도 2로 완료했습니다.

### 1.5 운영 배치안 (승인 대기)

- **배치:** 워커 컨테이너 2대(가용성)를 AI 서버와 같은 내부망에 둡니다. 프로세스 관리자(systemd 또는 컨테이너 재시작 정책)로 관리합니다.
- **DB 계정:** 워커 전용 로그인을 씁니다. `neulgyeot_app` 역할 멤버십과 `tenant_settings`(`tenant_id`, `ai_enabled`) 읽기 권한만 줍니다. 앱 소유자 계정과 분리합니다.
- **설정값:**
  - `AI_WORKER_POLL_MS=5000`, `AI_WORKER_JOB_TIMEOUT_MS=300000`, `AI_WORKER_LEASE_SECONDS=600`, `AI_WORKER_SHUTDOWN_GRACE_MS=30000`
  - AI 서버 동시성(`EXT_LLM_CONCURRENCY`)에 맞춰 인스턴스 수와 `perTenantLimit`을 정합니다.
- **배포 순서:**
  1. 스테이징 DB에 마이그레이션 005·006을 적용합니다.
  2. 스테이징 워커와 스테이징 AI(합성 데이터)로 검증합니다.
  3. 기관별로 `ai_enabled`를 켭니다.

## 2. 기관별 AI 설정

| 설정 | 현재 | 설계 |
|---|---|---|
| AI 사용 여부 | **구현.** `tenant_settings.ai_enabled`(기본 false). 요청할 때와 실행할 때 모두 확인합니다. 관리자 화면 문구도 고쳤습니다 | 변경을 감사 기록으로 남깁니다(기존 `settings.update`) |
| 허용 데이터 범위 | **구현(코드 상수).** `fact-policy.ts` 허용 목록, `NEVER_SEND` | 기관별로 더 좁히기만 허용(`tenant_settings.ai_allowed_fields`). 넓히는 것은 불가 |
| 데이터 등급 | **구현.** 테넌트·대상자 `is_synthetic`이 모두 true일 때만 전송합니다. 실데이터는 네트워크 호출 전에 차단합니다(`real_data_blocked`) | 실데이터 허용은 개인정보 영향평가와 위탁 계약 후 별도 설계 |
| 허용 모델 | 설계 | `ai_allowed_models text[]`. 응답의 `model`이 목록에 없으면 결과를 거부합니다 |
| 요청 횟수 제한 | 부분. 초안 생성은 20회/분/사용자. 작업은 초안당 활성 1개 | 기관별 일일 작업 한도(`ai_daily_job_limit`). enqueue할 때 확인 |
| 처리 시간 제한 | 구현(워커 전역 설정) | 기관별 `ai_job_timeout_ms`(상한은 워커 설정) |
| 장애 시 fallback | **구현.** 규칙 초안이 항상 남고, 실패 사유는 안전 문구로 표시 | — |

## 3. 토큰 관리 (설계 · 실제 토큰은 생성하거나 저장하지 않음)

| 항목 | 설계 |
|---|---|
| 단위 | 테넌트 × 제품(`community`)당 1개. 다른 기관 토큰은 절대 빌리지 않습니다(구현). 서버가 토큰의 테넌트와 `X-Tenant-Id`를 대조합니다(프로토타입에서 확인) |
| 최소 scope | `ai:summarize`만. 예측·검색 scope는 기능을 켤 때 따로 발급 |
| 만료·회전 | 만료 90일. 30일 전부터 새 토큰과 겹쳐 쓰고, 워커 재시작 없이 다시 읽습니다(구현 필요). 만료되면 `token_expired`로 실패하고 규칙 초안이 남습니다(확인됨) |
| 폐기 | AI 서버 레지스트리에서 폐기하면 `token_revoked`(401). 사고 시 기관 `ai_enabled=false`를 먼저 적용 |
| 저장 | 운영: KMS·비밀 관리자 → 워커 환경변수 `AI_INTELLIGENCE_TENANT_TOKENS`(워커만). Vercel(앱)에는 두지 않습니다(앱은 AI를 호출하지 않음) |
| 로그 노출 차단 | 구현. 토큰·연결 문자열·Provider 오류 문자열은 로그와 DB에 남기지 않습니다(테스트로 확인). 워커 tick 오류는 오류 클래스명만 남깁니다 |

## 4. 모니터링

**구현:** `GET /api/admin/ai-metrics?days=N`(관리자 전용, 기관 범위, 내용 없음)과 워커 `/healthz`.

| 지표 | 출처 | 경보 예시(설계) |
|---|---|---|
| 성공률 / 실패율 / 규칙 fallback 비율 | `ai_jobs.status` | 실패율 > 30%(1시간) |
| 평균·p95 처리 시간 | `completed_at - started_at` | p95 > job timeout의 80% |
| Timeout 비율 | `error_code IN (timeout, job_timeout, lease_expired)` | > 10% |
| 재시도 횟수, 연기 횟수, 종료 시 반환 | `attempt_count`, 감사 `ai.job.defer/release` | 연기 급증 = AI 서버 장애 |
| Circuit breaker 상태 | 워커 `/healthz` | open 5분 이상 |
| 테넌트별 요청량 | 기관별 `jobs.requested` | 일일 한도 근접 |
| AI 초안 승인·폐기 비율, 규칙 초안 선택 | `ai_drafts`(source_job_id), 그룹 | 폐기율 > 70% → 품질 검토 |
| 대기 적체 | `pending` 수, 가장 오래된 `next_attempt_at` | 15분 이상 적체 |

원칙은 다음과 같습니다.

- 지표·로그·헬스에는 id, 코드, 수, 시각만 넣습니다.
- 초안 본문, 사실 텍스트, 프롬프트, 모델 출력, 토큰은 넣지 않습니다.

## 5. 보존 정책 (설계 · 자동 삭제는 구현하지 않음)

| 데이터 | 보존 | 방법 |
|---|---|---|
| `ai_jobs` | 종료 후 1년 | 앱 역할에는 DELETE 권한이 없습니다. 운영 배치(owner)로 아카이브 후 삭제 |
| `ai_drafts` 승인본 | 사례 기록 보존 기간을 따름 | 공식 기록은 `case_records`에 복사됩니다 |
| `ai_drafts` 미승인·폐기본 | 그룹 종료 후 1년 | 원문 사실 스냅샷이 들어 있으므로 기간 만료 후 삭제 |
| 감사 로그 | 기존 감사 정책(append-only) | 변경 없음 |
| 실패 메타데이터 | 코드와 안전 문구만 있으므로 `ai_jobs`와 함께 | — |
| 모델·프롬프트 버전 | 승인된 초안과 같은 기간 | 승인 근거 재현용 |

기간은 기관 기록관리 기준과 개인정보 처리방침에 맞춰 **승인 후** 확정합니다.

## 6. AI Intelligence v1.1 계약 검증 (프로토타입, 합성 데이터)

`KREWX/02_Platform/Neulgyeot-AI-Integration-Design/prototype`과 `Neulgyeot-AI-Intelligence`를 읽기 전용으로 복사했습니다(원본은 수정하지 않음). 이를 클라우드 작업 공간에서 실행했습니다(rules 엔진, LLM 없음, 테스트 토큰).

| 항목 | 결과 |
|---|---|
| `GET /health` | `contract_version 1.1.0-proto`, `data_policy synthetic_only`, `external_llm blocked`. Gov `healthResponseSchema`를 통과합니다 |
| 요청 스키마 | openapi `SummarizeIn`과 필드가 일치합니다. Gov가 더 엄격합니다(`.strict()`, `kind: structured` 고정, `allow_free_text: false` 고정, 섹션 ≤ 8, 레코드 ≤ 60, id 패턴 동일) |
| 응답 스키마 | openapi에는 응답 모델이 없습니다. 실제 응답이 Gov `summarizeResponseSchema`를 통과하는지 확인했습니다(`status: no_result`, `reason: llm_disabled`) |
| 인증·테넌트 | 본인 토큰은 200입니다. 다른 기관 토큰은 403 `tenant_mismatch`, hospital 제품 토큰은 403 `tenant_mismatch`, 만료 토큰은 401 `token_expired`, 토큰이 없으면 호출 없이 `no_tenant_token`입니다 |
| 데이터 최소화 | ir_2 사실 11건 중 9건만 전송했습니다. 소견 존재 사실과 보완 요청 항목은 제외됐고, 소견 원문 문자열은 요청에 없었습니다 |
| 실데이터 | `dataClass: real`이면 요청하지 않습니다(`real_data_blocked`) |
| 오류 코드 | 프로토타입 코드(`token_expired`, `token_revoked`, `unauthenticated`, `forbidden_scope`, `tenant_mismatch`, `real_data_blocked`, `input_too_large`, `invalid_request`, `busy`, `internal_error`, `no_usable_records`, `schema_invalid`, `llm_disabled`)를 허용 목록에 추가했습니다. 그 밖의 값은 `provider_error`로 저장합니다 |
| 재시도 | 503 `busy`는 요청 안에서 1회 재시도한 뒤, 작업 큐에서 `unavailable`로 백오프합니다 |
| 추적 | `X-Request-Id` = trace id. 응답 헤더가 다르면 결과를 거부합니다 |
| 모델·프롬프트 버전 | 응답의 `model`·`prompt_version` → `ai_jobs.model_version/prompt_version`과 AI 초안 `content.ai` |

미검증 항목은 다음과 같습니다.

- **LLM이 실제 문장을 만드는 `status: ok` 경로**는 이번 환경에 모델이 없어 프로토타입으로 확인하지 못했습니다. 계약에 맞춘 스텁 서버와 모의 Provider로만 검증했습니다.
- 이전 작업의 실측 기록(`real_model_run.json`, 75–174초)은 있지만 이번에 다시 실행하지 않았습니다.

## 7. 운영 연결 체크리스트 (모두 승인 대기)

1. 개인정보 영향평가, 위탁 계약, 국외 이전 여부 검토. 실데이터 전송은 그 뒤에 별도 설계합니다.
2. 스테이징 DB에 `005_ai_jobs`, `006_ai_draft_review`를 적용합니다.
   - `ai_drafts_one_target` 검증(`VALIDATE CONSTRAINT`) 전에 기존 데이터를 점검합니다.
3. 워커 전용 DB 계정, 워커 배치(내부망), 테넌트 토큰 발급과 저장(KMS)을 준비합니다.
4. 스테이징에서 합성 데이터로 통합 시험을 합니다(실제 모델, `status: ok` 경로, p95 실측).
5. 모니터링 경보 설정, 보존 배치, 운영 문서와 장애 대응 절차를 마련합니다.
6. 기관별로 `ai_enabled`를 단계적으로 켜고 최종 사용자 검수를 합니다.
7. 운영 DB 마이그레이션 → 워커 배포 → 앱 배포 순서로 진행합니다(각 단계마다 승인).
