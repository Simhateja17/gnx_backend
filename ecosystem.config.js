module.exports = {
  apps: [
    {
      name: 'globonexo-api',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'globonexo-workers',
      script: './dist/workers/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      log_file: './logs/workers.log',
      out_file: './logs/workers.out.log',
      error_file: './logs/workers.error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
