// pm2 托管配置 — 进程名 w1-board，内存意识：常驻 ~150MB，超限 1G 重启（2026-07-31 放宽，原400M误杀采集高峰）
module.exports = {
  apps: [
    {
      name: 'w1-board',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3300,
        // mihomo rule proxy (CN direct, foreign via proxy) — added 2026-08-08
        http_proxy: 'http://127.0.0.1:7890',
        https_proxy: 'http://127.0.0.1:7890',
        all_proxy: 'socks5://127.0.0.1:7891',
        HTTP_PROXY: 'http://127.0.0.1:7890',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        ALL_PROXY: 'socks5://127.0.0.1:7891',
        no_proxy: 'localhost,127.0.0.1,10.0.0.0/8,*.cn,*.qq.com,*.tencent.com,*.aliyun.com',
        NO_PROXY: 'localhost,127.0.0.1,10.0.0.0/8,*.cn,*.qq.com,*.tencent.com,*.aliyun.com',
        NODE_USE_ENV_PROXY: '1'
      },
      out_file: 'logs/w1-board.out.log',
      error_file: 'logs/w1-board.err.log',
      merge_logs: true,
      time: true,
      autorestart: true,
      restart_delay: 3000
    }
  ]
};
