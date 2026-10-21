type BotVariant = "round" | "square";

// Deterministic per-agent bot look: the id hash picks the eye shape so each
// record keeps the same mini-bot everywhere it renders — field nodes, search
// suggestions, and the public agent page all share this one character.
function botVariantFor(agentId: string): BotVariant {
  let hash = 7;
  for (const character of agentId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? "round" : "square";
}

export function AgentBotAvatar({ agentId, tone }: { agentId: string; tone: string }) {
  const roundEyes = botVariantFor(agentId) === "round";
  return <svg className="bot-avatar" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
    <line x1="18" y1="7.5" x2="18" y2="3.4" stroke={tone} strokeWidth="1.5" className="bot-antenna" />
    <circle cx="18" cy="3" r="1.7" fill={tone} className="bot-antenna-tip" />
    <rect x="8.5" y="7.5" width="19" height="16.5" rx="5" fill="#0A130D" stroke={tone} strokeWidth="1.6" className="bot-head" />
    <rect x="4.8" y="12.5" width="3" height="6" rx="1.5" fill="#0A130D" stroke={tone} strokeWidth="1.3" className="bot-ear" />
    <rect x="28.2" y="12.5" width="3" height="6" rx="1.5" fill="#0A130D" stroke={tone} strokeWidth="1.3" className="bot-ear" />
    <g className="bot-eyes">
      {roundEyes
        ? <>
            <circle cx="14" cy="14.6" r="3.6" fill={tone} opacity="0.26" className="bot-eye-glow" />
            <circle cx="22" cy="14.6" r="3.6" fill={tone} opacity="0.26" className="bot-eye-glow" />
            <circle cx="14" cy="14.6" r="2.1" fill={tone} className="bot-eye" />
            <circle cx="22" cy="14.6" r="2.1" fill={tone} className="bot-eye" />
          </>
        : <>
            <rect x="10.6" y="11.6" width="6.8" height="6" rx="1.6" fill={tone} opacity="0.22" className="bot-eye-glow" />
            <rect x="18.6" y="11.6" width="6.8" height="6" rx="1.6" fill={tone} opacity="0.22" className="bot-eye-glow" />
            <rect x="12" y="12.8" width="4" height="3.6" rx="1" fill={tone} className="bot-eye" />
            <rect x="20" y="12.8" width="4" height="3.6" rx="1" fill={tone} className="bot-eye" />
          </>}
    </g>
    <rect x="13.5" y="19.6" width="9" height="1.8" rx="0.9" fill={tone} opacity="0.75" className="bot-mouth" />
  </svg>;
}
