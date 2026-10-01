import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrismField } from "../../src/client/prismField.ts";

function capture() {
  let colors: string[] = [];
  const context = {
    clearRect() { colors = []; },
    save() {}, restore() {}, beginPath() {}, roundRect() {}, clip() {},
    set globalAlpha(value: number) {
      assert(Number.isFinite(value) && value >= 0 && value <= 1);
    },
    set fillStyle(value: string) {
      const match = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(value);
      assert(match, `Invalid pixel color: ${value}`);
      assert(match.slice(1).every(channel => Number(channel) <= 255));
      colors.push(value);
    },
    fillRect() {},
  } as unknown as CanvasRenderingContext2D;
  return { context, colors: () => colors.join("|") };
}

test("prism pixels keep animating through negative color-drift phases", () => {
  for (const width of [150, 310]) {
    const frame = capture();
    const draw = createPrismField(width, 22);
    draw(frame.context, 9000);
    const before = frame.colors();
    for (let elapsed = 10000; elapsed <= 20000; elapsed += 100) {
      draw(frame.context, elapsed);
    }
    const after = frame.colors();
    assert.notEqual(after, before, "Pixel field must continue changing beyond ten seconds");
  }
});

test("reduced-motion prism ignores elapsed time", () => {
  const frame = capture();
  const draw = createPrismField(310, 22);
  draw(frame.context, 0, true);
  const start = frame.colors();
  draw(frame.context, 60000, true);
  assert.equal(frame.colors(), start);
});
