# AI Intelligence Provider 연동 (진행 상태)

- 브랜치: `feat/ai-intelligence-provider-integration`
- 설계 원문: `KREWX/02_Platform/Neulgyeot-AI-Integration-Design/`(GOV_GAP_ANALYSIS, PROVIDER_INTERFACE, API_CONTRACT v1.1, SECURITY_MODEL)

## 1. 현재 상태 요약

| 항목 | 상태 |
|---|---|
| 실제 AI Intelligence 연결 | **없음.** 서버 URL·토큰·네트워크 경로 없음. 운영 환경변수 변경 없음 |
| 외부 LLM 호출 | **비활성.** `llmAvailable()` = false, 외부 API 호출 코드 제거 |
| `/api/ai/drafts` | 규칙 엔진만 사용(동작 변경 없음) |
| Provider 어댑터(`lib/server/ai/provider.ts`) | 구현, 모의 AI 서비스로 테스트. **어떤 라우트에도 연결하지 않음** |
| 비동기 작업 큐(`ai_jobs`, `lib/server/ai/jobs.ts`) | 마이그레이션 `005_ai_jobs` + 서비스 + 테스트. **라우트·워커·스케줄러에 연결하지 않음. 운영 DB에 적용하지 않음** |
| UI | 변경 없음. 아래 §8은 향후 계약 문서일 뿐 |

## 2. 구성

| 파일 | 역할 |
|---|---|
| `lib/server/ai/contract.ts` | API 계약 v1.1 요청·응답 Zod 스키마. 응답이 스키마와 다르거나 `requires_human_review !== true`이거나 예측 `use !== "research_only"`이면 결과 없음으로 처리 |
| `lib/server/ai/fact-policy.ts` | 기본 거부 허용 목록 + `NEVER_SEND` 목록. 결과 타입은 브랜드 타입 `ProviderRecord`(이 함수만 만들 수 있음) |
| `lib/server/ai/provider.ts` | `AIProvider` 인터페이스, `AIIntelligenceProvider`(테넌트별 토큰, `X-Tenant-Id`, `X-Request-Id`, 타임아웃, 재시도, 서킷 브레이커), `composeDraft`(재검증·섹션별 병합·폴백), `providerFromEnv`(기본 꺼짐) |
| `lib/server/ai/jobs.ts` | 비동기 작업: 생성·선점·실행·취소·상태 조회 |
| `lib/server/services/ai.ts` | `buildDraft()`(권한 확인 + 사실 + 규칙 초안, 네트워크 없음), `generateDraft()`(규칙만), `assertDraftReview()`(승인·폐기·AI 요청 권한) |
| `lib/server/db/migrations/005_ai_jobs.ts` | `ai_jobs` 테이블·RLS, `ai_drafts.engine` 확장, `ai_drafts.source_job_id` |

## 3. 개인정보 필터링

- **기본 거부.** 허용 목록에 있는 시스템 생성 값과, 통제 어휘에 정확히 일치하는 값만 보냅니다.
- 자유 서술은 보내지 않습니다. 대상은 평가 항목 메모, 주거환경, 누락 항목, 사회복지사 소견입니다.
- 식별자 패턴(전화번호, 주민번호 형태 등)이 보이면 허용 목록에 있어도 제외합니다.
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

검토(`reviewDraft`)와 AI 작업 요청·취소는 같은 규칙(`DRAFT_REVIEW_RULES`)을 씁니다.

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
- **현재 범위:** 테이블, 서비스 함수, 테스트까지만 있습니다.
  - 이를 호출하는 API 라우트, 워커 프로세스, 스케줄러(cron)는 없습니다.
  - 따라서 운영에서 작업이 생성되거나 실행되는 일은 없습니다.

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
```

- 종료 상태는 `completed`, `failed`, `cancelled`입니다.
- 실패하거나 취소된 뒤에도 원본 규칙 초안이 `draft` 상태이면 사람이 다시 요청할 수 있습니다(`canRequestAgain`).

### 6.4 실행 흐름 (긴 트랜잭션 없음)

| 단계 | 트랜잭션 | 내용 |
|---|---|---|
| enqueue | 요청 트랜잭션(`route()` 안) | 초안 `FOR UPDATE` → 권한 확인 → 같은 키나 활성 작업이 있으면 그것을 반환 → INSERT → 감사 기록 |
| claim | 짧은 `withTenant` | 시도 소진+임대 만료 작업은 `failed`로 바꿈. 이어서 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` |
| run 1 | 짧은 `withTenant` | 임대 소유 확인(아니면 `stale` 기록, **AI 호출 안 함**) → 저장된 사실과 규칙 섹션 읽기 |
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
| 서킷 브레이커 | 연속 3회 실패하면 30초간 호출을 차단합니다(`circuit_open`). **프로세스 메모리 상태**라서 워커 인스턴스마다 따로 동작합니다 |

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

모든 행에는 `entity_type='ai_job'`, 작업 id, 시간이 기록됩니다. meta에는 본문, 사실 텍스트, 토큰을 넣지 않습니다.

## 7. 테넌트 격리

- 모든 쿼리는 `withTenant`(`app.tenant_id` + `SET LOCAL ROLE neulgyeot_app`) 안에서 RLS를 적용받습니다.
- `claimJobs`는 한 번에 한 테넌트만 처리합니다.
- 다른 기관 사용자의 조회와 취소는 404입니다.
- 다른 테넌트 컨텍스트에서 SELECT/UPDATE하면 0행입니다. 교차 테넌트 INSERT는 RLS가 거부합니다.
- Provider 토큰은 테넌트별입니다. 토큰이 없는 테넌트는 다른 기관의 토큰을 빌리지 않습니다.

## 8. 향후 UI·API 계약 (미구현, 활성화하지 않음)

다음은 예정된 엔드포인트입니다. 모두 `route()`를 거치며, CSRF·세션·테넌트 검사는 기존과 같습니다.

| 메서드 | 경로 | 서비스 | 권한 |
|---|---|---|---|
| POST | `/api/ai/drafts/{id}/ai-jobs` (헤더 `Idempotency-Key`) | `enqueueDraftJob` | 초안 쓰기 |
| GET | `/api/ai/jobs/{jobId}` | `getJobStatus` | 초안 조회 |
| POST | `/api/ai/jobs/{jobId}/cancel` | `cancelJob` | 초안 쓰기 |

`getJobStatus`가 돌려주는 값은 다음과 같습니다. 본문과 사실은 포함하지 않습니다.

```ts
{
  id, status,                       // pending | processing | completed | failed | cancelled
  engine,                           // null | "hybrid" | "ai-intelligence"
  attempts, maxAttempts,
  retryable,                        // 큐가 스스로 다시 시도할 예정인지
  canRequestAgain,                  // 실패·취소 후 사람이 다시 요청할 수 있는지
  error: { code, message } | null,  // 고정된 안전 문구
  modelVersion, promptVersion,
  sourceDraftId,                    // 규칙 초안
  resultDraftId,                    // AI 제안 초안 (출처는 기존 초안 조회 API의 sources로)
  resultReviewStatus,               // null | draft | approved | discarded  (사람 승인 상태)
  createdAt, startedAt, completedAt, failedAt, cancelledAt,
}
```

UI 원칙은 다음과 같습니다.

- 규칙 초안을 먼저 보여 줍니다.
- AI 제안본은 "AI 제안 · 검토 필요"로 구분해 표시합니다.
- 섹션별 엔진(`content.ai.sectionEngines`)을 표시합니다.
- 실패하면 `error.message`를 보여 주고 규칙 초안을 그대로 둡니다.

## 9. 운영 연결 전에 남은 작업 (승인 필요)

| # | 작업 | 비고 |
|---|---|---|
| 1 | 워커 실행 방식 결정 | Vercel cron + `runWorkerOnce` 또는 별도 상시 워커. 서버리스 실행 시간 한도와 job timeout·임대 시간 정합 |
| 2 | 테넌트 열거 방식 | 워커가 처리할 테넌트 목록. 소유자 연결로 id만 조회하거나, 테넌트별 설정에서 가져옴 |
| 3 | `tenant_settings.ai_provider`(기본 `rules`) | 기관별 단계적 활성화 |
| 4 | 비밀·네트워크 | 테넌트별 토큰 저장(KMS/환경변수), AI 서버 URL, 서버리스에서 내부망으로 가는 경로 |
| 5 | 위 §8 API·UI 구현 | 별도 리뷰 |
| 6 | 운영 DB에 `005_ai_jobs` 적용 | 스테이징 먼저. 롤백 조건(§6.2) 확인 |
| 7 | 오래된 작업 정리 정책 | 앱 역할에 DELETE가 없으므로 보존 기간과 아카이브를 운영 작업으로 정의 |
| 8 | 분산 서킷 브레이커·요율 제한 | 현재는 프로세스 단위 |
| 9 | 관리자 화면 문구 | "외부 LLM 사용 허용(AI_FEATURE_ENABLED 필요)"은 실제 동작과 다름 |
| 10 | 개인정보 영향평가, 위탁·국외 이전 검토 | 자유 서술 전송은 계속 금지 |

## 10. 남은 위험

- **의미 왜곡:** 근거 id는 맞지만 내용이 다른 문장은 자동으로 막을 수 없습니다. 사람 승인이 최종 통제입니다.
- **규칙 초안과 AI 초안이 둘 다 `draft`로 공존:** 한쪽을 승인해도 다른 쪽은 자동으로 폐기되지 않습니다. 검토자가 하나를 고르고 나머지를 폐기하는 UI가 필요합니다.
- **`source_job_id`:** 복합 FK가 없는 참조 컬럼입니다. 무결성은 `ai_jobs.result_draft_id`(복합 FK)로 보장합니다.
- **`enqueue`의 쓰기 권한 기준:** "승인 권한"과 같은 기준을 씁니다. 별도의 "AI 사용 허용" 권한은 만들지 않았습니다. 필요하면 정책 결정이 있어야 합니다.
