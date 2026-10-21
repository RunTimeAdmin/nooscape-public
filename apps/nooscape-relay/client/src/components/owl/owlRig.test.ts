import { describe, expect, it } from "vitest";
import { owlAllowedOn } from "./owlRoutes";
import { createOwlState, HEAD_LIMIT_DEG, MAX_FRAME_PX, MAX_SPEED, MAX_STRETCH, OWL_SIZE, perchedBox, perchPoint, poseTransforms, stepOwl, type OwlInput, type OwlState } from "./owlRig";

const size = OWL_SIZE.fine;
const input = (target: { x: number; y: number }, over: Partial<OwlInput> = {}): OwlInput => ({ dtMs: 16, nowMs: 0, target, reducedMotion: false, scanning: false, size, ...over });
/** A random source that always answers the same, so glides, tilts, ruffles and blinks are deterministic. */
const middle = () => 0.5;

function run(state: OwlState, target: { x: number; y: number }, seconds: number, over: Partial<OwlInput> = {}) {
  let pose = stepOwl(state, input(target, over), middle);
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += 16) {
    pose = stepOwl(state, input(target, { nowMs: elapsed, ...over }), middle);
  }
  return pose;
}

describe("the owl rig", () => {
  it("stays perched and still when the pointer does not move", () => {
    const state = createOwlState(400, 300);
    run(state, { x: 400, y: 300 }, 3);
    expect(state.mode).toBe("perched");
    expect(state.x).toBeCloseTo(400, 3);
    expect(state.y).toBeCloseTo(300, 3);
  });

  it("flies to a far pointer, arrives, and lands", () => {
    const state = createOwlState(100, 100);
    let flew = false;
    for (let elapsed = 0; elapsed < 6000; elapsed += 16) {
      stepOwl(state, input({ x: 900, y: 500 }, { nowMs: elapsed }), middle);
      if (state.mode === "flying") flew = true;
    }
    expect(flew).toBe(true);
    expect(Math.hypot(state.x - 900, state.y - 500)).toBeLessThan(1);
    expect(state.mode).toBe("perched");
  });

  it("never goes faster than the speed cap", () => {
    const state = createOwlState(0, 0);
    let fastest = 0;
    for (let elapsed = 0; elapsed < 3000; elapsed += 16) {
      stepOwl(state, input({ x: 90000, y: 90000 }, { nowMs: elapsed }), middle);
      fastest = Math.max(fastest, Math.hypot(state.vx, state.vy));
    }
    expect(fastest).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
    expect(fastest).toBeGreaterThan(MAX_SPEED * 0.9);
  });

  it("lands only after a quarter second below the landing speed", () => {
    const state = createOwlState(200, 200);
    state.mode = "flying";
    for (let step = 0; step < 15; step += 1) stepOwl(state, input({ x: 200, y: 200 }, { nowMs: step * 16 }), middle);
    // 15 steps of 16 ms is 0.24 s.
    expect(state.mode).toBe("flying");
    for (let step = 15; step < 18; step += 1) stepOwl(state, input({ x: 200, y: 200 }, { nowMs: step * 16 }), middle);
    expect(state.mode).toBe("perched");
  });

  it("is only a quick stretch, not a flight, while the pointer barely moves it", () => {
    const state = createOwlState(200, 200);
    run(state, { x: 203, y: 201 }, 2);
    expect(state.mode).toBe("perched");
  });

  it("keeps its head within the limit however far the pointer is", () => {
    const state = createOwlState(500, 400);
    for (const target of [{ x: -50000, y: 400 }, { x: 50000, y: 400 }]) {
      for (let elapsed = 0; elapsed < 200; elapsed += 16) stepOwl(state, input(target, { nowMs: elapsed }), middle);
      expect(Math.abs(state.headRot)).toBeLessThanOrEqual(HEAD_LIMIT_DEG + 1e-6);
    }
  });

  it("faces the way it is moving", () => {
    // Judged while it is under way: arriving, it overshoots and swings back.
    const state = createOwlState(800, 300);
    run(state, { x: 100, y: 300 }, 0.3);
    expect(state.face).toBe(-1);
    expect(state.flip).toBeLessThan(0);
    const other = createOwlState(100, 300);
    run(other, { x: 900, y: 300 }, 0.3);
    expect(other.face).toBe(1);
    expect(other.flip).toBeGreaterThan(0);
  });

  it("with reduced motion, snaps to the pointer and never moves a part", () => {
    const state = createOwlState(100, 100);
    for (let elapsed = 0; elapsed < 4000; elapsed += 16) {
      const pose = stepOwl(state, input({ x: 640, y: 360 + (elapsed % 50) }, { nowMs: elapsed, reducedMotion: true, scanning: true }), middle);
      expect(state.vx).toBe(0);
      expect(state.vy).toBe(0);
      expect(state.mode).toBe("perched");
      expect(pose.wingRotate).toBe(0);
      expect(pose.lidScaleY).toBe(0);
      expect(pose.headRotate).toBe(0);
      expect(pose.rootRotate).toBe(0);
      expect(pose.sweepRotate).toBe(0);
    }
    expect(state.x).toBe(640);
  });

  it("with reduced motion, a perched owl is one still picture: not a breath, a bob or a ruffle in thirty seconds", () => {
    const state = createOwlState(640, 360);
    const first = stepOwl(state, input({ x: 640, y: 360 }, { nowMs: 0, reducedMotion: true }), middle);
    for (let elapsed = 16; elapsed < 30_000; elapsed += 16) {
      expect(stepOwl(state, input({ x: 640, y: 360 }, { nowMs: elapsed, reducedMotion: true, onPerch: true }), middle)).toEqual(first);
    }
  });

  it("blinks, with the lids back open between", () => {
    const state = createOwlState(300, 300);
    let closed = 0;
    let open = 0;
    for (let elapsed = 0; elapsed < 8000; elapsed += 16) {
      const pose = stepOwl(state, input({ x: 300, y: 300 }, { nowMs: elapsed }), middle);
      if (pose.lidScaleY > 0.5) closed += 1;
      if (pose.lidScaleY === 0) open += 1;
    }
    expect(closed).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(closed);
  });

  it("turns its radar eye only while scanning", () => {
    const idle = createOwlState(300, 300);
    const busy = createOwlState(300, 300);
    run(idle, { x: 300, y: 300 }, 1, { scanning: false });
    run(busy, { x: 300, y: 300 }, 1, { scanning: true });
    expect(idle.sweep).toBe(0);
    expect(busy.sweep).toBeGreaterThan(0);
    expect(busy.sweep).toBeLessThan(360);
  });

  it("treats a long gap between frames as a short one", () => {
    const slow = createOwlState(0, 0);
    const quick = createOwlState(0, 0);
    stepOwl(slow, input({ x: 500, y: 500 }, { dtMs: 60_000 }), middle);
    stepOwl(quick, input({ x: 500, y: 500 }, { dtMs: 50 }), middle);
    expect(slow.x).toBeCloseTo(quick.x, 9);
    expect(slow.y).toBeCloseTo(quick.y, 9);
  });

  it("stands with its feet on the pointer", () => {
    const state = createOwlState(640, 360);
    const pose = run(state, { x: 640, y: 360 }, 2);
    // The box is centred on the pointer horizontally, and its feet (132/140 down) are at the pointer's height.
    expect(pose.x).toBeCloseTo(640 - size.width / 2, 0);
    expect(pose.y + (size.height * 132) / 140).toBeCloseTo(360, 0);
  });

  it("produces only finite numbers and well-formed transforms through a long, busy run", () => {
    const state = createOwlState(100, 100);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let elapsed = 0; elapsed < 20_000; elapsed += 16) {
      const target = { x: 600 + Math.sin(elapsed / 700) * 500, y: 400 + Math.cos(elapsed / 900) * 300 };
      const pose = stepOwl(state, input(target, { nowMs: elapsed, scanning: elapsed % 5000 < 2000 }), random);
      for (const value of Object.values(pose)) if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      const css = poseTransforms(pose);
      for (const text of Object.values(css)) expect(text).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it("formats each part's transform", () => {
    const state = createOwlState(300, 300);
    const css = poseTransforms(run(state, { x: 300, y: 300 }, 1));
    expect(css.box).toMatch(/^translate3d\(-?\d+(\.\d)?px,-?\d+(\.\d)?px,0\)$/);
    expect(css.root).toMatch(/^rotate\(-?[\d.]+deg\) scale\(-?[\d.]+,-?[\d.]+\)$/);
    expect(css.wings).toMatch(/^rotate\(-?[\d.]+deg\) scale\([\d.]+,1\)$/);
    expect(css.lids).toMatch(/^scale\(1,[\d.]+\)$/);
  });
});

describe("the owl's manners", () => {
  it("is held to the brief's limits: at most 1400 pixels a second, 40 a frame, and 8 percent of stretch", () => {
    expect(MAX_SPEED).toBeLessThanOrEqual(1400);
    expect(MAX_FRAME_PX).toBeLessThanOrEqual(40);
    expect(MAX_STRETCH).toBeLessThanOrEqual(0.08);
  });

  it("lags behind a pointer thrown across the page, and then catches up", () => {
    const state = createOwlState(100, 400);
    const throwTo = { x: 1300, y: 400 };
    run(state, throwTo, 0.25);
    const after = state.x;
    expect(after).toBeGreaterThan(100);
    expect(throwTo.x - after).toBeGreaterThan(600);
    run(state, throwTo, 5);
    expect(Math.abs(state.x - throwTo.x)).toBeLessThan(1);
  });

  it("never moves more than a frame's allowance, at any frame time, even after a stall", () => {
    for (const dtMs of [4, 16, 33, 50, 60_000]) {
      const state = createOwlState(0, 0);
      let before = { x: state.x, y: state.y };
      for (let step = 0; step < 400; step += 1) {
        stepOwl(state, input({ x: 90_000, y: 60_000 }, { dtMs, nowMs: step * 16 }), middle);
        expect(Math.hypot(state.x - before.x, state.y - before.y), `dt ${dtMs}, step ${step}`).toBeLessThanOrEqual(MAX_FRAME_PX + 1e-6);
        before = { x: state.x, y: state.y };
      }
    }
  });

  it("never stretches or squashes past eight percent along either axis, through takeoffs, landings and ruffles", () => {
    let seed = 31;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const state = createOwlState(300, 300);
    let widest = 0;
    let tallest = 0;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
      // Hard throws every second and a half, with the pointer still between.
      const phase = Math.floor(elapsed / 1500);
      const target = { x: phase % 2 ? 1300 : 100, y: phase % 3 ? 700 : 100 };
      const pose = stepOwl(state, input(target, { nowMs: elapsed }), random);
      widest = Math.max(widest, Math.abs(Math.abs(pose.rootScaleX) / Math.abs(state.flip || 1) - 1));
      tallest = Math.max(tallest, Math.abs(pose.rootScaleY - 1));
    }
    expect(widest).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
    expect(tallest).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
    // And the test is looking at something: the owl does squash.
    expect(tallest).toBeGreaterThan(0.02);
  });

  it("clamps the squash itself: however far the spring has swung, the owl is never more than eight percent off its size", () => {
    for (const squash of [-9, -3, -1, 1, 3, 9]) {
      const state = createOwlState(300, 300);
      state.squash = squash;
      state.squashV = 0;
      state.ruffle = 0.35;
      const pose = stepOwl(state, input({ x: 300, y: 300 }), () => 0.99);
      // The spring moves the squash a little in the step, but it is still far past the limit.
      expect(Math.abs(pose.rootScaleX / (state.flip || 1) - 1), `squash ${squash}`).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
      expect(Math.abs(pose.rootScaleY - 1), `squash ${squash}`).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
    }
  });

  it("turns its head about every eight seconds on a perch, more often off one", () => {
    const tilts = (onPerch: boolean) => {
      const state = createOwlState(300, 300);
      let count = 0;
      let before = 0;
      for (let elapsed = 0; elapsed < 120_000; elapsed += 16) {
        stepOwl(state, input({ x: 300, y: 300 }, { nowMs: elapsed, onPerch }), middle);
        if (state.tiltT > 1 && before <= 1) count += 1;
        before = state.tiltT;
      }
      return count;
    };
    const perched = tilts(true);
    expect(perched).toBeGreaterThanOrEqual(14);
    expect(perched).toBeLessThanOrEqual(16);
    expect(tilts(false)).toBeGreaterThan(perched);
  });

  it("blinks slowly on a perch: the lids stay shut longer", () => {
    const shut = (onPerch: boolean) => {
      const state = createOwlState(300, 300);
      let frames = 0;
      let blinks = 0;
      let before = 0;
      for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
        const pose = stepOwl(state, input({ x: 300, y: 300 }, { nowMs: elapsed, onPerch }), middle);
        if (pose.lidScaleY > 0.5) frames += 1;
        if (state.blink > 0 && before <= 0) blinks += 1;
        before = state.blink;
      }
      return frames / Math.max(1, blinks);
    };
    expect(shut(true)).toBeGreaterThan(shut(false) * 1.4);
  });
});

describe("the owl's perch", () => {
  it("is the middle of the box the page reserves for it, on the bottom edge", () => {
    expect(perchPoint({ left: 1000, right: 1160, bottom: 300 })).toEqual({ x: 1080, y: 290 });
    expect(perchPoint({ left: 20, right: 116, bottom: 640.5 })).toEqual({ x: 68, y: 630.5 });
  });

  it("is where the owl's feet land, so its whole box sits above the perch", () => {
    const state = createOwlState(1080, 290);
    const pose = run(state, perchPoint({ left: 1000, right: 1160, bottom: 300 }), 1);
    expect(pose.y + OWL_SIZE.fine.height).toBeGreaterThan(290);
    expect(pose.y).toBeLessThan(290 - OWL_SIZE.fine.height * 0.8);
  });
});

describe("the box the owl fills on its perch", () => {
  it("is as wide and as tall as the owl, centred on the perch with its feet on the bottom edge", () => {
    const box = perchedBox({ x: 500, y: 300 }, OWL_SIZE.fine);
    expect(box.right - box.left).toBe(OWL_SIZE.fine.width);
    expect(box.bottom - box.top).toBeCloseTo(OWL_SIZE.fine.height, 6);
    expect((box.left + box.right) / 2).toBe(500);
    expect(box.bottom).toBeGreaterThan(300);
    expect(box.bottom).toBeLessThan(300 + (OWL_SIZE.fine.height * 8) / 140 + 0.001);
  });
});

describe("where the owl appears", () => {
  it("is allowed on the home page", () => {
    expect(owlAllowedOn("/")).toBe(true);
  });

  it("is never allowed in the operator console", () => {
    expect(owlAllowedOn("/admin/sources")).toBe(false);
    expect(owlAllowedOn("/admin")).toBe(false);
  });

  it("is not on the other pages yet", () => {
    for (const path of ["/developers", "/verify", "/sources", "/context", "/about", "/changes", "/agents/abc", "/404"]) expect(owlAllowedOn(path)).toBe(false);
  });
});
