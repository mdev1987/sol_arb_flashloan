import pino from "pino";

export const log = pino(
  {
    level: "info",
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stdout, level: "info" },
    { stream: pino.destination({ dest: "bot.log", sync: true }), level: "info" },
  ]),
);
