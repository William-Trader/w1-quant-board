# -*- coding: utf-8 -*-
"""
20 样本点盲测生成器（2026-08-10 · William 老板指示扩充）
- 原 10 场：直接从 10 样本备份 JSON 保真复制（历史口径一个字不改）
- 新增 10 场：引擎判定信号 + hist.db 真实 14 天走势自动回测（冻结时间，无未来函数）
- summary（账本/净值/对照组/分组）全量重算
用法：python3 scripts/experience/gen_20.py
"""
import sys, sqlite3, datetime, json
sys.path.insert(0, '/home/ubuntu/w1-board/scripts/experience')
from blind_engine import analyze, judge, DB

PRINCIPAL = 10000
OLD_BAK = '/home/ubuntu/w1-board/public/experience.json.bak-10samples'
DATA_OUT = '/home/ubuntu/w1-board/data/experience_blind.json'
PUBLIC_OUT = '/home/ubuntu/w1-board/public/experience.json'

con = sqlite3.connect(DB); con.row_factory = sqlite3.Row

# ===== 新增 10 个决策点（2025 上半年，行情代表性） =====
NEW_POINTS = [
    ("2025-02-15","顶部滞涨","2月反弹高位，量价背离","short_mild",3),
    ("2025-02-28","深跌恐慌","RSI 18 极度超卖 FGI 16","long",12),
    ("2025-03-12","恐慌中继","暴跌后低位横盘","flat",0),
    ("2025-03-31","底部企稳","84k 缩量企稳","long_mild",3),
    ("2025-04-03","二次探底","关税恐慌再探底","long_mild",3),
    ("2025-04-30","反弹加速","85k→94k 快速反弹","flat",0),
    ("2025-05-11","赶顶阶段","104k 高位 RSI 77","short_mild",3),
    ("2025-06-30","趋势中继","107k 多头延续","long",8),
    ("2025-07-30","高位钝化","118k 历史新高滞涨","short_mild",3),
    ("2025-08-09","破位前兆","冲高回落 116k","short_mild",3),
]

def direction(label):
    if '多' in label: return 1
    if '空' in label: return -1
    return 0

def backtest_new(d):
    """引擎判定 + DB 真实 14 天回测"""
    freeze = int(datetime.datetime.fromisoformat(d + " 23:59:59").timestamp()*1000)
    a = analyze(con, freeze); j = judge(a)
    if not a or not j: return None
    d14 = (datetime.date.fromisoformat(d) + datetime.timedelta(days=14)).isoformat()
    row = con.execute("SELECT c FROM klines WHERE symbol='BTCUSDT' AND date(ts/1000,'unixepoch','+8 hours')<=? ORDER BY ts DESC LIMIT 1", (d14,)).fetchone()
    if not row: return None
    p14 = row['c']; chg14 = round((p14/a['price']-1)*100, 1)
    label = j['label']; pos = j['pos']; dr = direction(label)
    if pos == 0: hit, status = True, '✅ 观望避险'
    elif (dr > 0 and chg14 > 0) or (dr < 0 and chg14 < 0): hit, status = True, '✅ 命中'
    else: hit, status = False, '❌ 未中'
    pnl = dr * pos * chg14 * 100  # 方向×仓位%×涨跌%×100x
    pnl = round(pnl)
    if not hit and pos: pnl = -abs(pnl)
    return dict(date=d, price=round(a['price']),
                rsi=round(a['rsi'],1) if a['rsi'] is not None else None,
                macd="多头" if a['macd_hist'] and a['macd_hist']>0 else "空头",
                trend=("多头排列" if a['s7'] and a['s25'] and a['s99'] and a['s7']>a['s25']>a['s99']
                       else "空头排列" if a['s7'] and a['s25'] and a['s99'] and a['s7']<a['s25']<a['s99'] else "均线缠绕"),
                pos20=round(a['pos20']) if a['pos20'] is not None else None,
                mom20=round(a['mom20'],1) if a['mom20'] is not None else None,
                volr=round(a['volr'],2) if a['volr'] is not None else None,
                fgi=int(a['fgi'] or 0), score=j['score'], label=label, pos=pos,
                reasons=j['reasons'],
                p14=round(p14), chg14=chg14, status=status, hit=hit, pnl=pnl)

# ===== 原 10 场保真复制 =====
old = json.load(open(OLD_BAK))
old_results = {r['date']: r for r in old['results']}
results = []
for date in [r['date'] for r in old['results']]:
    results.append(old_results[date])

# ===== 新增 10 场 =====
for date, scene, desc, cls, pos in NEW_POINTS:
    r = backtest_new(date)
    if not r:
        print(f"⚠️ {date} 回测失败"); continue
    r.update(scene=scene, desc=desc, cls=cls)
    results.append(r)

results.sort(key=lambda x: x['date'])

# ===== summary 全量重算 =====
settled = [r for r in results if r['hit'] is not None]
wins = sum(1 for r in settled if r['hit'])
pending = len(results) - len(settled)
total_pnl = sum(r['pnl'] for r in results)
ledger = [r['pnl'] for r in results]
acc = round(wins/len(settled)*100)

eq = [PRINCIPAL]; cur = PRINCIPAL
for r in results:
    cur += r['pnl']; eq.append(round(cur))

def ctl_path(lev):
    path = [PRINCIPAL]
    for r in results:
        if r['chg14'] is None: path.append(path[-1]); continue
        v = path[-1]*(1+lev*r['chg14']/100)
        path.append(round(v) if v > 0 else 0)
    return path
ctl100, ctl10 = ctl_path(100), ctl_path(10)

def wipe_at(path):
    for i in range(1, len(path)):
        if path[i] == 0:
            r = results[i-1]
            return dict(call=i, date=r['date'], chg=r['chg14'], label=r['label'])
    return None
w100, w10 = wipe_at(ctl100), wipe_at(ctl10)

regime_map = {
    "2025-08-31":"📉 顶部反转","2025-10-20":"🫨 恐慌暴跌","2025-11-20":"🕳️ 底部磨底",
    "2025-12-31":"🕳️ 底部磨底","2026-01-31":"🕳️ 底部磨底","2026-02-28":"🕳️ 底部磨底",
    "2026-03-10":"📈 趋势中继","2026-04-30":"📈 趋势中继","2026-05-31":"📉 顶部反转",
    "2026-07-31":"📉 顶部反转",
    "2025-02-15":"📉 顶部反转","2025-02-28":"🫨 恐慌暴跌","2025-03-12":"🫨 恐慌暴跌",
    "2025-03-31":"🕳️ 底部磨底","2025-04-03":"🫨 恐慌暴跌","2025-04-30":"📈 趋势中继",
    "2025-05-11":"📉 顶部反转","2025-06-30":"📈 趋势中继","2025-07-30":"📉 顶部反转",
    "2025-08-09":"📉 顶部反转",
}
from collections import OrderedDict
groups = OrderedDict()
for r in results:
    g = regime_map.get(r['date'], '📊 其他')
    groups.setdefault(g, []).append(r)
regime_stats = []
for g, rs in groups.items():
    st = [x for x in rs if x['hit'] is not None]
    g_wins = sum(1 for x in st if x['hit'])
    regime_stats.append(dict(name=g, total=len(rs), hit=g_wins, pending=len(rs)-len(st),
                             acc=round(g_wins/len(st)*100) if st else None, pnl=round(sum(x['pnl'] for x in rs))))

# mid 快照沿用原版（7/31 实时跟踪）
summary = dict(
    total=len(results), wins=wins, pending=pending, acc=acc,
    total_pnl=total_pnl, principal=PRINCIPAL, leverage=100,
    ledger=ledger, equity=eq, ctl100=ctl100, ctl10=ctl10,
    regime_stats=regime_stats, w100=w100, w10=w10,
    mid=old['summary'].get('mid'),
)
out = dict(generated=old.get('generated', '2026-08-10'), summary=summary, results=results)
for f in (DATA_OUT, PUBLIC_OUT):
    json.dump(out, open(f, 'w'), ensure_ascii=False, indent=1)
    print(f"✅ 已生成 {f}  ({len(results)} 场)")

print(f"\n📊 最终战绩: 命中 {wins}/{len(settled)} ({acc}%) | 账本 {total_pnl:+d}u (+{total_pnl/100:.1f}%)")
print(f"   净值 {PRINCIPAL} → {eq[-1]} | 待验证 {pending} 场")
print(f"   满仓100x 归零: 第{w100['call']}场 {w100['date']} ({w100['chg']}%)" if w100 else "   100x 未归零")
print(f"   满仓10x  归零: 第{w10['call']}场 {w10['date']} ({w10['chg']}%)" if w10 else "   10x 未归零")
