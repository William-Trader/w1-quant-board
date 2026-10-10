# -*- coding: utf-8 -*-
"""BTC预言机 历史战绩页数字 全量复现核对（2026-08-13 定版口径）
页面数字 = 实验14(短线v5.1) + 实验20/21(大方向轨) 的精确回测输出
用法: python3 backtest/verify_page_stats.py
"""
import sqlite3, pandas as pd, numpy as np

def load():
    con = sqlite3.connect('file:/home/ubuntu/btc-oracle/backtest/hist.db?mode=ro', uri=True)
    kl = pd.read_sql('SELECT ts,o,h,l,c,v FROM klines WHERE symbol="BTCUSDT" ORDER BY ts', con)
    fr = pd.read_sql('SELECT ts, rate FROM funding ORDER BY ts', con)
    con.close()
    kl['dt'] = pd.to_datetime(kl['ts'], unit='ms'); kl = kl.set_index('dt').sort_index()
    fr['dt'] = pd.to_datetime(fr['ts'], unit='ms'); fr = fr.set_index('dt').sort_index()
    kl['funding'] = fr['rate'].reindex(kl.index, method='ffill')
    return kl.dropna(subset=['funding'])

def short_v51(kl):
    def wilder_rsi(c,p=14):
        d=c.diff(); up=d.clip(lower=0); dn=(-d).clip(lower=0)
        ru=up.ewm(alpha=1/p,adjust=False).mean(); rd=dn.ewm(alpha=1/p,adjust=False).mean()
        return (100-100/(1+ru/rd.replace(0,np.nan))).fillna(50)
    def boll(c,p=20,k=2):
        m=c.rolling(p).mean(); sd=c.rolling(p).std(ddof=0)
        return ((c-(m-k*sd))/((m+k*sd)-(m-k*sd)).replace(0,np.nan)).clip(0,1)
    ret24=(kl['c']/kl['c'].shift(24)-1)*100
    rev=np.clip(-ret24/8.0,-1,1)
    rsi_rev=np.clip((50-wilder_rsi(kl['c']))/50,-1,1)
    bp=boll(kl['c']); boll_rev=np.clip((0.5-bp)*2,-1,1)
    funding=np.where(kl['funding']>0.0005,-0.5,np.where(kl['funding']>0.0001,0.2,np.where(kl['funding']>-0.0001,0.0,-0.3)))
    h24=kl['c'].rolling(24).max(); l24=kl['c'].rolling(24).min()
    pos24=(kl['c']-l24)/(h24-l24).replace(0,np.nan)
    ma30=kl['c'].rolling(30).mean()
    slope30=(ma30/ma30.shift(24)-1)*100
    score=(rev*0.5+rsi_rev*0.15+boll_rev*0.15+funding*0.2)
    fut=kl['c'].shift(-12); au=(fut>kl['c']).astype(int)
    bull=(score>0.30)&(pos24<0.5)&(ret24<-0.5)&(slope30>0)
    bear=(score<-0.50)&(pos24>0.6)&(slope30<0)
    out={}
    for label, mask in (("2025",kl.index.year==2025),("2026",kl.index.year==2026)):
        bm=bull&mask; rm=bear&mask
        nb=int(bm.sum()); nbe=int(rm.sum())
        hb=int((bm&(au==1)).sum()); hbe=int((rm&(au==0)).sum())
        tot=nb+nbe; out[label]=(tot, round((hb+hbe)/tot*100,1) if tot else None)
    return out

def long_track(kl):
    d = kl.resample('1D').agg({'o':'first','h':'max','l':'min','c':'last','v':'sum'}).dropna()
    c=d['c']
    d['ret30d']=(c/c.shift(30)-1)*100
    d['ret60d']=(c/c.shift(60)-1)*100
    up30=(c.shift(-30)>c).astype(int)
    def hr(mask):
        m=mask; n=int(m.sum()); acc=(up30&m).sum()/n*100 if n else None
        return n, round(acc,1) if n else None
    A=d['ret30d']>20; B=d['ret60d']<-20; E=A|B
    return {
        'A延续': hr(A),
        'B反弹': hr(B),
        'E25合并': hr(E&(d.index.year==2025)),
        'E26合并': hr(E&(d.index.year==2026)),
        '天数': len(d), 'K线': len(kl),
    }

if __name__=='__main__':
    kl=load()
    s=short_v51(kl); l=long_track(kl)
    print(f"数据: {l['K线']}根1H / {l['天数']}天 | 截止 {kl.index[-1]}")
    print(f"\n短线 v5.1 (页面: 2025=216/64.4%  2026=108/62.0%)")
    print(f"  2025: {s['2025'][0]}笔/{s['2025'][1]}%  2026: {s['2026'][0]}笔/{s['2026'][1]}%")
    print(f"\n大方向 30天 (页面: 449/65.7%  369/60.2%  25=52/71.2%  26=70/82.9%)")
    print(f"  强势延续: {l['A延续'][0]}/{l['A延续'][1]}%  超跌反弹: {l['B反弹'][0]}/{l['B反弹'][1]}%")
    print(f"  合并2025: {l['E25合并'][0]}/{l['E25合并'][1]}%  合并2026: {l['E26合并'][0]}/{l['E26合并'][1]}%")
    ok = (s['2025'][0]==216 and s['2025'][1]==64.4 and s['2026'][0]==108 and s['2026'][1]==62.0
          and l['A延续'][0]==449 and l['A延续'][1]==65.7 and l['B反弹'][0]==369 and l['B反弹'][1]==60.2
          and l['E25合并'][0]==52 and l['E25合并'][1]==71.2 and l['E26合并'][0]==70 and l['E26合并'][1]==82.9)
    print(f"\n{'✅ 全部 6 项与页面精确一致' if ok else '⚠️ 存在差异，请核对'}")
