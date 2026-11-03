# 병원 ↔ 지자체 연계 (DEMO 계약 v1.0)

> 이 계약은 데모용입니다. 공공기관·지자체의 공식 연계 표준이 아니며, 실제 연계는 기관별 협약·승인 규격·보안성 검토 후 구현합니다. OAuth 2.0 / TLS 1.3 등은 **고려 사항**이며 확정 규격이 아닙니다.

## 원칙
- 두 제품은 별도 배포·별도 DB. 상대 DB 직접 접속 없음.
- 지자체는 병원 진료기록 복제 저장소가 아님 — 최소 필요 정보만 수신.
- 병원 계약 원본: `yeobbro/Neulgyeot` `lib/integrations/municipal-referral/{types,validation,mock-adapter}.ts` (`ReferralEnvelope`, schemaVersion `1.0`). 지자체 수신 DTO: `lib/integrations/hospital/schema.ts`(Zod, `.strict()` — 알 수 없는 필드·연락처 거부).

## 엔드포인트
| | 인증 scope | 설명 |
|---|---|---|
| `POST /api/integrations/hospital/referrals` | referrals:write | 신규 연계. `Idempotency-Key` 필수, `X-Trace-Id` 선택 |
| `GET /api/integrations/hospital/referrals/{transferId}` | referrals:read | 제한된 상태(상태, 보완 요청 항목, 반려 사유, traceId) — 내부 사례 정보 미반환 |
| `POST /api/integrations/hospital/referrals/{transferId}/resubmissions` | referrals:write | 보완 제출(NEEDS_INFORMATION/VALIDATION_FAILED 상태에서만) |
| `POST /api/integrations/hospital/callbacks/status` | callbacks:write | 병원 측 이벤트: 퇴원일 변경, 연계 철회, 퇴원 완료 |

인증(MVP): `Authorization: Bearer <client key>` — `integration_clients.key_hash`(SHA-256) 조회, 송신기관 코드·수신 지자체 코드 일치 검사. 데모 키는 비밀이 아닌 공개 데모 값이며 운영 사용 금지.

## 수신 처리 순서
1. 클라이언트 인증·scope → 2. Idempotency(같은 키·같은 본문 → 저장 응답 재생 / 다른 본문 → 409) → 3. Zod 검증(400 `VALIDATION_FAILED`) → 4. 목적지·송신기관 일치(422) → 5. transferId 중복(409 `DUPLICATE_TRANSFER`, 사례 중복 생성 없음) → 6. **카테고리별 동의 판정**(아래) → 7. 최소화 저장(payload version, consent_evidence) → 8. 담당 업무 생성·감사 이벤트.

## 카테고리별 판정 (`consent-scope.ts`)
| 조건 | 결과 |
|---|---|
| payload에 있으나 동의 scope에 없는 항목 | **전체 거부 422** `CONSENT_SCOPE_VIOLATION`, 저장 안 함 |
| 건강 관련 항목 + 민감정보 별도 동의 없음 | 전체 거부 422 |
| 지자체 수신 정책(`intake_allowed_categories`) 밖 (기본: 주진단·투약 요약) | `blocked_by_policy` — 저장하지 않음 |
| 민감 항목 + 법적 근거 기재 없음 | `pending_review` — 저장하되 열람·AI 활용 차단, 관리자 확인 전 사례 접수 불가 |
| 그 외 | `accepted` |

## 상태
연계 상태(`incoming_referrals.status`)와 사례 상태(`care_cases.status`)는 별도. 병원 방향 상태 통지는 `integration_messages`(outbound, `queued`)에 기록만 하는 **mock adapter** — 네트워크 전송 없음.

## 실제 연계 시 필요(미구현)
기관 인증(OAuth 2.0 client credentials/mTLS/요청 서명 중 협약 방식), 키 회전, bounded retry·timeout, dead-letter 처리, status webhook 서명, 오류 분류 합의, 스키마 버전 협상, 보안성 검토.
