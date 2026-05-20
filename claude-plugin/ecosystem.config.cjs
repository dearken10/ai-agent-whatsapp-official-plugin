// pm2 ecosystem file. Run with:
//   pm2 start ecosystem.config.cjs
// The cwd is locked to this directory so `--env-file-if-exists=.env` resolves
// claude-plugin/.env regardless of where pm2 is invoked from.
module.exports = {
  apps: [
    {
      name: "claude-plugin",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--env-file-if-exists=.env --experimental-strip-types",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
