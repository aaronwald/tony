const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export interface Spinner {
  stop(clearLine?: boolean): void;
  update(message: string): void;
}

export function startSpinner(message: string): Spinner {
  let frame = 0;
  let currentMessage = message;

  const interval = setInterval(() => {
    const text = `  ${FRAMES[frame % FRAMES.length]} ${currentMessage}`;
    process.stderr.write(`\r\x1b[K${text}`);
    frame += 1;
  }, INTERVAL_MS);

  return {
    stop(clearLine = true) {
      clearInterval(interval);
      if (clearLine) {
        process.stderr.write("\r\x1b[K");
      }
    },
    update(msg: string) {
      currentMessage = msg;
    },
  };
}
