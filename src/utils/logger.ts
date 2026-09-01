import pino from "pino";

export const log = pino({
  level: "info",
  transport: {
    target: "pino/file",
    options: { destination: 1 },
  },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
