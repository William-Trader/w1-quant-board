#!/bin/bash
# 网格搜索: 胜率>67% + 夏普>1 的参数组合
cd /home/ubuntu/w1-board
BEST=""
BEST_SCORE=0
for ET in 2.5 3.0 3.5 4.0 4.5; do
  for SA in 1.5 2.0 2.5 3.0; do
    for T1 in 1.0 1.5 2.0; do
      for TRAIL in 2 3 4; do
        for TB in 8 12 16; do
          OUT=$(node scripts/backtest_dir.js "{\"entry_th\":$ET,\"stop_atr\":$SA,\"t1_rr\":$T1,\"trail_atr\":$TRAIL,\"time_bars\":$TB}" 2>/dev/null)
          WR=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['win_rate'])" 2>/dev/null)
          SH=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sharpe'])" 2>/dev/null)
          PF=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['profit_factor'])" 2>/dev/null)
          TR=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total_ret_pct'])" 2>/dev/null)
          # 目标: 胜率>=67 且 夏普>=1，综合分 = 胜率 + 夏普*10 + PF
          if python3 -c "exit(0 if $WR >= 67 and $SH >= 1 else 1)" 2>/dev/null; then
            SCORE=$(python3 -c "print($WR + $SH*10 + $PF*3 + $TR*0.2)")
            echo "✓ ET=$ET SA=$SA T1=$T1 TRAIL=$TRAIL TB=$TB → WR=$WR% SH=$SH PF=$PF RET=$TR% score=$SCORE"
            if python3 -c "exit(0 if $SCORE > $BEST_SCORE else 1)" 2>/dev/null; then
              BEST_SCORE=$SCORE
              BEST="ET=$ET SA=$SA T1=$T1 TRAIL=$TRAIL TB=$TB WR=$WR SH=$SH PF=$PF RET=$TR"
            fi
          else
            echo "  ET=$ET SA=$SA T1=$T1 TRAIL=$TRAIL TB=$TB → WR=$WR% SH=$SH PF=$PF RET=$TR%"
          fi
        done
      done
    done
  done
done
echo ""
echo "========== 最优组合 =========="
echo "$BEST"
