-- ============================================================================
-- 통합 크레딧 포인트제 전환 — 1회성 마이그레이션
-- Supabase Dashboard → SQL Editor에 붙여넣고 "한 번만" Run.
-- 반드시 코드 배포 "전에" 실행할 것 (컬럼이 없으면 신규 코드가 모든 사용자를
-- 0크레딧으로 인식해 생성이 막힘).
-- db/credit-rpc.sql 의 spend_credits 함수도 함께 적용할 것.
--
-- ※ 운영 전용 파일 — 공개 repo(lab-report-generator-web)에는 포함하지 않는다
--    (testtest 베타 계정 포함).
-- ============================================================================

-- 1) 새 컬럼 추가 (기존 *_credits_usd 레거시 컬럼은 보존). 재실행 안전.
alter table users add column if not exists credits integer not null default 0;
alter table users add column if not exists unlimited boolean not null default false;
alter table users add column if not exists restricted_model text;

-- 2) 기존 사용자 잔액 → 크레딧 전환:
--    (사전 보고서 건수 + 결과 보고서 건수) × 3.
--    건수 = round(잔액USD / 보고서당 USD단가). 단가는 pricing.js 현재값 기준
--    (chem-pre ≈ $0.81, result ≈ $1.02). 환율이 크게 바뀌었으면 아래 숫자만 조정.
--    이미 credits>0 인 사용자는 건드리지 않음 → 우발적 재실행에도 잔액 보존.
update users
set credits = (
      round(coalesce(pre_credits_usd, 0) / 0.81)
    + round(coalesce(result_credits_usd, 0) / 1.02)
  )::int * 3
where coalesce(is_admin, false) = false
  and coalesce(credits, 0) = 0;

-- 3) 베타테스터 특수 계정: testtest / testtest
--    - unlimited = true  : 크레딧 차감 없이 무제한 사용
--    - restricted_model  : Sonnet 4.6만 사용 가능 (Opus 불가)
insert into users (
  name, student_id, password_hash, unlimited, restricted_model, is_admin, credits
)
values (
  'testtest',
  'beta',
  '68061c73403499eb0bcee3013a539204:e6e7a7c69321ffc6b1bd70d0bc616212658b475017f6e748583f0fa5a7bd868c544030f26acda7819f66ab22a426ea7581fbe8aa60d2ae983e5f1ef3c4359f58',
  true,
  'claude-sonnet-4-6',
  false,
  0
)
on conflict (name) do update set
  unlimited = true,
  restricted_model = 'claude-sonnet-4-6',
  password_hash = excluded.password_hash;

-- 끝. (원자적 차감 함수는 db/credit-rpc.sql 의 spend_credits 를 적용)
