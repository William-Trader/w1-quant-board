#!/bin/bash
# W1 大方向引擎数据保鲜：增量拉取 Binance K线/FGI/DVOL 到 hist.db
cd /home/ubuntu/btc-oracle/backtest
/usr/bin/python3 download_data.py >> /tmp/hist_update.log 2>&1
echo "--- $(date '+%F %T') 更新完成 ---" >> /tmp/hist_update.log
