# 아키텍처

```
Browser ──(HTTP-only cookie, x-ngm-csrf)──▶ Next.js 16 App Router (Vercel Functions)
                                              ├─ Server Components (withPage)
                                              ├─ Route Handlers /api/*  (route())
                                              └─ /api/integrations/hospital/* (Bearer API key, Idempotency-Key)
                                                       │
                                     lib/server/services/*  ← 모든 권한·전이 검사
                                                       │ withTenant(): BEGIN; set_config('app.tenant_id'); SET LOCAL ROLE neulgyeot_app
                                                       ▼
                                      PostgreSQL (RLS)  — Managed PG(`pg`) | PGlite in-memory(DEMO/test)
Hospital app (별도 배포·별도 DB) ──▶ 승인된 referral payload만 전송 (직접 DB 접속 없음)
```

## 결정 (ADR 요약)
1. **별도 API 서버 없음** — Route Handler로 충분. FastAPI 등 추가 근거 없음.
2. **ORM 없음, `pg` + SQL** — RLS·복합 FK·CHECK를 SQL로 명시. Zod로 입력 검증.
3. **테넌트 격리 이중화** — 애플리케이션 범위 SQL + DB RLS(비소유 역할 `neulgyeot_app`). tenant 미설정 시 0행(fail-closed).
4. **UI와 API가 같은 서비스 함수 사용** — Server Component도 `withPage()`로 동일한 RLS·권한 경로.
5. **PGlite는 테스트와 명시적 DEMO 전용** — 운영(`NODE_ENV=production`)에서 `DATABASE_URL` 없이 `DEMO_MODE=true`가 아니면 기동 실패.
6. **AI는 선택 기능** — 규칙 기반 엔진이 기본, 키 없이도 전체 동작.

## 디렉터리
- `lib/domain` 순수 로직(상태 머신, 매칭, 평가 검증, CSV, AI 초안 검증, 지표 정의)
- `lib/integrations/hospital` 수신 DTO(Zod), 동의 범위 판정·최소화
- `lib/server` DB, 인증, 권한(authz), 감사, http, 서비스
- `app/(app)` 업무 화면, `app/api` API, `components` UI
- `tests/unit`, `tests/api`, `tests/e2e`
