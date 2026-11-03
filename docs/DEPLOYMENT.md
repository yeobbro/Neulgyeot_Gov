# 배포

## 환경변수
| 이름 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | 운영 필수 | Managed PostgreSQL. 없으면 인메모리 DEMO(비영구) |
| `SESSION_SECRET` | 운영 필수(32자+) | `DEMO_MODE=true`면 경고 후 데모용 고정 값 사용 — 실데이터 금지 |
| `APP_URL` | 권장 | 배포 URL |
| `DEMO_MODE` | | `true`: 합성 데이터 데모(데모 로그인, 비영구 DB 허용) |
| `AI_FEATURE_ENABLED`, `ANTHROPIC_API_KEY`, `AI_MODEL` | 선택 | 외부 LLM (기본 꺼짐) |
| `HOSPITAL_INTEGRATION_DEMO_KEY` | 선택 | 데모 연계 키 교체 |

## 운영 기동 규칙
- `NODE_ENV=production` + `DATABASE_URL` 없음 + `DEMO_MODE≠true` → DB 초기화 실패(의도된 안전장치, `/api/health` 503).
- DB 연결 시: `npm run db:migrate`로 스키마·RLS 적용. 앱 역할 `neulgyeot_app` 생성 권한(CREATEROLE)이 필요.

## Vercel
- 별도 프로젝트 `neulgyeot-municipality` (기존 `neulgyeot` 프로젝트와 분리)
- Framework: Next.js, Node 22
- 현재 상태와 URL은 TEST_REPORT.md / PR 설명 참고

## 현재 상태 (2026-11-03)
- Vercel 프로젝트 `neulgyeot-municipality` 생성(GitHub `yeobbro/Neulgyeot_Gov` 연결), 환경변수 `DEMO_MODE=true`, `AI_FEATURE_ENABLED=false`
- 최초 Production 빌드(`main` = 초기 커밋, 소스 없음)는 예상대로 실패. PR 병합 후 `main`에서 Production 빌드 예정
- `DATABASE_URL`·`SESSION_SECRET` 미설정 → 인메모리 DEMO DB(비영구), 데모용 세션 키 경고 상태 — 실데이터 사용 금지
