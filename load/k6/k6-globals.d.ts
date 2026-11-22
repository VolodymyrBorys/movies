// k6 provides a `console` global (printed as k6 log lines), but @types/k6 doesn't declare it
// and this config has no DOM/Node types. Only the methods k6 implements.
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
};
