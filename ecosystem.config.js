module.exports = {
  apps: [{
    name: 'flowtender',
    script: 'node_modules/.bin/next',
    args: 'start -p 3845',
    cwd: '/home/ubuntu/.openclaw/workspace-swe/flowtender',
    env: { PORT: '3845', NODE_ENV: 'production' },
  }]
};
