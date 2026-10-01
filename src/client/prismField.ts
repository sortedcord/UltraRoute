// Target effect: a soft right-to-left reveal, neutral left edge, and clustered
// highlights flowing through square cells rather than a saturated checkerboard.
const PALETTE = [
  [232, 66, 155], [155, 91, 232], [63, 199, 232],
  [184, 242, 95], [245, 185, 70],
] as const;
const NEUTRAL = [232, 230, 226] as const;

const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const hash = (value: number) => Math.abs(Math.sin(value) * 43758.5453) % 1;
const smooth = (low: number, high: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

interface Pixel {
  column: number;
  row: number;
  x: number;
  y: number;
  nx: number;
  seed: number;
  period: number;
  phase: number;
}

export function createPrismField(width: number, height: number) {
  const cell = width < 280 ? 5 : 6;
  const pixels: Pixel[] = [];
  for (let row = 0; row < Math.ceil(height / cell); row++) {
    for (let column = 0; column < Math.ceil(width / cell); column++) {
      pixels.push({
        column, row, x: column * cell, y: row * cell,
        nx: (column * cell + cell / 2) / width,
        seed: hash(column * 12.9898 + row * 78.233),
        period: 500 + hash(column * 7.13 + row * 19.41) * 1500,
        phase: hash(column * 31.17 + row * 11.93),
      });
    }
  }

  return (context: CanvasRenderingContext2D, elapsed: number, reducedMotion = false) => {
    context.clearRect(0, 0, width, height);
    const reveal = reducedMotion ? 1 : smooth(0, 1, elapsed / 1000);
    const frontier = 1 - reveal;
    const flowTime = reducedMotion ? 0 : elapsed / 4000;
    const flowCycle = Math.floor(flowTime);
    const flow = flowCycle + smooth(0, 1, flowTime - flowCycle);
    const time = reducedMotion ? 0 : elapsed;

    context.save();
    context.beginPath();
    context.roundRect(0, 0, width, height, 5);
    context.clip();
    for (const pixel of pixels) {
      const { column, row, nx, seed, period, phase } = pixel;
      const revealAlpha = smooth(frontier - .1, frontier + .07, nx);
      if (revealAlpha <= .002) continue;
      const intensity = smooth(.04, .38, nx);
      const depth = smooth(.1, .88, nx);
      const localTime = time + phase * period;
      const cycle = Math.floor(localTime / period);
      const cycleProgress = localTime % period / period;
      const cycleHash = hash(column * 17.17 + row * 41.73 + cycle * 13.11);
      const pulseWidth = .09 + hash(column * 5.37 + row * 29.11 + cycle * 7.43) * .08;
      const pulseDistance = (cycleProgress - (.2 + cycleHash * .55)) / pulseWidth;
      const flicker = Math.exp(-pulseDistance * pulseDistance * 1.45) * (cycleHash > .12 ? 1 : .26);
      const coordinate = (nx + flow) * 9;
      const flowIndex = Math.floor(coordinate);
      const clusterA = hash(flowIndex * 18.31 + row * 37.17);
      const clusterB = hash((flowIndex + 1) * 18.31 + row * 37.17);
      const cluster = smooth(.46, .84, mix(clusterA, clusterB, smooth(0, 1, coordinate - flowIndex)));
      const wave = Math.pow(.5 + .5 * Math.cos((nx + flow + row * .06 + seed * .02) * Math.PI * 2), 5);
      const directional = Math.max(cluster, wave * .62);
      const light = Math.max(flicker * (.48 + directional * .58), directional * (.38 + seed * .28));
      const frontierGlow = reveal < .995
        ? Math.exp(-((nx - frontier) ** 2) / .012) * (1 - smooth(.7, 1, reveal))
        : 0;
      const glow = Math.max(light, frontierGlow * (.4 + seed * .4));
      const hot = glow > .4 && flicker > .16 && cycleHash > .26 && cluster > .04;
      const highlight = hot ? .92 : Math.min(.64, glow * (.44 + cycleHash * .3));

      // Neighboring cells share a color region; only luminance flickers rapidly.
      // A slow color drift retains all five prism accents without rainbow noise.
      const huePosition = Math.max(0, Math.min(1, (nx - .15) / .8)) * PALETTE.length + row * .035 + Math.sin(time * .00035) * .2 + seed * .12;
      const hue = (huePosition % PALETTE.length + PALETTE.length) % PALETTE.length;
      const toneIndex = Math.floor(hue);
      const toneA = PALETTE[toneIndex];
      const toneB = PALETTE[(toneIndex + 1) % PALETTE.length];
      const toneMix = smooth(0, 1, hue - toneIndex);
      const chroma = depth * (.72 + seed * .18);
      const red = mix(NEUTRAL[0], mix(toneA[0], toneB[0], toneMix), chroma);
      const green = mix(NEUTRAL[1], mix(toneA[1], toneB[1], toneMix), chroma);
      const blue = mix(NEUTRAL[2], mix(toneA[2], toneB[2], toneMix), chroma);
      context.globalAlpha = revealAlpha * intensity * (hot ? 1 : Math.min(1, .88 + seed * .1 + light * .08));
      context.fillStyle = `rgb(${Math.round(mix(red, 250, highlight))} ${Math.round(mix(green, 248, highlight))} ${Math.round(mix(blue, 246, highlight))})`;
      context.fillRect(pixel.x + .55, pixel.y + .55, cell - 1.1, cell - 1.1);
    }
    context.restore();
  };
}
