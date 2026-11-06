# AI Intelligence Provider 연동 (진행 상태)

- 브랜치: `feat/ai-intelligence-provider-integration`
- 설계 원문: `KREWX/02_Platform/Neulgyeot-AI-Integration-Design/`(GOV_GAP_ANALYSIS, PROVIDER_INTERFACE, API_CONTRACT v1.1, SECURITY_MODEL)

## 현재 상태

| 항목 | 상태 |
|---|---|
| 외부 LLM 호출 | **비활성.** `llmAvailable()` = false, 외부 API 호출 코드 제거 |
| `/api/ai/drafts` | 규칙 엔진만 사용(동작 변경 없음) |
| Provider 어댑터(`lib/server/ai/*`) | 구현, 단위·통합 테스트(모의 AI 서비스). **어떤 라우트에도 연결하지 않음** |
| 실제 AI Intelligence 서버·토큰·URL | 없음(운영 환경 변경 없음) |

## 구성

| 파일 | 역할 |
|---|---|
| `lib/server/ai/contract.ts` | API 계약 v1.1 요청·응답 Zod 스키마. 응답이 스키마와 다르거나 `requires_human_review !== true`이거나 예측 `use !== "research_only"`이면 결과 없음으로 처리 |
| `lib/server/ai/fact-policy.ts` | 기본 거부 허용 목록: 시스템 생성 값 + 통제 어휘와 정확히 일치하는 값만 전송. 자유 서술 제외. 식별자 패턴 차단 |
| `lib/server/ai/provider.ts` | `AIProvider` 인터페이스, `AIIntelligenceProvider`(테넌트별 토큰, `X-Tenant-Id`, `X-Request-Id`, 타임아웃, 재시도 정책, 서킷 브레이커), `composeDraft`(재검증·섹션별 병합·폴백), `providerFromEnv`(기본 꺼짐) |
| `lib/server/services/ai.ts` | `buildDraft()` 분리(권한 확인 + 사실 + 규칙 초안, 네트워크 없음). `generateDraft()`는 이를 써서 기존과 같게 동작 |

## 안전 규칙 (구현됨, 테스트로 확인)

- 테넌트별 토큰. 토큰이 없는 테넌트는 다른 기관 토큰을 빌리지 않고 규칙 초안을 사용합니다. 테넌트 일치 여부는 AI 서비스가 토큰으로 검증합니다(헤더만 믿지 않음).
- 전송하는 사실은 허용 목록에 있는 것뿐입니다. AI가 인용한 근거는 **이번 요청에 포함된 사실**이어야 합니다.
- 문장 검증: `verifyDraft`(금지 표현, F번호 존재) + 수치 근거 + 한국어. 섹션 제목은 규칙 초안에서만 가져오고, AI 섹션이 비면 규칙 문장을 유지합니다.
- 장애 처리:
  - 타임아웃은 재시도하지 않습니다.
  - 네트워크 오류와 503은 1회 재시도합니다.
  - 4xx는 재시도하지 않습니다.
  - 연속 3회 실패하면 30초간 차단합니다.
  - 어떤 경우에도 규칙 초안이 남습니다.
- 응답 추적 ID가 요청과 다르면 결과를 거부합니다.

## 연결 전에 필요한 결정과 변경 (승인 필요)

| # | 변경 | 이유 | 위험 |
|---|---|---|---|
| 1 | **AI 호출을 DB 트랜잭션 밖으로 분리.** `route()`가 핸들러 전체를 `withTenant` 트랜잭션으로 감싸므로, 비동기 작업(`ai_jobs`)을 쓰거나 이 엔드포인트만 단계형 트랜잭션(사실 수집 tx → 호출 → 저장 tx)을 쓰도록 `http.ts`에 별도 래퍼 추가 | 로컬 모델 실측 75–174초(CPU). 트랜잭션 점유 | 중간: 핵심 HTTP 래퍼 |
| 2 | 마이그레이션: `ai_drafts.engine`에 `ai-intelligence`·`hybrid` 추가, `ai_request_id`, `model`, `prompt_version`, `section_engines`, `fallback_reason` 컬럼 | 모델·프롬프트 버전과 실패 사유 기록 | 중간: 스키마 변경 |
| 3 | 기관 설정: `tenant_settings.ai_provider`(기본 `rules`) | 기관별 단계적 활성화 | 낮음 |
| 4 | 비밀 저장: 테넌트별 토큰(Vercel 환경변수 또는 KMS), AI 서버 URL과 네트워크 경로(서버리스 → 내부망) | 운영 연결 | 운영 환경 변경 |
| 5 | UI(`AiDraftPanel`): 섹션별 출처(AI/규칙), 폴백 사유, "AI 초안 생성 중" 상태 | 검토자가 AI 문장을 구분해야 함 | 낮음 |
| 6 | 관리자 화면 문구: "외부 LLM 사용 허용(AI_FEATURE_ENABLED 필요)"은 이제 실제 동작과 맞지 않음 | 오해 방지 | 낮음 |

## 남은 보안 검토

- 의미 왜곡(근거 id는 맞지만 내용이 다른 문장)은 자동으로 막을 수 없습니다. 사람 승인이 최종 통제입니다.
- 자유 서술 전송은 기본 금지입니다. 허용하려면 NER 기반 비식별화, 개인정보 영향평가, 위탁·국외 이전 검토가 먼저 필요합니다.
- 연계 초안 승인·폐기(`reviewDraft`)는 연계 **조회 권한**(`getReferral`)만 확인합니다. 사례 초안은 쓰기 권한(`assertCaseWrite`)을 확인합니다. 연계 초안 승인에 담당 배정 등을 요구할지 정책 결정이 필요합니다.
