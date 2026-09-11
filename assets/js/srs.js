/* srs.js — SM-2 简化版复习算法（纯函数，无状态） */
export const Q = { AGAIN: 0, FUZZY: 2, GOOD: 4, EASY: 5 };

/** 对一个生词记录应用评分，返回新记录（不改原对象）。
 * rec: {reviews, correct, streak, ef, interval, dueAt, lastAt}（lastAt 为本次复习时间 ms）
 * 毕业判定：interval>=21 且 streak>=4，或 q===EASY */
export function review(rec, q, now = Date.now()) {
  const r = { ...rec, reviews: (rec.reviews || 0) + 1, lastAt: now };
  if (q >= 3) r.correct = (rec.correct || 0) + 1;
  else r.correct = rec.correct || 0;

  // EF 更新
  r.ef = Math.max(1.3, (rec.ef == null ? 2.5 : rec.ef) + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));

  if (q < 3) {           // 不认识/模糊重置
    r.streak = 0;
    r.reps = 0;
    r.interval = 1;
  } else {
    r.streak = (rec.streak || 0) + 1;
    const reps = (rec.reps || 0) + 1;
    r.reps = reps;
    r.interval = reps <= 1 ? 1 : (reps === 2 ? 3 : Math.round((rec.interval || 3) * r.ef));
  }
  r.dueAt = now + r.interval * 86400000;
  r.graduated = (r.interval >= 21 && r.streak >= 4) || q === Q.EASY;
  return r;
}

/** 新加入生词本的初始记录 */
export function newRec(now = Date.now()) {
  return {
    status: 'learning', addedAt: now,
    reviews: 0, correct: 0, streak: 0, reps: 0,
    ef: 2.5, interval: 0,
    dueAt: now + 86400000,   // 次日到期
    lastAt: 0,
  };
}

/** 到期排序键：dueAt 升序 */
export function dueSortKey(rec) { return rec.dueAt || 0; }

/** 今日是否到期 */
export function isDue(rec, now = Date.now()) { return (rec.dueAt || 0) <= now; }
