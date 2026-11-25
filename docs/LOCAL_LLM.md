# 로컬 LLM 연동 (지자체용)

기관 안에서 돌아가는 LLM으로 AI 초안 3종(연계 요약 `referral_summary`, 사회복지 소견 `social_opinion`, 사례회의 브리프 `meeting_brief`)을 다듬습니다.
외부 클라우드 LLM으로 보내는 경로는 없습니다.

## 1. 동작 방식

```
규칙 초안 + FactBook ──► 허용 목록(fact-policy) ──► 로컬 LLM ──► 문장별 재검증 ──► AI 초안(검토 대기)
        ▲                                                  │실패·연결 없음
        └──────────────── 규칙 초안 그대로 ◄────────────────┘
```

- **API 형식:** OpenAI 호환 `/v1/chat/completions`, `response_format: json_object`. Ollama, vLLM, LM Studio, llama.cpp server 모두 같은 설정으로 붙습니다.
- **보내는 것:** `selectSendableFacts()`가 고른 사실만 보냅니다. 사회복지사 소견, 식별 정보, 자유 서술은 보내지 않습니다.
- **받은 문장 검증:** `composeDraft()`가 문장마다 확인합니다.
  - 인용한 사실 ID가 실제로 보낸 것인지
  - 사실에 없는 숫자·날짜를 만들지 않았는지
  - 금지 표현(자격 판정, 긴급도, 위험 등급, 진단)이 없는지
  - 통과하지 못한 문장은 버리고, 그 섹션은 규칙 문장으로 채웁니다(`hybrid`).
- **데이터 등급:** 합성 데이터(`is_synthetic`)일 때만 호출합니다. 실데이터는 네트워크 호출 전에 차단됩니다(`real_data_blocked`).
- **사람의 승인:** 결과는 항상 `draft` 상태의 새 초안입니다. 비교 화면에서 담당자가 선택·승인해야 쓰입니다.
- **켜는 조건:** 기관 AI 스위치(`ai_enabled`, 관리자 설정)가 켜져 있어야 하고, 워커가 실행 중이어야 합니다.
- **장애 처리:** 타임아웃, 네트워크 오류·503 1회 재시도, 서킷 브레이커가 있습니다. 모델이 없거나(404) JSON이 깨지면 규칙 초안으로 돌아갑니다.

## 2. 데모: Mac + Ollama

```bash
brew install ollama        # 또는 https://ollama.com 에서 설치
ollama serve &
ollama pull qwen2.5:7b     # 메모리 8GB 이하 장비는 qwen2.5:3b 또는 1.5b

DEMO_MODE=true AI_INPROCESS_WORKER=true \
AI_PROVIDER=local_llm LOCAL_LLM_MODEL=qwen2.5:7b \
npm run build && npm start
```

1. 관리자(DEMO)로 로그인 → 설정 → **AI 사용** 켜기
2. 연계·사례 화면에서 규칙 초안 생성 → **AI 초안 요청**
3. 작업이 끝나면 비교 화면에서 규칙 초안과 AI 초안을 나란히 보고 선택·승인

`AI_INPROCESS_WORKER`는 단일 장비 데모용입니다. Vercel에서는 거부되며, 운영 환경에서는 `DEMO_MODE=true`일 때만 허용됩니다.

## 3. 운영: 기관 추론 서버로 교체

코드 수정 없이 주소만 바꿉니다.

```bash
AI_PROVIDER=local_llm
LOCAL_LLM_BASE_URL=https://llm.intra.example.go.kr   # vLLM 등 (http는 localhost·사설망 IP만 허용)
LOCAL_LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
LOCAL_LLM_API_KEY=...                               # 서버가 요구할 때만. 커밋 금지
npx tsx scripts/ai-worker.mts                         # 공유 PostgreSQL 옆에서 별도 프로세스로 실행
```

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AI_PROVIDER` | (비움 = 규칙만) | `local_llm` |
| `LOCAL_LLM_BASE_URL` | `http://127.0.0.1:11434` | `/v1`은 자동으로 붙습니다 |
| `LOCAL_LLM_MODEL` | — | 없으면 꺼짐 |
| `LOCAL_LLM_API_KEY` | — | Bearer 키 |
| `LOCAL_LLM_TIMEOUT_MS` | 120000 | 1000–600000 |
| `LOCAL_LLM_MAX_TOKENS` | 1500 | |

## 4. 모델 선택

| 모델 | 라이선스 | 메모 |
|---|---|---|
| Qwen2.5 7B/14B Instruct | Apache-2.0 | 권장 기본값. 한국어 JSON 출력이 안정적 |
| Qwen2.5 1.5B/3B | Apache-2.0 | 저사양 데모용. 문장이 단순해지고 재검증에서 버려지는 문장이 늘어납니다 |
| EXAONE 3.5 | **비상업 라이선스** | 기관 도입 전 라이선스 검토 필요 |

모델·라이선스 선택은 기관 검토 사항이며, 여기 표는 참고용입니다.

## 5. 확인 결과 (2026-11-25, 개발 환경)

- 단위 테스트: 설정·URL 정책, 프롬프트에 금지 사실이 없는지, 출력 파싱, 지어낸 숫자·보내지 않은 ID 거부, 폴백 4종, 헬스 체크.
- 실제 모델: Ollama 0.40 + `qwen2.5:1.5b`(CPU). `LOCAL_LLM_TEST_MODEL=qwen2.5:1.5b npm test` 3회 모두 `hybrid`.
- 앱 E2E: DEMO 관리자 로그인 → AI 스위치 켜기 → 연계 요약 규칙 초안 → AI 작업 요청 → 인프로세스 워커 처리(약 40초) → `hybrid` 초안(`local:qwen2.5:1.5b`, 검토 대기) 생성.
- 확인하지 않은 것: 7B 이상 모델의 품질·속도(이 개발 환경의 메모리 한도로 실행 불가), vLLM 서버, 운영 PostgreSQL에서의 별도 워커.
- 빌드: 이 개발 환경의 `next build`가 Next.js 16.4.4의 보안 공지(moderate)를 이유로 빌드를 거부해, 16.4.6으로 임시 설치해 빌드를 확인했습니다. 이 PR은 Next 버전을 바꾸지 않습니다(별도 업그레이드 권장).
