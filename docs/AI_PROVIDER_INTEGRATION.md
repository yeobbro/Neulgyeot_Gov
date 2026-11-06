# AI Intelligence Provider 연동 (진행 상태)

- 브랜치: `feat/ai-intelligence-provider-integration`
- 설계 원문: `KREWX/02_Platform/Neulgyeot-AI-Integration-Design/`(GOV_GAP_ANALYSIS, PROVIDER_INTERFACE, API_CONTRACT v1.1, SECURITY_MODEL)

## 1. 현재 상태 요약

| 항목 | 상태 |
|---|---|
| 실제 AI Intelligence 연결 | **없음.** 서버 URL·토큰·네트워크 경로 없음. 운영 환경변수 변경 없음 |
| 외부 LLM 호출 | **비활성.** `llmAvailable()` = false, 외부 API 호출 코드 제거 |
| `/api/ai/drafts` | 규칙 엔진만 사용(동작 변경 없음). 규칙 초안이 비교 그룹의 기준이 됩니다 |
| Provider 어댑터(`lib/server/ai/provider.ts`) | 구현. 모의 Provider, 계약 스텁, v1.1 프로토타입(합성 데이터)으로 검증 |
| 비동기 작업 큐(`ai_jobs`) | 마이그레이션 `005` + 요청·상태·취소 API. **기관 AI 스위치(`ai_enabled`, 기본 꺼짐)가 켜져 있을 때만 요청 가능** |
| 초안 검토 Workflow | 마이그레이션 `006` + 비교·선택·보류 API + UI(§8) |
| 워커(`lib/server/ai/worker.ts`, `scripts/ai-worker.mts`) | 구현·테스트. **배포·스케줄 등록 없음**(운영 준비는 `docs/AI_PRODUCTION_READINESS.md`) |
| 운영 DB | 마이그레이션 005·006을 **적용하지 않음**(테스트용 메모리 DB와 로컬 PostgreSQL에서만 확인) |

## 2. 구성

| 파일 | 역할 |
|---|---|
| `lib/server/ai/contract.ts` | API 계약 v1.1 요청·응답 Zod 스키마. 응답이 스키마와 다르거나 `requires_human_review !== true`이거나 예측 `use !== "research_only"`이면 결과 없음으로 처리 |
| `lib/server/ai/fact-policy.ts` | 기본 거부 허용 목록 + `NEVER_SEND` 목록. 결과 타입은 브랜드 타입 `ProviderRecord`(이 함수만 만들 수 있음) |
| `lib/server/ai/provider.ts` | `AIProvider` 인터페이스, `AIIntelligenceProvider`(테넌트별 토큰, `X-Tenant-Id`, `X-Request-Id`, 타임아웃, 재시도, 서킷 브레이커), `composeDraft`(재검증·섹션별 병합·폴백), `providerFromEnv`(기본 꺼짐) |
| `lib/server/ai/jobs.ts` | 비동기 작업: 생성·선점·실행·취소·상태 조회 |
| `lib/server/services/ai.ts` | `buildDraft()`(권한 확인 + 사실 + 규칙 초안, 네트워크 없음), `generateDraft()`(규칙만), `assertDraftReview()`(승인·폐기·AI 요청 권한) |
| `lib/server/db/migrations/005_ai_jobs.ts` | `ai_jobs` 테이블·RLS, `ai_drafts.engine` 확장, `ai_drafts.source_job_id` |
| `lib/server/db/migrations/006_ai_draft_review.ts` | 초안 그룹(`draft_group_id`), 선택 상태, 그룹당 선택·승인 1개, 대상 1개 제약, `source_job_id` FK |
| `lib/server/services/ai-review.ts`, `lib/domain/draft-compare.ts` | 그룹 조회·비교·선택·보류 |
| `lib/server/ai/worker.ts`, `scripts/ai-worker.mts` | 내부 워커(선점·임대·graceful shutdown·헬스) |
| `lib/server/ai/metrics.ts` | 관리자용 AI 운영 지표(내용 없음) |

## 3. 개인정보 필터링

- **기본 거부.** 허용 목록에 있는 시스템 생성 값과, 통제 어휘에 정확히 일치하는 값만 보냅니다.
- 자유 서술은 보내지 않습니다. 대상은 평가 항목 메모, 주거환경, 누락 항목, 사회복지사 소견입니다.
- 식별자 패턴(전화번호, 주민번호 형태 등)이 보이면 허용 목록에 있어도 제외합니다.
- **데이터 등급:** 테넌트와(사례 초안이면) 대상자가 모두 `is_synthetic`일 때만 보냅니다. 그 밖에는 네트워크 호출 전에 차단합니다(`real_data_blocked`).
- **실행 시점 재구성:** 작업을 실행할 때 요청자 권한으로 FactBook을 다시 만듭니다. 따라서 그 사이 바뀐 권한과 동의 상태가 반영되고, 권한을 잃었으면 실패합니다(`requester_not_permitted`).
- 정규식만으로 개인정보가 완전히 제거된다고 가정하지 않습니다. 그래서 "무엇을 지울지"가 아니라 "무엇만 보낼지"로 설계했습니다.
- AI가 인용한 근거는 **이번 요청에 실제로 포함된 사실**이어야 합니다. 그렇지 않으면 그 문장을 버립니다.
- 작업 큐(`ai_jobs`)와 감사 로그에는 다음을 저장하지 않습니다. 실패 메시지는 코드별로 미리 정한 문장만 씁니다.
  - FactBook 원문, 프롬프트, 모델 출력
  - 토큰
  - Provider가 보낸 오류 문자열

## 4. 사회복지사 소견 처리

| 경로 | 처리 |
|---|---|
| 규칙 초안 | 소견이 있으면 "병원 사회복지사 소견이 첨부되었습니다." 문장이 나옵니다. 근거 사실의 텍스트는 고정 문구 `SOCIAL_WORKER_NOTE_PRESENT`이고, 원문이 아닙니다 |
| API 응답·`ai_drafts.content`·출처 참조 | 원문 없음. 출처 참조에는 필드명(`livingNeeds.socialWorkerNote`)만 남습니다. 원문은 연계 상세 화면에서 권한자만 봅니다 |
| AI Provider 요청 | **원문도, 소견이 있다는 사실도, 그 사실의 id도 보내지 않습니다.** `NEVER_SEND`에 있어 `allowFreeText`로도 해제되지 않습니다(`excluded.reason = "never_send"`) |

규칙용 FactBook과 Provider로 보내는 레코드는 타입으로 분리되어 있습니다. Provider는 `ProviderRecord[]`만 받습니다.

테스트: `tests/api/ai-social-worker-note.test.ts`.

## 5. 승인·폐기 권한

승인·폐기(`reviewDraft`), 선택·보류, AI 작업 요청·취소는 같은 쓰기 규칙(`DRAFT_REVIEW_RULES`)을 씁니다. 비교 화면 조회와 작업 상태 조회는 읽기 권한입니다.

**초안의 대상은 하나뿐입니다.** 연계 요약은 `referralId`만, 그 밖의 종류는 `caseId`만 가집니다. 이것을 API, 권한 검사, DB 제약 세 곳에서 확인합니다. PR 자체 리뷰에서 High로 분류해 수정했습니다. 수정 전에는 두 id를 함께 넣어 사례 쓰기 권한으로 연계 초안을 승인할 수 있었습니다.

| 대상 | 필요 권한 | 판정 |
|---|---|---|
| 사례 초안 | `case.write` = `assertCaseWrite` | 관리자, 또는 현재 배정된 사례관리자(`case_assignments.ended_at IS NULL`). 그 외 담당 직원은 403 |
| 연계 초안 | `referral.write` = `assertReferralWrite` | 지역 범위 안에서 조회 가능해야 하고, 관리자이거나 `assigned_user_id`가 본인이어야 함. 그 외는 403 |
| 다른 기관·지역 밖·감사자·서비스 제공자 | — | 404(존재 여부를 숨김) |

- 새 권한이나 역할은 추가하지 않았습니다. 기존 연계 처리 규칙(`transitionReferral`·`acceptReferral`의 "관리자 또는 담당자")을 함수로 꺼냈습니다.
- 이전에는 연계 초안 승인·폐기가 **조회 권한만** 확인했습니다. 이 문제를 고쳤습니다.
- 감사 기록:
  - 성공하면 `ai.approve`/`ai.discard`로 기록합니다(actor, 대상 id, `meta.target`, 시간).
  - 거부되면 `route()`가 `access.denied`로 기록합니다(code, method, 경로).
- CSRF와 인증 정책은 바뀌지 않았습니다.
- 테스트: `tests/api/ai-draft-permissions.test.ts`.

## 6. 비동기 작업 큐 (`ai_jobs`)

### 6.1 목적과 범위

- **목적:** 규칙 초안이 이미 만들어진 뒤, 그 초안에 대한 **AI 제안본**을 백그라운드에서 만듭니다.
- **이유:** 로컬 모델 실측이 75–174초라서, 요청 트랜잭션 안에서 기다릴 수 없습니다.
- **현재 범위:** 테이블, 서비스, 요청·상태·취소 API, 내부 워커, 테스트가 있습니다.
  - 기관 AI 스위치가 꺼져 있으면(기본) 요청이 거부됩니다(409).
  - 워커는 배포·스케줄되지 않았습니다. 따라서 운영에서 작업이 실행되는 일은 없습니다.

### 6.2 테이블

| 컬럼 | 의미 |
|---|---|
| `id`, `tenant_id` | `tenant_id` FK, `UNIQUE(tenant_id,id)` |
| `draft_id` | 원본 **규칙** 초안. 복합 FK `(tenant_id, draft_id)` → `ai_drafts` |
| `job_type` | 현재 `draft_compose`만 |
| `status` | `pending` / `processing` / `completed` / `failed` / `cancelled` |
| `attempt_count`, `max_attempts` | 선점할 때마다 +1. 최대 1–5, 기본 3 |
| `requested_by`, `idempotency_key` | `UNIQUE(tenant_id, idempotency_key)`. 키 형식 `^[A-Za-z0-9_.:-]{8,80}$` |
| `next_attempt_at` | 재시도 백오프 시각 |
| `lease_owner`, `lease_expires_at` | 처리 중인 워커와 임대 만료 시각 |
| `created/started/completed/failed/cancelled_at`, `cancelled_by` | 시간 기록 |
| `error_code`, `error_message_safe` | `^[a-z_]{1,40}$` 코드와, 코드별로 고정된 문장(200자 이하) |
| `engine`, `model_version`, `prompt_version`, `ai_request_id` | 결과 메타데이터. `ai_request_id`는 `^req_[0-9a-f]{20}$` 형식 |
| `result_draft_id` | 생성된 AI 초안. 복합 FK |

제약은 다음과 같습니다.

- `ai_jobs_one_active_per_draft`: 한 초안에는 활성(`pending`·`processing`) 작업이 하나만 있을 수 있습니다(부분 유니크 인덱스).
- 상태별 일관성 CHECK:
  - `processing`이면 임대 정보와 시작 시각이 있어야 합니다.
  - `completed`이면 완료 시각과 결과 초안이 있어야 합니다.
  - `failed`이면 실패 시각과 코드가 있어야 합니다.
  - `cancelled`이면 취소 시각이 있어야 합니다.
- `attempt_count ≤ max_attempts`.

RLS는 다른 테넌트 테이블과 같은 패턴입니다.

- 정책은 `tenant_id = current_setting('app.tenant_id', true)`입니다. 테넌트 설정이 없으면 0행을 반환합니다(fail closed).
- 앱 역할 권한은 `SELECT, INSERT, UPDATE`입니다. **DELETE 권한은 없습니다.**

`ai_drafts`도 바뀝니다.

- `engine` CHECK에 `ai-intelligence`, `hybrid`를 추가합니다.
- `source_job_id` 컬럼을 추가합니다.

`down` 마이그레이션은 Provider 엔진 초안이 있으면 실패합니다(데이터를 암묵적으로 삭제하지 않음).

### 6.3 상태 전이

```
            enqueue (쓰기 권한, 규칙 초안이 draft 상태일 때만)
                │
                ▼
  ┌──────── pending ◀──────────────── 재시도 가능 오류 & 남은 시도 있음 (next_attempt_at = 백오프)
  │             │ claim (FOR UPDATE SKIP LOCKED, attempt+1, lease)            ▲
  │             ▼                                                            │
  │        processing ──────────────────────────────────────────────────────┘
  │         │   │   └─ 임대 만료 & 남은 시도 있음 → 다른 워커가 다시 claim (이전 워커 결과는 폐기)
  │         │   └──── 재시도 불가 오류 / 시도 소진 / 임대 만료+시도 소진 / job timeout ──▶ failed
  │         └──────── AI 초안 검증 통과 ──▶ completed (새 ai_drafts 행, status 'draft')
  └── cancel ──▶ cancelled   (processing 중 취소해도 같음. 늦게 온 결과는 저장하지 않음)

  processing ── circuit open ──▶ pending (시도 환불, 30초 후)      [ai.job.defer]
  processing ── 워커 종료 ──────▶ pending (시도 환불, 즉시)        [ai.job.release]
  pending/processing ── 생성 후 24시간 초과 ──▶ failed(job_expired)
```

- 종료 상태는 `completed`, `failed`, `cancelled`입니다.
- 실패하거나 취소된 뒤에도 원본 규칙 초안이 `draft` 상태이면 사람이 다시 요청할 수 있습니다(`canRequestAgain`).

### 6.4 실행 흐름 (긴 트랜잭션 없음)

| 단계 | 트랜잭션 | 내용 |
|---|---|---|
| enqueue | 요청 트랜잭션(`route()` 안) | 초안 `FOR UPDATE` → 권한 확인 → 같은 키나 활성 작업이 있으면 그것을 반환 → INSERT → 감사 기록 |
| claim | 짧은 `withTenant` | 시도 소진+임대 만료 작업은 `failed`로 바꿈. 이어서 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` |
| run 1 | 짧은 `withTenant` | 임대 확인(소유자 + 시도 번호, 아니면 `stale` 기록, **AI 호출 안 함**) → 기한, 기관 스위치, 그룹 승인 여부, 요청자 쓰기 권한 확인 → 요청자 권한으로 FactBook 재구성 → 데이터 등급 판정 |
| run 2 | **트랜잭션 없음** | `composeDraft` + job timeout(`Promise.race`, 기본 300초) |
| run 3 | 짧은 `withTenant` | 작업 `FOR UPDATE`. 여전히 `processing`이고 내 임대이며 원본이 미검토 규칙 초안이어야 저장. 아니면 `stale`로 기록하고 결과를 버림 |

- 테스트는 모의 Provider 안에서 DB 쿼리를 실행해, 호출 중에 트랜잭션이 열려 있지 않음을 확인합니다. PGlite는 열린 트랜잭션이 있으면 다른 쿼리를 막기 때문에 이 확인이 유효합니다.
- 결과 저장 방식:
  - 원본 규칙 초안은 **수정하지 않습니다**.
  - AI 제안본은 **새 `ai_drafts` 행**(`status='draft'`, `engine='hybrid'|'ai-intelligence'`, `source_job_id`)으로 저장하고, 출처 참조도 함께 저장합니다.
  - `created_by`는 요청한 사람입니다.
  - 승인은 기존 승인·폐기 API와 그 권한 검사를 그대로 거칩니다. **자동 승인은 없습니다.**

### 6.5 재시도·타임아웃·서킷 브레이커

| 계층 | 정책 |
|---|---|
| HTTP 클라이언트(`AIIntelligenceProvider`) | 요청 타임아웃 기본 20초(재시도 안 함). 네트워크 오류와 503은 요청 안에서 1회 재시도. 4xx는 재시도 안 함 |
| 작업 큐 | 다시 예약하는 오류는 **`network`, `unavailable`(재시도 후에도 503)뿐**입니다. 백오프는 30초·60초·120초…, 최대 10분입니다. 그 외(`timeout`, `server_error`(500 등), 4xx, `invalid_response`, 근거 검증 실패, `circuit_open`)는 바로 `failed`가 됩니다 |
| job timeout | `runJob`의 `jobTimeoutMs`(기본 300초)를 넘으면 `job_timeout`으로 실패합니다. 늦게 도착한 응답은 무시합니다 |
| 임대 | `leaseSeconds`(기본 600초)가 지나면 다른 워커가 이어받습니다. 마지막 시도에서 만료되면 `lease_expired`로 실패합니다 |
| 서킷 브레이커 | 연속 3회 실패하면 30초간 호출을 차단합니다. half-open에서는 시험 호출 1회만 허용하고, 그 호출이 어떻게 끝나든(4xx는 "도달 가능"으로 닫음, 추적 ID 불일치는 실패) 시험 슬롯을 반환합니다. Provider 응답에 들어 있는 내부 코드(`circuit_open` 등)는 신뢰하지 않고 `provider_error`로 저장합니다. 차단 중인 작업은 실패시키지 않고 **연기**합니다(시도 환불, 최대 24시간). AI 서비스 장애는 모든 기관에 같으므로 Provider 인스턴스 단위로 공유하며, **프로세스 메모리 상태**라서 워커 인스턴스마다 따로 동작합니다 |

### 6.6 폴백

AI 경로가 실패해도 규칙 초안은 늘 그대로 있고 승인할 수 있습니다. 실패 사유는 `ai_jobs.error_code`에 남습니다. 대표 코드는 다음과 같습니다.

- `ai_disabled`, `no_tenant_token`, `no_sendable_facts`
- `all_ai_sentences_rejected`, `final_verification_failed`
- `job_timeout`, `draft_not_reviewable`

### 6.7 감사

| action | actor | meta |
|---|---|---|
| `ai.job.enqueue` | 요청자 | `draft`, `kind` |
| `ai.job.retry` | 시스템(null) | `code`, `attempt` |
| `ai.job.complete` | 시스템 | `draft`(결과), `engine`, `rejected`(개수) |
| `ai.job.fail` | 시스템 | `code`, `attempt`, `exhausted` |
| `ai.job.cancel` | 취소자 | `from` |
| `ai.job.stale` | 시스템 | `status`, `phase`(`before_call`/`after_call`) |
| `ai.job.defer` | 시스템 | `code`(`circuit_open`) |
| `ai.job.release` | 시스템 | `reason`(`worker_shutdown`) |
| `ai.select` | 선택자 | `group`, `engine`, `previous` |
| `ai.hold` | 보류자 | `group`, `previous` |
| `ai.approve` / `ai.discard` | 승인·폐기자 | 기존 항목 + `group` |

모든 행에는 `entity_type='ai_job'`, 작업 id, 시간이 기록됩니다. meta에는 본문, 사실 텍스트, 토큰을 넣지 않습니다.

## 7. 테넌트 격리

- 모든 쿼리는 `withTenant`(`app.tenant_id` + `SET LOCAL ROLE neulgyeot_app`) 안에서 RLS를 적용받습니다.
- `claimJobs`는 한 번에 한 테넌트만 처리합니다.
- 다른 기관 사용자의 조회와 취소는 404입니다.
- 다른 테넌트 컨텍스트에서 SELECT/UPDATE하면 0행입니다. 교차 테넌트 INSERT는 RLS가 거부합니다.
- Provider 토큰은 테넌트별입니다. 토큰이 없는 테넌트는 다른 기관의 토큰을 빌리지 않습니다.

## 8. 초안 검토 Workflow (구현)

### 8.1 개념

| 개념 | 저장 위치(중복 컬럼 없음) |
|---|---|
| 초안 그룹 | `ai_drafts.draft_group_id`. 규칙 초안 id가 그룹 id이고, AI 초안은 원본 규칙 초안의 그룹에 들어갑니다 |
| 생성 방식(source_type) | 기존 `engine`(`rules` = rule_based, `ai-intelligence`/`hybrid` = ai) |
| 선택 | `selection_status`(`candidate`/`selected`/`set_aside`), `selected_by`, `selected_at` |
| 폐기 | 기존 `status = 'discarded'` + `reviewed_by/at` |
| 승인 | 기존 `status = 'approved'` + `reviewed_by/at` |

### 8.2 흐름

1. 담당자가 규칙 초안을 생성합니다(기존 기능).
2. 기관 스위치가 켜져 있으면 **AI 초안 요청**을 할 수 있습니다(`Idempotency-Key` 필수).
3. 워커가 비동기로 처리해 AI 초안을 같은 그룹에 `draft`로 저장합니다.
4. 비교 화면에서 두 초안을 나란히 보고, 문장별 근거를 확인합니다.
5. 다음 중 하나를 고릅니다.
   - **규칙 초안 선택**, 또는 **AI 초안 선택**: 선택하지 않은 초안은 보관(`set_aside`)됩니다.
   - **AI 초안 폐기**
   - **보류**: 모든 초안을 후보로 되돌립니다.
6. **선택은 승인이 아닙니다.** 선택된 초안만 기존 승인 화면에서 확인 체크 후 승인할 수 있습니다.
   - 사례 초안은 승인할 때만 `case_records`(공식 기록)에 저장됩니다.
7. AI 작업이 실패해도 규칙 초안은 그대로 있고, 혼자 남은 초안은 기존처럼 바로 승인할 수 있습니다.

### 8.3 무결성

- 그룹당 선택은 1개, 승인도 1개입니다(부분 유니크 인덱스).
- 승인된 초안은 반드시 선택된 상태입니다. 폐기된 초안은 선택된 상태일 수 없습니다(CHECK).
- 승인된 그룹에서는 선택, 보류, 다른 초안 승인, 새 AI 요청을 모두 거부합니다(409).
- 승인·폐기·선택·보류는 그룹의 모든 행을 id 순서로 `FOR UPDATE` 잠급니다. 동시에 요청해도 일관된 결과가 나오고 교착이 없습니다.
- 다른 기관은 404, 지역 밖도 404입니다. 지역 안이지만 읽기만 가능한 사용자는 비교 화면은 볼 수 있고(`canReview: false`) 선택은 403입니다.

### 8.4 API (모두 `route()`: CSRF, 세션, 테넌트 트랜잭션, 거부 감사)

| 메서드 | 경로 | 권한 |
|---|---|---|
| GET | `/api/ai/drafts/{id}/compare` | 대상 읽기 |
| POST | `/api/ai/drafts/{id}/select` `{action: select \| hold}` | 대상 쓰기 |
| POST | `/api/ai/drafts/{id}/review` `{action: approve \| discard}`(기존) | 대상 쓰기 |
| POST | `/api/ai/drafts/{id}/ai-jobs` (헤더 `Idempotency-Key`) | 대상 쓰기 + 기관 스위치 |
| GET | `/api/ai/jobs/{jobId}` | 대상 읽기 |
| POST | `/api/ai/jobs/{jobId}/cancel` | 대상 쓰기 |
| GET | `/api/admin/ai-metrics?days=N` | 기관 관리자 |

작업 상태 응답은 다음과 같습니다(본문과 사실 없음).

`{ id, status, engine, attempts, maxAttempts, retryable, canRequestAgain, error{code,message}, modelVersion, promptVersion, sourceDraftId, resultDraftId, resultReviewStatus, requestedAt, startedAt, completedAt, failedAt, cancelledAt, nextAttemptAt }`

### 8.5 UI (`components/client/AiDraftPanel.tsx`, 기존 디자인 클래스 사용)

- **작업 상태 줄:** 대기, 처리 중, 완료, 실패, 취소를 표시합니다. 요청 시각, 시도 수, 생성 방식, 안전 오류 문구, 자동 재시도 예정, 다시 요청, 요청 취소도 보여 줍니다. 진행 중에는 15초마다 새로고침합니다.
- **비교:** 왼쪽은 규칙 초안, 오른쪽은 AI 초안입니다.
  - 섹션별로 문장 표시를 붙입니다(동일 / AI에만 있음 / 규칙에만 있음).
  - AI 섹션이 비어 규칙 문장을 유지했으면 "규칙 문장 유지"로 표시합니다.
  - 생성 시각, 모델, 프롬프트 버전을 보여 줍니다.
- **근거:** 문장의 근거 버튼을 누르면 사실 ID, 내용, 출처(`source_type:id·field`), 수집 시각이 펼쳐집니다. 근거 검증은 서버가 AI 초안을 저장할 때 이미 했습니다. UI는 이를 대신하지 않습니다.
- **선택:** 규칙 초안 선택, AI 초안 선택, AI 초안 폐기, 보류(나중에 비교) 버튼이 있습니다.
- **승인:** 선택된 초안의 수정본을 보여 줍니다. "근거와 내용을 확인했습니다" 체크 전에는 승인 버튼이 비활성입니다. 승인 뒤에는 승인자, 시각, 초안 종류를 표시합니다.
- 브라우저 확인: 1440px·390px에서 가로 넘침 0, axe serious/critical 0(로컬 PostgreSQL + 모의 Provider).

## 9. 운영 연결 전에 남은 작업

`docs/AI_PRODUCTION_READINESS.md`를 참고하세요. 워커 실행 방식 비교와 권고, 기관 설정, 토큰, 모니터링, 보존, v1.1 계약 검증 결과, 체크리스트가 있습니다.

## 10. 남은 위험

- **의미 왜곡:** 근거 id는 맞지만 내용이 다른 문장은 자동으로 막을 수 없습니다. 사람 승인이 최종 통제입니다. 비교 화면과 확인 체크가 이를 돕습니다.
- **AI 초안 FactBook:** 실행 시점에 다시 만들기 때문에, 그 사이 기록이 바뀌면 규칙 초안과 사실 번호가 다를 수 있습니다. 각 문장의 근거는 그 초안의 사실 목록을 기준으로 표시합니다.
- **자체 리뷰 2차 반영:**
  - half-open 시험 호출이 멈추는 문제, Provider가 보낸 내부 코드로 시도가 환불되는 문제를 고쳤습니다.
  - 006 backfill에서 이중 승인 그룹을 분리합니다.
  - 사례와 연결된 연계의 대상자가 실데이터이면 차단합니다.
  - 페이지 그룹 목록에서 대상이 맞지 않는 legacy 행을 제외합니다.
  - 잠금 후 그룹을 다시 조회합니다.
  - 종료할 때 선점한 배치 전체를 반환합니다.
  - 선점마다 임의 임대 토큰(`lease_owner = 워커ID:토큰`)을 씁니다.
  - 각 항목은 `tests/api/ai-review-hardening.test.ts`로 확인합니다.
- **`ai_drafts_one_target`:** 기존 운영 데이터를 깨지 않으려고 `NOT VALID`로 추가했습니다. 운영 적용 전에 데이터를 점검하고 `VALIDATE`해야 합니다.
- **서킷 브레이커와 요율 제한:** 프로세스 단위입니다. 워커가 여러 대이면 대수만큼 시험 호출이 생깁니다.
- **LLM `status: ok` 경로:** 실제 모델로 다시 검증해야 합니다(이번에는 스텁과 모의 Provider만 사용).
