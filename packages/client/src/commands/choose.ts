/**
 * A choice between two answers, with the arrow keys and Enter.
 *
 * The highlighted answer is what Enter takes, so the caller decides which one starts highlighted.
 * `y` and `n` choose directly. Ctrl-C, Escape or the input ending is no answer, which the caller
 * reads as no.
 */
import { emitKeypressEvents } from "node:readline";

export interface Key {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
}

/** Where the choice is drawn and the keys come from: the terminal in the CLI, a script in tests. */
export interface ChooseIO {
  readonly write: (text: string) => void;
  /** Deliver each key to `onKey` until the returned function is called. */
  readonly keys: (onKey: (key: Key) => void) => () => void;
}

const terminal: ChooseIO = {
  write: (text) => {
    process.stdout.write(text);
  },
  keys: (onKey) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const listener = (_text: string | undefined, key: Key | undefined): void => {
      onKey(key ?? {});
    };
    const ended = (): void => {
      onKey({ name: "end" });
    };
    process.stdin.on("keypress", listener);
    process.stdin.once("end", ended);
    return () => {
      process.stdin.off("keypress", listener);
      process.stdin.off("end", ended);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
  },
};

/** The two answers as drawn: an arrow beside the highlighted one. */
function lines(answers: readonly [string, string], current: 0 | 1): string {
  return answers.map((answer, index) => `  ${index === current ? "›" : " "} ${answer}`).join("\n");
}

/** What stopping the keys does before they have started. */
const NOTHING = (): void => {};

/** Back over the two lines just drawn, each cleared, to draw them again. */
const REDRAW = "\r\u001B[2K\u001B[1A\u001B[2K";

export async function choose(
  question: string,
  answers: readonly [string, string],
  initial: 0 | 1,
  io: ChooseIO = terminal,
): Promise<0 | 1 | null> {
  let current: 0 | 1 = initial;
  io.write(`${question}\n${lines(answers, current)}`);
  return await new Promise((resolve) => {
    let stop = NOTHING;
    const done = (answer: 0 | 1 | null): void => {
      stop();
      if (answer !== null) current = answer;
      // The two lines again, the chosen one marked, then the cursor below them.
      io.write(`${REDRAW}${lines(answers, current)}\n`);
      resolve(answer);
    };
    stop = io.keys((key) => {
      if ((key.ctrl === true && key.name === "c") || key.name === "escape" || key.name === "end") {
        done(null);
      } else if (key.name === "return" || key.name === "enter") {
        done(current);
      } else if (key.name === "y") {
        done(0);
      } else if (key.name === "n") {
        done(1);
      } else if (["up", "down", "left", "right", "tab", "j", "k"].includes(key.name ?? "")) {
        current = current === 0 ? 1 : 0;
        io.write(`${REDRAW}${lines(answers, current)}`);
      }
    });
  });
}
