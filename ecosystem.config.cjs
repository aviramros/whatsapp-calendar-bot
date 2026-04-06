module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'src/server.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
