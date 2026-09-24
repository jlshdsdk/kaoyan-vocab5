/* srs.js — SM-2 简化版复习算法（纯函数，无状态） */
export const Q = { AGAIN: 0, FUZZY: 2, GOOD: 4, EASY: 5 };

/** 对一个生词记录应用评分，返回新记录（不改原对象）。
 * rec: {reviews, correct, streak, ef, interval, dueAt, lastAt}（lastAt 为本次复习时间 ms）
 * 按键间隔：q=0 明天、q=2 后天、q=4 大后天、q=EASY 毕业 */
export function review(rec, q, now = Date.now()) {
  const r = { ...rec, reviews: (rec.reviews || 0) + 1, lastAt: now };
  if (q >= 3) r.correct = (rec.correct || 0) + 1;
  else r.correct = rec.correct || 0;

  // 生词本：1→明天，2→后天，3→大后天，4→立刻毕业。到期取目标日 0 点，当天一打开就出现。
  if (q === Q.EASY) {
    r.streak = (rec.streak || 0) + 1;
    r.reps = (rec.reps || 0) + 1;
    r.interval = Math.max(rec.interval || 0, 21);
    r.dueAt = now;
    r.graduated = true;
    return r;
  }
  const days = q === 0 ? 1 : q === 2 ? 2 : 3;
  if (q < 3) {
    r.streak = 0;
    r.reps = 0;
  } else {
    r.streak = (rec.streak || 0) + 1;
    r.reps = (rec.reps || 0) + 1;
  }
  r.interval = days;
  const due = new Date(now);
  due.setHours(0, 0, 0, 0);
  due.setDate(due.getDate() + days);
  r.dueAt = due.getTime();
  r.graduated = false;
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
