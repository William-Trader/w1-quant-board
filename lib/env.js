'use strict';
// 极简 .env 加载器（不引入 dotenv 依赖）。process.env 优先于 .env 文件。
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = Object.assign({}, process.env);
  const file = path.join(__dirname, '..', '.env');
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in env)) env[m[1]] = v;
    }
  }
  // 默认值兜底
  env.PORT = env.PORT || '3300';
  env.NODE_ENV = env.NODE_ENV || 'production';
  env.COINGLASS_BASE = env.COINGLASS_BASE || 'https://api.coinglass.site';
  env.DEEPSEEK_BASE = env.DEEPSEEK_BASE || 'https://api.deepseek.com';
  env.DEEPSEEK_MODEL = env.DEEPSEEK_MODEL || 'deepseek-chat';
  env.GATE_BASE = env.GATE_BASE || 'https://api.gateio.ws/api/v4';
  env.OPENCLUE_URL = env.OPENCLUE_URL || 'https://openclue.net/data/index.json';
  return env;
}

module.exports = { loadEnv };
