# 보안

| 항목 | 구현 | 비고/한계 |
|---|---|---|
| 세션 | HMAC-SHA256 서명 토큰(uid, tid, exp 8h), HTTP-only, SameSite=Lax, Secure(prod) | 매 요청 DB에서 사용자·역할 재조회 → 비활성화 즉시 반영. 서버측 세션 폐기 목록 없음(로드맵) |
| 비밀번호 | scrypt(N=16384) + timingSafeEqual, 없는 계정도 동일 연산 | 운영 계정 생성 UI 미구현 |
| DEMO | 데모 계정 선택은 개발 또는 `DEMO_MODE=true`에서만, 운영에서 데모 계정 비밀번호 로그인도 차단. 시드 기본 비밀번호 없음 | |
| 외부 IdP/SSO | `IdentityProviderAdapter` 인터페이스만 | 미연결 |
| CSRF | 변경 요청에 `x-ngm-csrf` 커스텀 헤더 + Origin 검사 + SameSite | |
| CSP 등 헤더 | CSP(`default-src 'self'`, frame-ancestors none), nosniff, Referrer-Policy, X-Frame-Options, HSTS, Permissions-Policy | Next.js 인라인 스크립트 때문에 `script-src 'unsafe-inline'` — nonce CSP는 로드맵 |
| 입력 검증 | 모든 API Zod, 길이 제한, `.strict()` 연계 DTO | |
| 권한 | 모든 Route Handler·Server Component가 서비스 계층 권한 검사(역할, 권역, 배정, 제공기관, ABAC) | UI 메뉴 숨김에 의존하지 않음 |
| 테넌트 격리 | 앱 범위 SQL + PostgreSQL RLS(비소유 역할, fail-closed) + 복합 FK | 테스트로 검증 |
| IDOR | 범위 밖은 404, 거부는 `access.denied` 감사 | |
| Rate limit | 로그인 10/분, 데모 로그인 30/분, 연계 60/분, AI 20/분 | **인스턴스 메모리** — 운영은 Vercel Firewall/공유 저장소 필요 |
| 감사 | 로그인·실패·로그아웃, 권한 변경, 조회(사례·식별정보·연계), 기록 생성·수정·삭제, 연계 수신·거부·상태, 계획 승인, 의뢰, 결과, 내보내기, AI, 설정, 거부 | 메타데이터만(PII 키 자동 제거), 추가 전용 |
| 로그 | 오류 로그에 메시지 앞 160자·타입만 | |
| 내보내기 | CSV 사례코드만(실명 없음), 수식 주입 방지, `data_export_logs` | |
| 비밀 관리 | 환경변수만, `.env*` gitignore, 연계 키는 해시 저장 | SESSION_SECRET 회전 시 기존 세션 무효(이중 키 검증은 로드맵) |
| 백업·복구 | Managed PG의 PITR/백업 사용 전제 | 미구성 — DEPLOYMENT.md |
