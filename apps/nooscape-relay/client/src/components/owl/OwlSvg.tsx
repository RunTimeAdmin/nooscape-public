import { useId } from "react";

/**
 * The owl, drawn in layers so each can move on its own. The rig finds the moving
 * parts by `data-owl`, and their pivots are set here, in the artwork's own units
 * (`transform-box: view-box`, in index.css). The viewBox is 120 by 140 and the
 * feet sit at y = 50, which is what `feetOffset` in owlRig.ts assumes.
 */
export function OwlSvg() {
  const id = useId().replace(/:/g, "");
  const wingPath = "M-17 -6 L-36 6 L-38 30 L-26 44 L-14 30 Z";
  const wingMarks = "M-30 12 L-22 18 L-30 24 M-33 22 L-24 30 M-22 6 L-18 14";
  return (
    <svg viewBox="-60 -82 120 140" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2a6b" />
          <stop offset="1" stopColor="#0c1440" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22307a" />
          <stop offset="1" stopColor="#3b1f7a" />
        </linearGradient>
        <radialGradient id={`${id}-radar`}>
          <stop offset="0" stopColor="#a5f3fc" />
          <stop offset=".35" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0e3a5a" />
        </radialGradient>
        <clipPath id={`${id}-radar-clip`}>
          <circle cx="13" cy="-30" r="10" />
        </clipPath>
      </defs>
      <g data-owl="root" style={{ transformOrigin: "0px 44px" }}>
        <g data-owl="tail" style={{ transformOrigin: "0px 38px" }}>
          <path d="M-9 38 L0 56 L9 38 Z" fill="#15205a" />
          <path d="M-3 40 L0 52 L3 40" stroke="#22d3ee" strokeWidth="1.2" fill="none" />
          <path d="M-9 38 L-12 50 L-2 42Z M9 38 L12 50 L2 42Z" fill="#2a1f6e" />
        </g>
        <g data-owl="wing" style={{ transformOrigin: "-17px -6px" }}>
          <path d={wingPath} fill={`url(#${id}-wing)`} stroke="#0a0f2c" strokeWidth="1" />
          <path d={wingMarks} stroke="#22d3ee" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
        <g transform="scale(-1,1)">
          <g data-owl="wing" style={{ transformOrigin: "-17px -6px" }}>
            <path d={wingPath} fill={`url(#${id}-wing)`} stroke="#0a0f2c" strokeWidth="1" />
            <path d={wingMarks} stroke="#8b5cf6" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </g>
        </g>
        <g data-owl="feet" style={{ transformOrigin: "0px 44px" }}>
          <path d="M-8 44 l-3 6 M-8 44 l0 7 M-8 44 l3 6 M8 44 l-3 6 M8 44 l0 7 M8 44 l3 6" stroke="#22d3ee" strokeWidth="1.8" strokeLinecap="round" />
        </g>
        <g data-owl="body" style={{ transformOrigin: "0px 44px" }}>
          <path d="M-20 -8 Q-24 20 -12 42 L12 42 Q24 20 20 -8 Z" fill={`url(#${id}-body)`} stroke="#0a0f2c" strokeWidth="1" />
          <path d="M-10 4 L-4 10 L-10 16 M10 4 L4 10 L10 16 M-8 20 L0 26 L8 20 M-6 30 L0 35 L6 30" stroke="#22d3ee" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity=".9" />
          <path d="M12 8 L17 20 L12 32" stroke="#8b5cf6" strokeWidth="1.5" fill="none" />
        </g>
        <g data-owl="head" style={{ transformOrigin: "0px -10px" }}>
          <path d="M-24 -50 L-14 -40 L14 -40 L24 -50 L26 -28 L18 -12 L0 -6 L-18 -12 L-26 -28 Z" fill="#16215e" stroke="#0a0f2c" strokeWidth="1" />
          <path d="M-24 -50 L-18 -38 M24 -50 L18 -38" stroke="#22d3ee" strokeWidth="1.6" />
          <g>
            <path d="M-17 -44 Q-15 -62 0 -63 Q15 -62 17 -44 Z" fill="#1d2a78" />
            <path d="M-20 -44 L22 -44 L28 -40 L-18 -41 Z" fill="#101a4e" />
            <path d="M-12 -46 Q-8 -60 6 -61" stroke="#22d3ee" strokeWidth="1.4" fill="none" />
            <path d="M-4 -56 L2 -52 L-5 -50Z" fill="#8b5cf6" />
            <circle cx="0" cy="-63" r="2" fill="#22d3ee" />
          </g>
          <circle cx="-13" cy="-30" r="10" fill="#dbe7ff" />
          <circle cx="-13" cy="-30" r="10" fill="none" stroke="#5b6bb5" strokeWidth="2.5" />
          <g data-owl="pupil">
            <circle cx="-13" cy="-30" r="5.5" fill="#22d3ee" />
            <circle cx="-13" cy="-30" r="2.6" fill="#06102e" />
            <circle cx="-11.5" cy="-31.5" r="1.1" fill="#fff" />
          </g>
          <path d="M-23 -30 L-29 -30 L-29 -27" stroke="#22d3ee" strokeWidth="1.6" fill="none" />
          <circle cx="13" cy="-30" r="10" fill={`url(#${id}-radar)`} />
          <circle data-owl-glow="" cx="13" cy="-30" r="13" fill="none" stroke="#22d3ee" strokeWidth="1" opacity=".35" />
          <g clipPath={`url(#${id}-radar-clip)`}>
            <g data-owl="sweep" style={{ transformOrigin: "13px -30px" }}>
              <path d="M13 -30 L13 -41 A11 11 0 0 1 22 -36 Z" fill="#e0fdff" opacity=".7" />
            </g>
          </g>
          <circle cx="13" cy="-30" r="6" fill="none" stroke="#06283d" strokeWidth=".7" />
          <path d="M3 -30 H23 M13 -40 V-20" stroke="#06283d" strokeWidth=".5" />
          <circle cx="13" cy="-30" r="1.8" fill="#fff" />
          <circle cx="13" cy="-30" r="10" fill="none" stroke="#22d3ee" strokeWidth="2.5" />
          <path d="M23 -30 H30" stroke="#22d3ee" strokeWidth="1.6" />
          <path data-owl="lid" style={{ transformOrigin: "-13px -40px" }} d="M-24 -40 H-2 V-19 H-24Z" fill="#16215e" />
          <path data-owl="lid" style={{ transformOrigin: "13px -40px" }} d="M2 -40 H24 V-19 H2Z" fill="#16215e" />
          <path d="M-3 -21 L3 -21 L0 -12 Z" fill="#4c5cc4" stroke="#22d3ee" strokeWidth=".6" />
        </g>
      </g>
    </svg>
  );
}
