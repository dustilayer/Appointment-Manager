// PM2 守护配置：pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'kvisa',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '256M',
    env: { NODE_ENV: 'production' },
  }],
};
