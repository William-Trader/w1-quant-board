'use strict';
const { openRO } = require('./util');
const TIANJI = '/home/ubuntu/w1-board/data/tianji_full.sqlite';

function compute(db, date, symbol) {
  const sym = symbol || 'BTC';
  const start = new Date(String(date || '') + 'T00:00:00+08:00').getTime();
  if (!isFinite(start)) return { ok: false, error: 'bad_date', hint: 'YYYY-MM-DD' };
  const end = start + 86400 * 1000;
  const bars = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol=? AND interval='5m' AND ts>=? AND ts<? ORDER BY ts").all(sym, start, end);
  const signals = db.prepare('SELECT id,symbol,direction,entry,stop,target1,target2,status,pnl_pct,strategy,regime,reason,pushed_at FROM signal_track WHERE pushed_at>=? AND pushed_at<? ORDER BY pushed_at').all(start, end);
  const news = db.prepare('SELECT ts,source,sentiment,title,url FROM news WHERE ts>=? AND ts<? ORDER BY influence DESC, ts DESC LIMIT 20').all(Math.floor(start / 1000), Math.floor(end / 1000));
  let verdict = null;
  try { verdict = db.prepare('SELECT date,posture_json,verdict_json,ai_text FROM verdict_daily WHERE date=?').get(String(date)); } catch (e) {}
  let factors = [];
  const t = openRO(TIANJI);
  if (t) {
    try { factors = t.prepare('SELECT ts,oi_chg_24h,funding,lsr,qibao_raw,qibao_score FROM factor_snapshots WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts').all(sym, Math.floor(start / 1000), Math.floor(end / 1000)); } catch (e) {}
    try { t.close(); } catch (e) {}
  }
  return {
    ok: true, date: String(date), symbol: sym,
    coverage: { bars: bars.length, signals: signals.length, news: news.length, factors: factors.length },
    bars, signals, news, verdict, factors
  };
}
module.exports = { compute };
