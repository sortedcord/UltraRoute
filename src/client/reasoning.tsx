import React, { useEffect, useId, useRef, useState } from "react";
import { Zap } from "lucide-react";
import { createPrismField } from "./prismField.ts";

export interface ReasoningLevel {
  value: string;
  label: string;
}

// UI presets only; individual ModelOption entries may override or disable them.
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = [
  { value: "low", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Ultra" },
];

function ReasoningPrismField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastFrame = -Infinity;
    let started = performance.now();
    let paint: ReturnType<typeof createPrismField> | undefined;
    const draw = (time: number) => {
      if (!paint) return;
      if (time - lastFrame >= 33 || motion.matches) {
        lastFrame = time;
        paint(context, time - started, motion.matches);
      }
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = -Infinity;
      if (!document.hidden) draw(performance.now());
    };
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint = createPrismField(width, height);
      restart();
    };
    const changeMotion = () => { started = performance.now(); restart(); };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    motion.addEventListener("change", changeMotion);
    document.addEventListener("visibilitychange", restart);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener("change", changeMotion);
      document.removeEventListener("visibilitychange", restart);
    };
  }, []);
  return <canvas ref={canvasRef} className="pf-reasoning-prism" aria-hidden="true" />;
}

export function reasoningChoice(levels: readonly ReasoningLevel[], selected?: string, defaultValue?: string) {
  const selectedIndex = levels.findIndex(level => level.value === selected);
  if (selectedIndex >= 0) return selectedIndex;
  const defaultIndex = levels.findIndex(level => level.value === defaultValue);
  return defaultIndex >= 0 ? defaultIndex : Math.min(1, Math.max(0, levels.length - 1));
}

export function ReasoningSlider({ levels, value, onChange }: {
  levels: readonly ReasoningLevel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  if (!levels.length) return null;
  const index = reasoningChoice(levels, value);
  const current = levels[index];
  const progress = levels.length > 1 ? index / (levels.length - 1) : 0;
  const highest = levels.length > 1 && index === levels.length - 1;
  const accent = current.value === "high" ? "#3fc7e8" : current.value === "xhigh" ? "#9b5be8" : "var(--lime)";

  return <section className={`pf-reasoning ${highest ? "is-highest" : ""}`} aria-label="Reasoning settings">
    <span key={current.value} className="pf-reasoning-value" aria-hidden="true">{current.label}</span>
    <div className={`pf-reasoning-slider ${dragging ? "is-dragging" : ""} ${highest ? "is-highest" : ""}`} style={{ "--reasoning-progress": progress, "--reasoning-accent": accent } as React.CSSProperties}>
      <div className="pf-reasoning-track" aria-hidden="true">
        <div className="pf-reasoning-fill" />
        {highest && <ReasoningPrismField />}
        {levels.map((level, stop) => <span key={level.value} className={`pf-reasoning-tick ${stop <= index ? "is-filled" : ""}`} style={{ left: `calc(10px + (100% - 20px) * ${levels.length > 1 ? stop / (levels.length - 1) : 0})` }} />)}
        <span className="pf-reasoning-knob"><Zap size={13} /></span>
      </div>
      <input id={id} className="pf-reasoning-input" type="range" min={0} max={Math.max(0, levels.length - 1)} step={1} value={index} disabled={levels.length < 2} aria-label="Reasoning level" aria-valuetext={current.label} onChange={event => onChange(levels[Number(event.target.value)].value)} onPointerDown={() => setDragging(true)} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onBlur={() => setDragging(false)} />
    </div>
  </section>;
}
