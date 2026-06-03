// In-memory rate limiting.
// 무료 Render 단일 인스턴스 환경 가정. 재시작하면 카운터 리셋(=의도된 release valve).

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

// ── 보고서 생성 (per-user) ──────────────────────────────────────────────────
const GEN_LIMIT = 5; // 시간당 5건
const userGenAttempts = new Map(); // userId -> [timestamp, ...]

function _pruneAndGet(userId) {
  const now = Date.now();
  const attempts = (userGenAttempts.get(userId) || []).filter(
    (t) => now - t < ONE_HOUR_MS,
  );
  userGenAttempts.set(userId, attempts);
  return attempts;
}

function checkUserGenLimit(userId) {
  const attempts = _pruneAndGet(userId);
  if (attempts.length >= GEN_LIMIT) {
    const oldest = Math.min(...attempts);
    return {
      allowed: false,
      unlockAt: oldest + ONE_HOUR_MS,
      count: attempts.length,
      limit: GEN_LIMIT,
    };
  }
  return { allowed: true, count: attempts.length, limit: GEN_LIMIT };
}

function recordUserGenAttempt(userId) {
  const attempts = userGenAttempts.get(userId) || [];
  attempts.push(Date.now());
  userGenAttempts.set(userId, attempts);
}

function unlockUser(userId) {
  userGenAttempts.delete(userId);
}

function getUserGenCount(userId) {
  return _pruneAndGet(userId).length;
}

// ── 비밀번호 변경 (per-user) ────────────────────────────────────────────────
const PWCHANGE_LIMIT = 3; // 10분당 3회
const pwChangeAttempts = new Map(); // userId -> [timestamp, ...]

function checkPasswordChangeLimit(userId) {
  const now = Date.now();
  const attempts = (pwChangeAttempts.get(userId) || []).filter(
    (t) => now - t < TEN_MIN_MS,
  );
  pwChangeAttempts.set(userId, attempts);
  return {
    allowed: attempts.length < PWCHANGE_LIMIT,
    count: attempts.length,
    limit: PWCHANGE_LIMIT,
  };
}

function recordPasswordChangeAttempt(userId) {
  const attempts = pwChangeAttempts.get(userId) || [];
  attempts.push(Date.now());
  pwChangeAttempts.set(userId, attempts);
}

// ── 건의사항/버그 제보 (per-user) ───────────────────────────────────────────
const FEEDBACK_LIMIT = 5; // 10분당 5회
const feedbackAttempts = new Map(); // userId -> [timestamp, ...]

function checkFeedbackLimit(userId) {
  const now = Date.now();
  const attempts = (feedbackAttempts.get(userId) || []).filter(
    (t) => now - t < TEN_MIN_MS,
  );
  feedbackAttempts.set(userId, attempts);
  return {
    allowed: attempts.length < FEEDBACK_LIMIT,
    count: attempts.length,
    limit: FEEDBACK_LIMIT,
  };
}

function recordFeedbackAttempt(userId) {
  const attempts = feedbackAttempts.get(userId) || [];
  attempts.push(Date.now());
  feedbackAttempts.set(userId, attempts);
}

// ── 베타 기능 사용 (per-user, per-feature, 일일 한도) ────────────────────────
// 베타 기능(예: PDF 통번역)은 크레딧 차감이 없으므로 테스터 1인당 하루 사용량을 제한한다.
// 한도 값은 server.js가 관리(관리자 설정 + 환경변수 기본값)하고 여기엔 카운터만 둔다.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const betaUsage = new Map(); // `${userId}|${featureKey}` -> [timestamp, ...]
function _betaK(userId, key) {
  return String(userId) + "|" + String(key);
}
function _betaPruneGet(userId, key) {
  const now = Date.now();
  const k = _betaK(userId, key);
  const a = (betaUsage.get(k) || []).filter((t) => now - t < ONE_DAY_MS);
  betaUsage.set(k, a);
  return a;
}
// limit <= 0 또는 무한대면 무제한. allowed=false면 한도 초과.
function checkBetaUsageLimit(userId, key, limit) {
  const lim = Number(limit);
  const a = _betaPruneGet(userId, key);
  if (!Number.isFinite(lim) || lim <= 0) {
    return { allowed: true, count: a.length, limit: 0, unlimited: true };
  }
  const oldest = a.length ? Math.min(...a) : null;
  return {
    allowed: a.length < lim,
    count: a.length,
    limit: lim,
    resetAt: oldest != null ? oldest + ONE_DAY_MS : null,
  };
}
function recordBetaUsage(userId, key) {
  const k = _betaK(userId, key);
  const a = betaUsage.get(k) || [];
  a.push(Date.now());
  betaUsage.set(k, a);
}
function getBetaUsageCount(userId, key) {
  return _betaPruneGet(userId, key).length;
}

// ── 로그인 (per-IP) ──────────────────────────────────────────────────────────
const LOGIN_LIMIT = 10; // 분당 10회
const loginAttemptsByIp = new Map(); // ip -> [timestamp, ...]

function checkLoginLimit(ip) {
  const now = Date.now();
  const attempts = (loginAttemptsByIp.get(ip) || []).filter(
    (t) => now - t < ONE_MIN_MS,
  );
  loginAttemptsByIp.set(ip, attempts);
  return {
    allowed: attempts.length < LOGIN_LIMIT,
    count: attempts.length,
    limit: LOGIN_LIMIT,
  };
}

function recordLoginAttempt(ip) {
  const attempts = loginAttemptsByIp.get(ip) || [];
  attempts.push(Date.now());
  loginAttemptsByIp.set(ip, attempts);
}

// 주기적 정리 (메모리 leak 방지) — 30분마다 만료된 항목 청소
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of userGenAttempts.entries()) {
      const fresh = v.filter((t) => now - t < ONE_HOUR_MS);
      if (fresh.length === 0) userGenAttempts.delete(k);
      else userGenAttempts.set(k, fresh);
    }
    for (const [k, v] of loginAttemptsByIp.entries()) {
      const fresh = v.filter((t) => now - t < ONE_MIN_MS);
      if (fresh.length === 0) loginAttemptsByIp.delete(k);
      else loginAttemptsByIp.set(k, fresh);
    }
    for (const [k, v] of pwChangeAttempts.entries()) {
      const fresh = v.filter((t) => now - t < TEN_MIN_MS);
      if (fresh.length === 0) pwChangeAttempts.delete(k);
      else pwChangeAttempts.set(k, fresh);
    }
    for (const [k, v] of feedbackAttempts.entries()) {
      const fresh = v.filter((t) => now - t < TEN_MIN_MS);
      if (fresh.length === 0) feedbackAttempts.delete(k);
      else feedbackAttempts.set(k, fresh);
    }
    for (const [k, v] of betaUsage.entries()) {
      const fresh = v.filter((t) => now - t < ONE_DAY_MS);
      if (fresh.length === 0) betaUsage.delete(k);
      else betaUsage.set(k, fresh);
    }
  },
  30 * 60 * 1000,
);

module.exports = {
  GEN_LIMIT,
  LOGIN_LIMIT,
  PWCHANGE_LIMIT,
  FEEDBACK_LIMIT,
  checkUserGenLimit,
  recordUserGenAttempt,
  unlockUser,
  getUserGenCount,
  checkLoginLimit,
  recordLoginAttempt,
  checkPasswordChangeLimit,
  recordPasswordChangeAttempt,
  checkFeedbackLimit,
  recordFeedbackAttempt,
  checkBetaUsageLimit,
  recordBetaUsage,
  getBetaUsageCount,
};
