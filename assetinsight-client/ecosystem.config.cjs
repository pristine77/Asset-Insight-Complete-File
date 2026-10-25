module.exports = {
  apps: [
    {
      name: "assetinsight-client",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      exec_mode: "cluster",
      instances: Number(process.env.WEB_INSTANCES || 2),
      kill_timeout: 15_000,
      listen_timeout: 15_000,
      max_memory_restart: process.env.WEB_MAX_MEMORY || "2G",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
