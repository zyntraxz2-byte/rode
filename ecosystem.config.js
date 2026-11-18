module.exports = {
  apps: [{
    name: 'rode',
    cwd: '/var/www/31_rode',
    script: 'src/server.js',
    node_args: '--env-file=/var/www/31_rode/.env',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '300M',
  }],
};