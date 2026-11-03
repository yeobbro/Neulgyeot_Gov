# API

모든 업무 API는 세션 쿠키(`ngm_session`, HTTP-only, SameSite=Lax, Secure in prod) 필요. 변경 요청(POST/PUT/PATCH/DELETE)은 `x-ngm-csrf: 1` 헤더 필수, `Origin`이 다르면 거부. 범위 밖 리소스는 **404**, 권한 부족은 **403**, 상태 전이 불가 **409** (`invalid_transition`), 검증 **400**.

## 인증
| | |
|---|---|
| `POST /api/auth/login` | `{email,password}` (scrypt) · rate limit 10/min |
| `POST /api/auth/demo-login` | `{userId}` · 개발/`DEMO_MODE`만 |
| `POST /api/auth/logout`, `GET /api/auth/me` | |
| `GET /api/health` | 상태·저장소 종류(비밀 없음) |

## 업무 (관리자·담당자)
| 메서드·경로 | 설명 |
|---|---|
| `GET /api/dashboard` | 지표·권역 비교 |
| `GET /api/referrals` · `GET /api/referrals/{id}` | 연계 목록(상태·검색·페이지)/상세 |
| `POST /api/referrals/{id}/assign` | 담당자·지역 배정 (관리자) |
| `POST /api/referrals/{id}/transition` | `{to, missingItems?, declineReason?, note?}` |
| `POST /api/referrals/{id}/consent-review` | 법적 근거 확인 (관리자) |
| `POST /api/referrals/{id}/accept` | 사례 생성(접수 완료) |
| `GET/POST /api/cases` | 목록(필터·정렬·페이지·group)/신규 신청 |
| `GET /api/cases/{id}` · `POST .../status` · `POST .../assign` · `GET .../identity` | 상세/상태 전이/배정/식별정보(감사) |
| `GET/POST .../records` · `PATCH/DELETE .../records/{rid}` | 상담 기록(수정 이력, 논리 삭제) |
| `GET/PUT .../assessment` · `POST .../assessment/{aid}/submit|confirm` | 조사 저장/검토 요청/확정 |
| `GET/PUT .../plan` · `POST .../plan/{pid}/transition` | 계획 저장/상태(승인 근거) |
| `POST .../meetings` · `POST .../meetings/{mid}/record` | 통합지원회의 등록/결과 |
| `GET .../match?planItemId=` | 제공기관 후보(이유·주의·제외 사유) |
| `GET/POST .../service-referrals` | 의뢰 목록/생성 |
| `GET/POST .../monitoring` · `GET .../timeline` | 모니터링/타임라인 |
| `GET /api/service-referrals` · `POST /api/service-referrals/{id}/transition` | 의뢰 보드/전이(담당자·기관 역할 구분) |
| `GET /api/providers` · `POST /api/providers/{id}/capacity` | 기관/수용 현황 |
| `POST /api/providers/import` | 관리자 전용: 서울시 강남구 사회복지시설 CSV 미리보기/가져오기 (`{csv, mode}`) |
| `POST /api/providers/{id}/verification` | 관리자 전용: 공개 데이터 기관 확인 완료/검증 해제. 미검증 기관은 매칭 제외 |
| `GET /api/tasks` · `POST /api/tasks/{id}` | 업무 |
| `GET /api/map` | 권역 집계·공백 |
| `GET/POST /api/reports` · `GET /api/reports/export` · `GET /api/exports/cases` · `POST /api/exports/print` | 보고서/스냅샷/CSV/인쇄 기록 |
| `POST/GET /api/ai/drafts` · `POST /api/ai/drafts/{id}/review` | AI 초안 생성/목록/승인·폐기 |
| `GET /api/audit` | 감사 로그 (감사·관리자) |
| `GET /api/admin/users` · `POST .../users/{id}/active|roles` · `GET/PUT /api/admin/settings` | 관리 |

## 제공기관
`GET /api/provider/referrals`, `GET /api/provider/referrals/{id}` — 자기 기관 앞 의뢰만.

## 시스템 간 연계 (병원 → 지자체)
[INTEGRATION_WITH_HOSPITAL.md](INTEGRATION_WITH_HOSPITAL.md) 참고. 업무 API와 인증 체계·경로를 분리(`/api/integrations/hospital/*`, Bearer 키, 쿠키 미사용).
