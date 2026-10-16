/**
 * The two-answer choice (`choose.ts`): Enter takes what is highlighted, the arrows move it, and
 * anything that ends the choice without one is no answer.
 */
import { describe, expect, test } from "bun:test";

import { choose } from "../src/commands/choose.ts";
import type { ChooseIO, Key } from "../src/commands/choose.ts";

/** A terminal that presses these keys, one at a time, after the choice is drawn. */
function scripted(keys: readonly Key[]): ChooseIO & { readonly drawn: string[] } {
  const drawn: string[] = [];
  return {
    drawn,
    write: (text) => drawn.push(text),
    keys: (onKey) => {
      let stopped = false;
      void (async () => {
        for (const key of keys) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- a key at a time, as typed
          await Promise.resolve();
          if (!stopped) onKey(key);
        }
      })();
      return () => {
        stopped = true;
      };
    },
  };
}

const ANSWERS = ["Yes", "No"] as const;

describe("a choice", () => {
  test("starts on the answer it is given, and Enter takes it", async () => {
    const io = scripted([{ name: "return" }]);
    expect(await choose("Q?", ANSWERS, 0, io)).toBe(0);
    expect(io.drawn[0]).toBe("Q?\n  › Yes\n    No");
  });

  test("moves with the arrows", async () => {
    expect(await choose("Q?", ANSWERS, 0, scripted([{ name: "down" }, { name: "return" }]))).toBe(
      1,
    );
    expect(
      await choose(
        "Q?",
        ANSWERS,
        0,
        scripted([{ name: "down" }, { name: "up" }, { name: "return" }]),
      ),
    ).toBe(0);
  });

  test("takes y and n directly", async () => {
    expect(await choose("Q?", ANSWERS, 0, scripted([{ name: "n" }]))).toBe(1);
    expect(await choose("Q?", ANSWERS, 1, scripted([{ name: "y" }]))).toBe(0);
  });

  test("Ctrl-C, Escape and the input ending are no answer", async () => {
    expect(await choose("Q?", ANSWERS, 0, scripted([{ name: "c", ctrl: true }]))).toBeNull();
    expect(await choose("Q?", ANSWERS, 0, scripted([{ name: "escape" }]))).toBeNull();
    expect(await choose("Q?", ANSWERS, 0, scripted([{ name: "end" }]))).toBeNull();
  });
});
