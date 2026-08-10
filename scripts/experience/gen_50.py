# -*- coding: utf-8 -*-
"""
50 样本点盲测生成器（2026-08-10 · William 老板指示扩充至50场）
- 旧 20 场：从现有 experience.json 保真复制（判定/指标/场景不变），仅统一爆仓截断
- 新 30 场：引擎判定信号 + hist.db 真实 14 天走势自动回测（含 2024 年现拉入库数据）
- 爆仓截断：亏损 ≤ 该仓位保证金（pos%×10000u），100x 下 12%/8%/3% 对应 -1200/-800/-300u
用法：python3 scripts/experience/gen_50.py
"""
import sqlite3, datetime, json, math

DB = '/home/ubuntu/btc-oracle/backtest/hist.db'
OLD = '/home/ubuntu/w1-board/public/experience.json'   # 当前20场
DATA_OUT = '/home/ubuntu/w1-board/data/experience_blind.json'
PUBLIC_OUT = '/home/ubuntu/w1-board/public/experience.json'
PRINCIPAL = 10000
LEVER = 100

con = sqlite3.connect(DB)

# ===== 一次性加载日线 + FGI（快速引擎） =====
rows = con.execute("""
    SELECT date(ts/1000,'unixepoch','+8 hours') d,
           (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c,
           SUM(v) v
    FROM klines k1 WHERE symbol='BTCUSDT' AND ts >= strftime('%s','2023-06-01')*1000 GROUP BY d ORDER BY d
""").fetchall()
days = [dict(d=r[0], c=r[1], v=r[2]) for r in rows]
day_idx = {d['d']: i for i, d in enumerate(days)}
fgi_rows = con.execute("SELECT ts, value FROM fgi ORDER BY ts").fetchall()
fgi_list = [(r[0], r[1]) for r in fgi_rows]

def sma(v, n): return sum(v[-n:])/n if len(v)>=n else None
def rsi_of(c, n=14):
    if len(c)<n+1: return None
    g=l=0
    for i in range(-n,0):
        chg=c[i]-c[i-1]
        if chg>=0: g+=chg
        else: l-=chg
    if l==0: return 100.0
    return 100-100/(1+(g/n)/(l/n))
def macd_of(c, f=12, s=26, sig=9):
    if len(c)<s+sig: return None
    def ema(v,n):
        k=2/(n+1); e=v[0]; out=[e]
        for x in v[1:]: e=x*k+e*(1-k); out.append(e)
        return out
    ef,es=ema(c,f),ema(c,s)
    dif=[a-b for a,b in zip(ef,es)]
    dea=ema(dif,sig)
    return dif[-1],dea[-1],(dif[-1]-dea[-1])*2
def boll_of(c,n=20):
    if len(c)<n: return None,None,None
    seg=c[-n:]; mid=sum(seg)/n
    sd=math.sqrt(sum((x-mid)**2 for x in seg)/n)
    return mid+2*sd,mid,mid-2*sd

def analyze_at(idx):
    closes=[x['c'] for x in days[:idx+1]]
    if len(closes)<40: return None
    price=closes[-1]
    r=rsi_of(closes)
    dif,dea,hist=macd_of(closes)
    s7,s25,s99=sma(closes,7),sma(closes,25),sma(closes,99)
    bu,bm,bl=boll_of(closes)
    mom5=(price/closes[-6]-1)*100 if len(closes)>=6 else None
    mom20=(price/closes[-21]-1)*100 if len(closes)>=21 else None
    lo20=min(closes[-20:]); hi20=max(closes[-20:])
    pos20=(price-lo20)/(hi20-lo20)*100 if hi20>lo20 else 50
    v5=sum(x['v'] for x in days[idx-4:idx+1])/5
    volr=days[idx]['v']/v5 if v5 else 1.0
    day_end=int(datetime.datetime.fromisoformat(days[idx]['d']+' 23:59:59').timestamp())
    fgi_v=None
    for ts,v in reversed(fgi_list):
        if ts<=day_end: fgi_v=v; break
    return dict(price=price,rsi=r,macd_hist=hist,s7=s7,s25=s25,s99=s99,boll_up=bu,boll_lo=bl,
                mom5=mom5,mom20=mom20,pos20=pos20,volr=volr,fgi=fgi_v)

def judge(a):
    if not a: return None
    score=0.0; reasons=[]
    p=a['price']
    if a['rsi'] is not None:
        if a['rsi']<25: score+=2.0; reasons.append(f"RSI {a['rsi']:.0f} 严重超卖 +2.0")
        elif a['rsi']<30: score+=1.5; reasons.append(f"RSI {a['rsi']:.0f} 超卖 +1.5")
        elif a['rsi']>80: score-=2.0; reasons.append(f"RSI {a['rsi']:.0f} 严重超买 -2.0")
        elif a['rsi']>70: score-=1.5; reasons.append(f"RSI {a['rsi']:.0f} 超买 -1.5")
    if a['macd_hist'] is not None:
        if a['macd_hist']>0: score+=1.5; reasons.append("MACD 金叉/多头 +1.5")
        else: score-=1.5; reasons.append("MACD 死叉/空头 -1.5")
    if a['s7'] and a['s25'] and a['s99']:
        if a['s7']>a['s25']>a['s99']: score+=1.0; reasons.append("均线多头排列 +1.0")
        elif a['s7']<a['s25']<a['s99']: score-=1.0; reasons.append("均线空头排列 -1.0")
    if a['boll_up'] and a['boll_lo']:
        if p>a['boll_up']: score-=1.0; reasons.append("上轨上方 -1.0")
        elif p<a['boll_lo']: score+=1.0; reasons.append("下轨下方 +1.0")
    if a['mom20'] is not None:
        if a['mom20']<-10: score+=1.0; reasons.append(f"20日动量 {a['mom20']:.1f}% 超跌 +1.0")
        elif a['mom20']>10: score-=1.0; reasons.append(f"20日动量 {a['mom20']:.1f}% 过热 -1.0")
    if a['volr'] is not None:
        if a['volr']>1.6 and a['mom5'] is not None and a['mom5']<0: score-=1.0; reasons.append(f"放量下跌 {a['volr']:.1f}x -1.0")
        elif a['volr']>1.6 and a['mom5'] is not None and a['mom5']>0: score+=1.0; reasons.append(f"放量上涨 {a['volr']:.1f}x +1.0")
    if a['fgi'] is not None:
        if a['fgi']<20: score+=2.0; reasons.append(f"FGI {a['fgi']} 极度恐惧 +2.0")
        elif a['fgi']<30: score+=1.0; reasons.append(f"FGI {a['fgi']} 恐惧 +1.0")
        elif a['fgi']>85: score-=2.0; reasons.append(f"FGI {a['fgi']} 极度贪婪 -2.0")
        elif a['fgi']>70: score-=1.0; reasons.append(f"FGI {a['fgi']} 贪婪 -1.0")
    if score>=3.0: label,pos='🚀 强烈看多',12
    elif score>=2.0: label,pos='📈 看多',8
    elif score>=1.0: label,pos='↗️ 谨慎看多',3
    elif score>0.3: label,pos='↗️ 中性偏多',0
    elif score>=-0.3: label,pos='⚡ 中性震荡',0
    elif score>=-1.0: label,pos='↘️ 中性偏空',0
    elif score>=-2.0: label,pos='↘️ 谨慎看空',3
    elif score>=-3.0: label,pos='📉 看空',8
    else: label,pos='🛑 强烈看空',12
    return dict(score=round(score,2),label=label,pos=pos,reasons=reasons)

def liq_cap(pos):
    """爆仓截断：亏损最多 = 该仓位保证金（pos% × 本金10000）"""
    return pos * PRINCIPAL / 100  # 3%→300, 8%→800, 12%→1200

def backtest_new(d):
    if d not in day_idx: return None
    idx=day_idx[d]
    a=analyze_at(idx); j=judge(a)
    if not a or not j: return None
    d14=(datetime.date.fromisoformat(d)+datetime.timedelta(days=14)).isoformat()
    p14_idx=None
    for i in range(idx,len(days)):
        if days[i]['d']<=d14: p14_idx=i
        else: break
    if p14_idx is None: return None
    p14=days[p14_idx]['c']; chg14=round((p14/a['price']-1)*100,1)
    label=j['label']; pos=j['pos']; dr=(1 if '多' in label else -1 if '空' in label else 0)
    if pos==0: hit,status=True,'✅ 观望避险'
    elif (dr>0 and chg14>0) or (dr<0 and chg14<0): hit,status=True,'✅ 命中'
    else: hit,status=False,'❌ 未中'
    pnl=round(dr*pos*chg14*100)
    if not hit and pos: pnl=-min(abs(pnl), liq_cap(pos))
    return dict(date=d, price=round(a['price']),
                rsi=round(a['rsi'],1) if a['rsi'] is not None else None,
                macd="多头" if a['macd_hist'] and a['macd_hist']>0 else "空头",
                trend=("多头排列" if a['s7'] and a['s25'] and a['s99'] and a['s7']>a['s25']>a['s99']
                       else "空头排列" if a['s7'] and a['s25'] and a['s99'] and a['s7']<a['s25']<a['s99'] else "均线缠绕"),
                pos20=round(a['pos20']) if a['pos20'] is not None else None,
                mom20=round(a['mom20'],1) if a['mom20'] is not None else None,
                volr=round(a['volr'],2) if a['volr'] is not None else None,
                fgi=int(a['fgi'] or 0), score=j['score'], label=label, pos=pos, reasons=j['reasons'],
                p14=round(p14), chg14=chg14, status=status, hit=hit, pnl=pnl)

# ===== 新 30 个决策点（2024 全年 + 2025 年初，场景齐全） =====
NEW_POINTS = [
    ("2024-02-26","ETF疯牛","ETF资金涌入，加速上涨","short",12),
    ("2024-03-05","新高回落","73k历史新高后冲高回落","short",8),
    ("2024-03-14","高位滞涨","新高后横盘滞涨","short_mild",3),
    ("2024-03-20","回调破位","高位回调破位","short",8),
    ("2024-04-13","地缘暴跌","伊以冲突引发暴跌","short_mild",3),
    ("2024-04-30","减半盘整","减半后窄幅盘整","flat",0),
    ("2024-05-23","震荡上沿","区间上沿反复试探","flat",0),
    ("2024-06-07","假突破","71k假突破后回落","long_mild",3),
    ("2024-06-24","政府抛售","德国政府抛售BTC暴跌","long_mild",3),
    ("2024-07-05","超卖反弹","57k超卖后反弹","long_mild",3),
    ("2024-07-15","反弹中继","反弹后平台整理","flat",0),
    ("2024-07-29","冲高回落","70k冲高回落","flat",0),
    ("2024-08-05","日股崩盘","日元套息平仓，49k插针","long_mild",3),
    ("2024-08-12","反弹遇阻","崩盘后反弹遇阻","short_mild",3),
    ("2024-08-25","顶部滞涨","64k滞涨","flat",0),
    ("2024-09-06","二次探底","54k二次探底","flat",0),
    ("2024-09-19","降息反弹","美联储降息后反弹","long_mild",3),
    ("2024-09-30","Q3收尾","季度末震荡","flat",0),
    ("2024-10-15","慢牛启动","65k慢牛启动","long_mild",3),
    ("2024-10-29","大选前夜","72k横盘蓄势","flat",0),
    ("2024-11-06","大选暴涨","特朗普胜选，74k启动","long_mild",3),
    ("2024-11-12","加速冲顶","87k加速冲顶","short_mild",3),
    ("2024-11-22","10万前夜","99k逼近10万滞涨","short",8),
    ("2024-12-05","破10万回调","破10万后首轮回调","short",8),
    ("2024-12-17","108k新高","历史新高后回落","short_mild",3),
    ("2024-12-27","年底了结","年末获利了结回调","short",8),
    ("2025-01-07","新年新高","98k新年新高","long_mild",3),
    ("2025-01-20","就职冲顶","105k特朗普就职冲顶","long_mild",3),
    ("2025-02-03","关税暴跌","关税恐慌回调","short_mild",3),
    ("2025-02-10","企稳反弹","95k企稳","short_mild",3),
]

# ===== 旧 20 场保真 + 统一爆仓截断 =====
old = json.load(open(OLD))
results = []
for r in old['results']:
    r2 = dict(r)
    if r2['hit'] is False and r2['pos'] > 0 and r2['pnl'] < 0:
        r2['pnl'] = -min(abs(r2['pnl']), liq_cap(r2['pos']))
    results.append(r2)

# ===== 新增 30 场 =====
for date, scene, desc, cls, _ in NEW_POINTS:
    r = backtest_new(date)
    if not r:
        print(f"⚠️ {date} 回测失败"); continue
    r.update(scene=scene, desc=desc, cls=cls)
    results.append(r)

results.sort(key=lambda x: x['date'])

# ===== summary 全量重算 =====
settled=[r for r in results if r['hit'] is not None]
wins=sum(1 for r in settled if r['hit'])
pending=len(results)-len(settled)
total_pnl=sum(r['pnl'] for r in results)
ledger=[r['pnl'] for r in results]
acc=round(wins/len(settled)*100)

eq=[PRINCIPAL]; cur=PRINCIPAL
for r in results:
    cur+=r['pnl']; eq.append(round(cur))

def ctl_path(lev):
    path=[PRINCIPAL]
    for r in results:
        if r['chg14'] is None: path.append(path[-1]); continue
        v=path[-1]*(1+lev*r['chg14']/100)
        path.append(round(v) if v>0 else 0)
    return path
ctl100, ctl10 = ctl_path(100), ctl_path(10)
def wipe_at(path):
    for i in range(1,len(path)):
        if path[i]==0:
            r=results[i-1]
            return dict(call=i,date=r['date'],chg=r['chg14'],label=r['label'])
    return None
w100, w10 = wipe_at(ctl100), wipe_at(ctl10)

regime_map={
    "2024-02-26":"🚀 牛市加速","2024-03-05":"📉 顶部反转","2024-03-14":"📉 顶部反转","2024-03-20":"📉 顶部反转",
    "2024-04-13":"🫨 恐慌暴跌","2024-04-30":"⚖️ 震荡盘整","2024-05-23":"⚖️ 震荡盘整","2024-06-07":"📉 顶部反转",
    "2024-06-24":"🫨 恐慌暴跌","2024-07-05":"🕳️ 底部磨底","2024-07-15":"⚖️ 震荡盘整","2024-07-29":"📉 顶部反转",
    "2024-08-05":"🫨 恐慌暴跌","2024-08-12":"🕳️ 底部磨底","2024-08-25":"⚖️ 震荡盘整","2024-09-06":"🕳️ 底部磨底",
    "2024-09-19":"📈 趋势中继","2024-09-30":"⚖️ 震荡盘整","2024-10-15":"📈 趋势中继","2024-10-29":"⚖️ 震荡盘整",
    "2024-11-06":"🚀 牛市加速","2024-11-12":"🚀 牛市加速","2024-11-22":"📉 顶部反转","2024-12-05":"📉 顶部反转",
    "2024-12-17":"📉 顶部反转","2024-12-27":"📉 顶部反转","2025-01-07":"🚀 牛市加速","2025-01-20":"📉 顶部反转",
    "2025-02-03":"🫨 恐慌暴跌","2025-02-10":"🕳️ 底部磨底",
    "2025-08-31":"📉 顶部反转","2025-10-20":"🫨 恐慌暴跌","2025-11-20":"🕳️ 底部磨底",
    "2025-12-31":"🕳️ 底部磨底","2026-01-31":"🕳️ 底部磨底","2026-02-28":"🕳️ 底部磨底",
    "2026-03-10":"📈 趋势中继","2026-04-30":"📈 趋势中继","2026-05-31":"📉 顶部反转","2026-07-31":"📉 顶部反转",
    "2025-02-15":"📉 顶部反转","2025-02-28":"🫨 恐慌暴跌","2025-03-12":"🫨 恐慌暴跌",
    "2025-03-31":"🕳️ 底部磨底","2025-04-03":"🫨 恐慌暴跌","2025-04-30":"📈 趋势中继",
    "2025-05-11":"📉 顶部反转","2025-06-30":"📈 趋势中继","2025-07-30":"📉 顶部反转",
    "2025-08-09":"📉 顶部反转",
}
from collections import OrderedDict
groups=OrderedDict()
for r in results:
    g=regime_map.get(r['date'],'📊 其他')
    groups.setdefault(g,[]).append(r)
regime_stats=[]
for g,rs in groups.items():
    st=[x for x in rs if x['hit'] is not None]
    gw=sum(1 for x in st if x['hit'])
    regime_stats.append(dict(name=g,total=len(rs),hit=gw,pending=len(rs)-len(st),
                             acc=round(gw/len(st)*100) if st else None,pnl=round(sum(x['pnl'] for x in rs))))

summary=dict(total=len(results),wins=wins,pending=pending,acc=acc,total_pnl=total_pnl,
             principal=PRINCIPAL,leverage=LEVER,ledger=ledger,equity=eq,ctl100=ctl100,ctl10=ctl10,
             regime_stats=regime_stats,w100=w100,w10=w10,mid=old['summary'].get('mid'))
out=dict(generated=old.get('generated','2026-08-10'),summary=summary,results=results)
for f in (DATA_OUT,PUBLIC_OUT):
    json.dump(out,open(f,'w'),ensure_ascii=False,indent=1)
    print(f"✅ 已生成 {f} ({len(results)} 场)")

print(f"\n📊 最终战绩: 命中 {wins}/{len(settled)} ({acc}%) | 账本 {total_pnl:+d}u (+{total_pnl/100:.1f}%)")
print(f"   净值 {PRINCIPAL} → {eq[-1]} | 待验证 {pending} 场")
print(f"   满仓100x: {('第'+str(w100['call'])+'场 '+w100['date']+' '+str(w100['chg'])+'% 归零') if w100 else '未归零'}")
print(f"   满仓10x : {('第'+str(w10['call'])+'场 '+w10['date']+' '+str(w10['chg'])+'% 归零') if w10 else '未归零'}")
for g in regime_stats: print(f"   {g['name']}: {g['hit']}/{g['total']-g['pending']} ({g['acc']}%) pnl={g['pnl']:+d}u")
