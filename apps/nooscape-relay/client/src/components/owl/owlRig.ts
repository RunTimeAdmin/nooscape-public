/**
 * The owl's motion: a pure function of its state, the pointer and the clock.
 *
 * The owl follows the pointer on a spring that overshoots a little, switches
 * between perched and flying with a hysteresis (it takes off above 140 px/s and
 * lands after a quarter second below 35 px/s), squashes and stretches on each
 * change, banks into its velocity, flips to face the way it moves, flaps in
 * proportion to its speed with random glides, and keeps its head on the cursor
 * within 26 degrees. Perched, it breathes, tilts its head, ruffles and blinks.
 * Nothing here touches the DOM or the layout: the component writes the result to
 * `style.transform` and the loop reads nothing back.
 */

export type OwlSize = { width: number; height: number };

export const OWL_SIZE = {
  fine: { width: 110, height: 128 },
  /** A touch screen: tap to move, and a smaller owl. */
  coarse: { width: 84, height: 98 },
} as const satisfies Record<string, OwlSize>;

/** The artwork's viewBox is 140 units tall and its feet sit 132 units from the top. */
export const feetOffset = (size: OwlSize) => (size.height * 132) / 140;

/** How far above a perch's bottom edge the owl's feet rest: the ledge drawn there is 8px up and 2px thick, and the owl's tail hangs a few pixels below its feet. */
export const LEDGE_INSET = 10;

/** Where the owl's feet rest on a perch the page reserves for it (`data-owl-perch`): the middle of the box, on its ledge. */
export const perchPoint = (rect: { left: number; right: number; bottom: number }) => ({ x: (rect.left + rect.right) / 2, y: rect.bottom - LEDGE_INSET });

/** The box the owl fills while its feet are on `perch`: what a page must keep clear, and what its reserved box must hold. */
export function perchedBox(perch: { x: number; y: number }, size: OwlSize) {
  const top = perch.y - feetOffset(size);
  return { left: perch.x - size.width / 2, top, right: perch.x + size.width / 2, bottom: top + size.height };
}

const SPRING_STIFFNESS = 38;
const SPRING_DAMPING_RATIO = 0.62;
/** Fast enough to catch a flick, slow enough to read as flight: a pointer thrown across the page leaves the owl behind, and it catches up. */
export const MAX_SPEED = 1400;
/** The most the owl moves in one frame, whatever the frame time, so a stall cannot throw it. */
export const MAX_FRAME_PX = 40;
/** The most any part of the squash and stretch changes the owl's size, along either axis. The owl never streaks. */
export const MAX_STRETCH = 0.08;
const TAKEOFF_SPEED = 140;
const LANDING_SPEED = 35;
const LANDING_AFTER_S = 0.25;
export const HEAD_LIMIT_DEG = 26;
/** A frame that took longer than this is treated as this long, so a background tab cannot fling the owl. */
const MAX_STEP_MS = 50;

export type OwlState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: "perched" | "flying";
  still: number;
  face: 1 | -1;
  flip: number;
  bank: number;
  headRot: number;
  headTilt: number;
  tiltT: number;
  tiltDir: 1 | -1;
  nextTilt: number;
  squash: number;
  squashV: number;
  blink: number;
  /** How long the blink in progress takes: slower on a perch. */
  blinkLen: number;
  nextBlink: number;
  doubleBlink: boolean;
  ruffle: number;
  nextRuffle: number;
  sweep: number;
  fold: number;
  feet: number;
  phase: number;
  amp: number;
  glide: number;
  nextGlide: number;
};

export function createOwlState(x: number, y: number): OwlState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    mode: "perched",
    still: 0,
    face: 1,
    flip: 1,
    bank: 0,
    headRot: 0,
    headTilt: 0,
    tiltT: 0,
    tiltDir: 1,
    nextTilt: 3,
    squash: 0,
    squashV: 0,
    blink: 0,
    blinkLen: 0.16,
    nextBlink: 2,
    doubleBlink: false,
    ruffle: 0,
    nextRuffle: 6,
    sweep: 0,
    fold: 1,
    feet: 1,
    phase: 0,
    amp: 0,
    glide: 0,
    nextGlide: 1.2,
  };
}

export type OwlInput = {
  /** Milliseconds since the last step. */
  dtMs: number;
  /** A monotonic clock, in milliseconds; only the breathing reads it. */
  nowMs: number;
  target: { x: number; y: number };
  reducedMotion: boolean;
  scanning: boolean;
  size: OwlSize;
  /** On a perch: a slow blink every few seconds and a head turn about every eight. */
  onPerch?: boolean;
};

/** What the owl looks like this frame, in the units the SVG transforms use (degrees, pixels, scale factors). */
type OwlPose = {
  flying: boolean;
  /** The top-left corner of the owl's box, in viewport pixels. */
  x: number;
  y: number;
  rootRotate: number;
  rootScaleX: number;
  rootScaleY: number;
  bodyScaleX: number;
  bodyScaleY: number;
  headY: number;
  headRotate: number;
  pupilX: number;
  pupilY: number;
  wingRotate: number;
  wingScaleX: number;
  tailY: number;
  tailRotate: number;
  tailScaleX: number;
  feetY: number;
  feetScaleY: number;
  lidScaleY: number;
  sweepRotate: number;
};

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
/** A smoothing factor that does not depend on the frame rate: `rate` is the fraction left after one second. */
const smooth = (rate: number, seconds: number) => 1 - Math.pow(rate, seconds);

/**
 * Advances the owl by one frame, changing `state` in place, and returns its pose.
 * `random` is injected so a test can make the glides, tilts, ruffles and blinks
 * deterministic.
 */
export function stepOwl(state: OwlState, input: OwlInput, random: () => number = Math.random): OwlPose {
  const { target, reducedMotion: still, scanning, size } = input;
  const onPerch = input.onPerch === true;
  const s = clamp(input.dtMs, 0, MAX_STEP_MS) / 1000;
  const t = input.nowMs / 1000;
  const feetY = feetOffset(size);

  // Spring-damper follow, slightly underdamped so it overshoots a little.
  if (still) {
    state.x = target.x;
    state.y = target.y;
    state.vx = 0;
    state.vy = 0;
  } else {
    const damping = 2 * Math.sqrt(SPRING_STIFFNESS) * SPRING_DAMPING_RATIO;
    state.vx += (SPRING_STIFFNESS * (target.x - state.x) - damping * state.vx) * s;
    state.vy += (SPRING_STIFFNESS * (target.y - state.y) - damping * state.vy) * s;
    const capped = Math.hypot(state.vx, state.vy);
    if (capped > MAX_SPEED) {
      state.vx *= MAX_SPEED / capped;
      state.vy *= MAX_SPEED / capped;
    }
    const dx = state.vx * s;
    const dy = state.vy * s;
    const reach = Math.hypot(dx, dy);
    const carry = reach > MAX_FRAME_PX ? MAX_FRAME_PX / reach : 1;
    state.x += dx * carry;
    state.y += dy * carry;
  }
  const speed = Math.hypot(state.vx, state.vy);

  // Perched and flying, with a hysteresis so it does not chatter at the boundary.
  const before = state.mode;
  if (state.mode === "perched") {
    if (speed > TAKEOFF_SPEED) state.mode = "flying";
  } else {
    state.still = speed < LANDING_SPEED ? state.still + s : 0;
    if (state.still > LANDING_AFTER_S) state.mode = "perched";
  }
  // A stretch as it takes off, a squash as it lands.
  if (before !== state.mode && !still) state.squashV += state.mode === "flying" ? -5.5 : 6.5;
  state.squashV += (-90 * state.squash - 9 * state.squashV) * s;
  state.squash += state.squashV * s;
  const flying = state.mode === "flying";

  // Facing: flip towards the way it moves.
  if (Math.abs(state.vx) > 70) state.face = state.vx > 0 ? 1 : -1;
  state.flip = still ? state.face : lerp(state.flip, state.face, smooth(0.0005, s));

  // Banking into the velocity.
  const bankTarget = flying ? clamp(state.vx * 0.022, -24, 24) + clamp(state.vy * 0.006, -6, 6) * state.face : 0;
  state.bank = lerp(state.bank, bankTarget, smooth(0.01, s));

  // Wings: a flap scaled to speed, with random glides between.
  state.fold = lerp(state.fold, flying ? 0 : 1, smooth(0.002, s));
  if (flying) {
    state.nextGlide -= s;
    if (state.glide > 0) state.glide -= s;
    else if (state.nextGlide <= 0 && speed < 900) {
      state.glide = 0.45 + random() * 0.4;
      state.nextGlide = 1 + random() * 1.6;
    }
  }
  const ampTarget = flying ? (state.glide > 0 ? 0.12 : clamp(0.35 + speed / 700, 0.35, 1)) : 0;
  state.amp = lerp(state.amp, ampTarget, smooth(0.003, s));
  state.phase += s * (state.glide > 0 ? 2 : 5 + clamp(speed / 160, 0, 7)) * Math.PI * 2;
  const flap = Math.sin(state.phase) * state.amp * 48;
  const spread = (1 - state.fold) * 55;
  const wing = still ? 0 : spread + flap * (1 - state.fold);

  // The head tracks the cursor on its own, clamped and lagging.
  const headY = state.y - feetY * 0.85;
  const look = clamp((target.x - state.x) * 0.12 * state.flip, -HEAD_LIMIT_DEG, HEAD_LIMIT_DEG);
  state.headRot = lerp(state.headRot, look - state.bank * 0.6, smooth(0.02, s));

  // Perched: a curious head tilt with a small bob, a feather ruffle, breathing. With reduced motion, none of it: the owl is a picture.
  state.nextTilt -= s;
  if (state.nextTilt <= 0) {
    state.tiltT = 1.1;
    state.tiltDir = random() < 0.5 ? -1 : 1;
    state.nextTilt = onPerch ? 7 + random() * 2 : 3.5 + random() * 5;
  }
  if (state.tiltT > 0) state.tiltT -= s;
  const tilt = state.tiltT > 0 && !flying ? Math.sin(clamp(1 - state.tiltT / 1.1, 0, 1) * Math.PI) * 18 * state.tiltDir : 0;
  state.headTilt = lerp(state.headTilt, tilt, smooth(0.001, s));
  const bobY = !flying && !still && state.tiltT > 0 ? -Math.sin(clamp(1 - state.tiltT / 1.1, 0, 1) * Math.PI * 2) * 2 : 0;
  state.nextRuffle -= s;
  if (state.nextRuffle <= 0 && !flying) {
    state.ruffle = 0.35;
    state.nextRuffle = 6 + random() * 7;
  }
  if (state.ruffle > 0) state.ruffle -= s;
  const ruffle = state.ruffle > 0 && !still ? Math.sin(state.ruffle * 60) * 0.03 : 0;
  const breathe = flying || still ? 0 : Math.sin(t * 2.2) * 0.025;

  // Blinks, now and then a double.
  state.nextBlink -= s;
  if (state.nextBlink <= 0) {
    state.blinkLen = onPerch ? 0.28 : 0.16;
    state.blink = state.blinkLen;
    state.nextBlink = state.doubleBlink ? 0.22 : onPerch ? 3 + random() * 3 : 2.2 + random() * 4;
    state.doubleBlink = !state.doubleBlink && random() < 0.25;
  }
  if (state.blink > 0) state.blink -= s;
  const lid = state.blink > 0 ? Math.sin((1 - state.blink / state.blinkLen) * Math.PI) : 0;

  // The radar sweep in the cyan eye turns only while it is scanning.
  if (scanning && !still) state.sweep = (state.sweep + s * 400) % 360;

  // Feet tuck in flight.
  state.feet = lerp(state.feet, flying ? 0 : 1, smooth(0.004, s));
  const hover = flying && !still ? Math.sin(state.phase) * state.amp * 3 : 0;

  const stretch = (value: number) => clamp(value, 1 - MAX_STRETCH, 1 + MAX_STRETCH);
  const scaleX = stretch((1 + state.squash * 0.08) * (1 + ruffle));
  const scaleY = stretch(1 - state.squash * 0.1);
  const pupilY = clamp((target.y - headY) * 0.01, -2, 2);
  return {
    flying,
    x: state.x - size.width / 2,
    y: state.y - feetY + hover + bobY,
    rootRotate: still ? 0 : state.bank,
    rootScaleX: state.flip * scaleX,
    rootScaleY: scaleY,
    bodyScaleX: 1 + breathe * 0.5,
    bodyScaleY: 1 + breathe,
    headY: -breathe * 12,
    headRotate: still ? 0 : state.headRot * 0.35 + state.headTilt,
    pupilX: clamp(state.headRot * 0.09, -2.5, 2.5),
    pupilY,
    wingRotate: wing,
    wingScaleX: 1 - state.fold * 0.12,
    tailY: (1 - state.feet) * -3,
    tailRotate: -state.bank * 0.5,
    tailScaleX: 1 + (1 - state.feet) * 0.25,
    feetY: (1 - state.feet) * -6,
    feetScaleY: 0.4 + state.feet * 0.6,
    lidScaleY: still ? 0 : lid,
    sweepRotate: state.sweep,
  };
}

/** The CSS transform of each moving part, ready to assign to `style.transform`. */
type OwlTransforms = {
  box: string;
  root: string;
  body: string;
  head: string;
  pupil: string;
  wings: string;
  tail: string;
  feet: string;
  lids: string;
  sweep: string;
};

export function poseTransforms(pose: OwlPose): OwlTransforms {
  const n = (value: number, digits = 2) => value.toFixed(digits);
  return {
    box: `translate3d(${n(pose.x, 1)}px,${n(pose.y, 1)}px,0)`,
    root: `rotate(${n(pose.rootRotate)}deg) scale(${n(pose.rootScaleX, 3)},${n(pose.rootScaleY, 3)})`,
    body: `scale(${n(pose.bodyScaleX, 3)},${n(pose.bodyScaleY, 3)})`,
    head: `translate(0px,${n(pose.headY)}px) rotate(${n(pose.headRotate)}deg)`,
    pupil: `translate(${n(pose.pupilX)}px,${n(pose.pupilY)}px)`,
    wings: `rotate(${n(pose.wingRotate)}deg) scale(${n(pose.wingScaleX, 3)},1)`,
    tail: `translate(0px,${n(pose.tailY, 1)}px) rotate(${n(pose.tailRotate)}deg) scale(${n(pose.tailScaleX, 3)},1)`,
    feet: `translate(0px,${n(pose.feetY, 1)}px) scale(1,${n(pose.feetScaleY, 3)})`,
    lids: `scale(1,${n(pose.lidScaleY, 3)})`,
    sweep: `rotate(${n(pose.sweepRotate, 1)}deg)`,
  };
}
