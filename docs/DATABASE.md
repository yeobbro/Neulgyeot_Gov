# 데이터베이스

마이그레이션: `001_init.ts`(스키마), `002_rls.ts`(RLS·권한), `003_geographic_coordinates.ts`(지리 참조 좌표·출처·정밀도). `npm run db:migrate`.

## 원칙
- 모든 업무 테이블 `tenant_id NOT NULL` + `UNIQUE (tenant_id, id)` + 자식은 **복합 FK** `(tenant_id, parent_id)` → 다른 테넌트 부모 참조 불가.
- **RLS**: `tenant_id = current_setting('app.tenant_id', true)` (USING + WITH CHECK). 요청은 비소유 역할 `neulgyeot_app`으로 실행. 미설정 시 0행.
- **추가 전용**: `audit_logs`, `referral_events`, `service_delivery_events`, `record_revisions`, `data_export_logs` — 앱 역할에 UPDATE/DELETE 권한 없음.
- 상태 값은 CHECK 제약(도메인 enum과 동일 배열에서 생성), 조건부 CHECK(예: 수행 불가 ⇒ 사유, 승인 ⇒ 승인자·시각, 종결 ⇔ closed_at).
- 직접식별자 분리: `recipient_identities`(성명·생년월일·외부 참조) ↔ `care_recipients`(가명 표시명·연령대·권역).
- 병원 환자번호는 저장하지 않고 `EXT-<sha256(source:patientId) 12자>` opaque 참조만 저장.

## 테이블
| 영역 | 테이블 |
|---|---|
| 조직·권한 | tenants, tenant_settings, organizations, users, user_roles, region_units(위도·경도·출처·정밀도), user_region_scopes |
| 대상자·사례 | care_recipients, recipient_identities, care_cases, case_assignments, applications, case_records, record_revisions, needs_assessments, assessment_items, home_environment_assessments |
| 병원 연계 | incoming_referrals, referral_payload_versions, referral_events, consent_evidence, integration_messages, idempotency_records, integration_clients |
| 지원계획 | support_plans, support_plan_items, integrated_support_meetings, meeting_participants, meeting_decisions |
| 서비스 | service_catalog, service_providers(공공 원본 ID·출처 URL·검증 상태·좌표), provider_service_areas, provider_capacity_snapshots, service_referrals, service_delivery_events |
| 후속 | monitoring_records, action_tasks, notifications, report_snapshots |
| AI·감사 | ai_drafts, ai_source_references, audit_logs, data_export_logs |
| 기타 | id_counters(테넌트별 문서번호), schema_migrations |

## 수정·삭제 이력
- 상담 기록 수정: 이전 본문을 `record_revisions`에 보존, `revision` 낙관적 잠금.
- 삭제: 논리 삭제(`is_deleted`) + 사유 이력. 물리 파기는 보존정책 배치(미구현, ROADMAP).
- 조사·계획·의뢰: `version` 낙관적 잠금, 계획은 `version_no`로 버전 관리.

## 보존·파기 (정책 초안 — 기관 확정 필요)
| 데이터 | 기본 보존 | 비고 |
|---|---|---|
| 병원 연계 payload | 동의서의 보유기간(`retention`) | 종결/기간 만료 시 파기 대상 |
| 사례·기록 | 사례 종결 후 기관 규정 기간 | 공공기록물 관련 규정 확인 필요 |
| 감사 로그 | 최소 1년 이상 권장 | 기관 지침 따름 |
| idempotency_records | 30일 | 정리 배치 필요 |

## 지리 참조 데이터
- `region_units.latitude/longitude`는 행정동 또는 자치구의 **참고 중심 좌표**이며 주소 좌표·기관 좌표·법정 경계 폴리곤이 아니다.
- `location_source`와 `location_precision`을 함께 저장해 좌표 출처와 정확도 범위를 화면에서 설명한다.
- 제공기관의 실주소·정확한 좌표는 공식/기관 확인 데이터가 연결되기 전까지 비워 두며, 기존 합성 좌표는 지도 핀으로 사용하지 않는다.
