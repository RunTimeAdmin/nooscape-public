import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  IdCard,
  MessageSquareText,
  UserRoundPlus,
} from "lucide-react";
import { listedChainLabel } from "@shared/chains";
import { formatObserved, type ChainWorldEvent, type WorldKey } from "@/lib/chainExplorerModel";
import "./ChainEventRail.css";

type ChainEventRailProps = {
  events: readonly ChainWorldEvent[];
  activeId: string | null;
  onSelect: (id: string) => void;
  playing: boolean;
  onTogglePlayback: () => void;
  motionReduced: boolean;
  status: "loading" | "ready" | "unavailable" | "unsupported" | "unmeasured";
  chain: WorldKey;
  coverage: string;
};

const EVENT_ICONS = {
  register: UserRoundPlus,
  transfer: ArrowLeftRight,
  profile: IdCard,
  feedback: MessageSquareText,
} as const;

const EVENT_KIND_LABELS = {
  register: "Registration",
  transfer: "Transfer",
  profile: "Profile",
  feedback: "Feedback",
} as const;

function EmptyState({
  chain,
  status,
}: Pick<ChainEventRailProps, "chain" | "status">) {
  if ((chain === "bnb" || chain === "base") && status === "unsupported") {
    return (
      <div className="cw-event-empty" role="status">
        <span className="cw-event-empty-kicker">Global feed unavailable</span>
        <p>
          No global {chain === "bnb" ? "BNB" : "Base"} activity feed is
          published. No event is shown in its place. The dated registry census
          describes what the {listedChainLabel(chain)} registry holds.
        </p>
      </div>
    );
  }

  if (chain === "ethereum" && status === "unsupported") {
    return (
      <div className="cw-event-empty" role="status">
        <span className="cw-event-empty-kicker">Global feed unavailable</span>
        <p>
          No global Ethereum activity feed is published. No event is shown in
          its place.
        </p>
      </div>
    );
  }

  if (chain === "arc" && status === "unsupported") {
    return (
      <div className="cw-event-empty" role="status">
        <span className="cw-event-empty-kicker">Global feed unavailable</span>
        <p>
          No global Arc activity feed is published. No event is shown in its
          place. Select an entry to see the events recorded for it.
        </p>
      </div>
    );
  }

  if (status === "unmeasured") {
    return (
      <div className="cw-event-empty" role="status">
        <span className="cw-event-empty-kicker">
          Entry activity not measured
        </span>
        <p>
          No activity sample is recorded for this entry. No event count is shown
          in its place.
        </p>
      </div>
    );
  }

  const message =
    status === "loading"
      ? "Reading the recorded activity feed…"
      : status === "unavailable"
        ? "Recorded activity is unavailable. No event count is shown in its place."
        : status === "unsupported"
          ? `${listedChainLabel(chain)} activity is not supported by this feed. No event count is shown in its place.`
          : "No recorded activity in this feed. This is not a live zero.";

  return (
    <div className="cw-event-empty" role="status">
      <span className="cw-event-empty-kicker">No events displayed</span>
      <p>{message}</p>
    </div>
  );
}

function KindIcon({ kind }: { kind: ChainWorldEvent["kind"] }) {
  const Icon = EVENT_ICONS[kind];
  return <Icon aria-hidden="true" size={16} strokeWidth={1.7} />;
}

export function ChainEventRail({
  events,
  activeId,
  onSelect,
  playing,
  onTogglePlayback,
  motionReduced,
  status,
  chain,
  coverage,
}: ChainEventRailProps) {
  const activeIndex = events.findIndex(event => event.id === activeId);
  const selected = activeIndex >= 0 ? events[activeIndex] : null;
  const hasEvents = events.length > 0;
  const timelineIndex = activeIndex >= 0 ? activeIndex : 0;
  const newestFirst = [...events].reverse();

  const selectAt = (index: number) => {
    const event = events[index];
    if (event) onSelect(event.id);
  };

  return (
    <section
      className="cw-event-rail"
      data-cw-chain={chain}
      aria-labelledby="cw-event-rail-heading"
    >
      <header className="cw-event-header">
        <div>
          <p className="cw-event-eyebrow">Recorded activity</p>
          <h2 id="cw-event-rail-heading">Historical chain activity</h2>
          <p className="cw-event-source">HISTORICAL REPLAY · NOT LIVE</p>
        </div>
        <div
          className="cw-event-meta"
          aria-label={`${listedChainLabel(chain)} feed coverage`}
        >
          <span className="cw-event-chain">{listedChainLabel(chain)}</span>
          <span className="cw-event-coverage">{coverage}</span>
          {status === "ready" && hasEvents && (
            <span className="cw-event-count">
              {events.length} events in this feed
            </span>
          )}
        </div>
      </header>

      {hasEvents ? (
        <div className="cw-event-layout">
          <div className="cw-event-inspector">
            <div
              className="cw-event-controls"
              aria-label="Historical replay controls"
            >
              <button
                type="button"
                className="cw-event-control cw-event-control-primary"
                onClick={onTogglePlayback}
                disabled={motionReduced}
                aria-label={
                  motionReduced
                    ? "Replay is disabled by reduced-motion preference"
                    : playing
                      ? "Pause historical replay"
                      : "Play historical replay"
                }
              >
                {playing ? (
                  <CirclePause aria-hidden="true" size={17} />
                ) : (
                  <CirclePlay aria-hidden="true" size={17} />
                )}
                <span>
                  {motionReduced
                    ? "Reduced motion · select events manually"
                    : playing
                      ? "Pause replay"
                      : "Play replay"}
                </span>
              </button>
              <div className="cw-event-step-controls">
                <button
                  type="button"
                  className="cw-event-control cw-event-control-icon"
                  onClick={() => selectAt(activeIndex - 1)}
                  disabled={activeIndex <= 0}
                  aria-label="Select previous recorded event"
                >
                  <ChevronLeft aria-hidden="true" size={18} />
                </button>
                <button
                  type="button"
                  className="cw-event-control cw-event-control-icon"
                  onClick={() =>
                    selectAt(activeIndex < 0 ? 0 : activeIndex + 1)
                  }
                  disabled={
                    activeIndex < 0
                      ? events.length === 0
                      : activeIndex >= events.length - 1
                  }
                  aria-label="Select next recorded event"
                >
                  <ChevronRight aria-hidden="true" size={18} />
                </button>
              </div>
            </div>

            <div className="cw-event-timeline">
              <div className="cw-event-timeline-labels">
                <span>Older</span>
                <span>
                  {activeIndex >= 0
                    ? `${activeIndex + 1} / ${events.length}`
                    : `Select 1 / ${events.length}`}
                </span>
                <span>Newer</span>
              </div>
              <input
                className="cw-event-range"
                type="range"
                min={0}
                max={events.length - 1}
                step={1}
                value={timelineIndex}
                onChange={event => selectAt(Number(event.currentTarget.value))}
                aria-label="Select a recorded event in chronological order"
              />
            </div>

            {selected ? (
              <article
                className="cw-event-selected"
                aria-label={`Selected event: ${selected.name}`}
              >
                <div className="cw-event-selected-heading">
                  <span className="cw-event-kind cw-event-kind-selected">
                    <KindIcon kind={selected.kind} />
                    {EVENT_KIND_LABELS[selected.kind]}
                  </span>
                  <span className="cw-event-selected-position">
                    Event {activeIndex + 1} of {events.length}
                  </span>
                </div>
                <h3 title={selected.name}>{selected.name}</h3>
                <p
                  className="cw-event-selected-protocol"
                  title={selected.protocol}
                >
                  {selected.protocol}
                </p>
                <dl className="cw-event-facts">
                  <div>
                    <dt>Transaction hash / signature</dt>
                    <dd className="cw-event-mono" title={selected.transaction}>
                      {selected.transaction}
                    </dd>
                  </div>
                  <div>
                    <dt>Recorded from</dt>
                    <dd
                      className="cw-event-address"
                      title={selected.from ?? "Not recorded"}
                    >
                      {selected.from ?? "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt>Recorded to</dt>
                    <dd
                      className="cw-event-address"
                      title={selected.to ?? "Not recorded"}
                    >
                      {selected.to ?? "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt>Nooscape observed time</dt>
                    <dd>
                      {selected.observedAt ? (
                        <time dateTime={selected.observedAt}>
                          {formatObserved(selected.observedAt) ?? selected.observedAt}
                        </time>
                      ) : (
                        "Not recorded"
                      )}
                    </dd>
                  </div>
                </dl>
                <a
                  className="cw-event-entry-link"
                  href={`/agents/${encodeURIComponent(selected.entryId)}`}
                >
                  Inspect recorded entry
                  <ChevronRight aria-hidden="true" size={15} />
                </a>
              </article>
            ) : (
              <div className="cw-event-selection-note">
                Select an event to inspect its recorded facts.
              </div>
            )}
          </div>

          <div className="cw-event-feed-column">
            <div className="cw-event-feed-heading">
              <span className="cw-event-eyebrow">Newest first</span>
              <span className="cw-event-feed-count">
                {events.length} events in this feed
              </span>
            </div>
            <ol
              className="cw-event-list"
              aria-label="Recorded events, newest first"
            >
              {newestFirst.map(event => {
                const isSelected = event.id === activeId;
                return (
                  <li
                    key={event.id}
                    className={`cw-event-item${isSelected ? " cw-event-item-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="cw-event-item-select"
                      onClick={() => onSelect(event.id)}
                      aria-pressed={isSelected}
                      aria-label={`Select ${event.name}, ${event.label}`}
                    >
                      <span className="cw-event-item-icon">
                        <KindIcon kind={event.kind} />
                      </span>
                      <span className="cw-event-item-main">
                        <span
                          className="cw-event-item-title"
                          title={event.name}
                        >
                          {event.name}
                        </span>
                        <span
                          className="cw-event-item-label"
                          title={event.label}
                        >
                          {event.label}
                        </span>
                        <span
                          className="cw-event-item-subline"
                          title={event.protocol}
                        >
                          {EVENT_KIND_LABELS[event.kind]} · {event.protocol}
                        </span>
                      </span>
                      <span
                        className="cw-event-height"
                        title={`${event.heightLabel} ${event.height}`}
                      >
                        <span>{event.heightLabel.replace(/^Observation /, "")}</span>
                        <strong>{event.height}</strong>
                      </span>
                    </button>
                    <a
                      className="cw-event-item-link"
                      href={`/agents/${encodeURIComponent(event.entryId)}`}
                    >
                      Entry <ChevronRight aria-hidden="true" size={13} />
                    </a>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ) : (
        <EmptyState chain={chain} status={status} />
      )}
    </section>
  );
}

export type { ChainEventRailProps };
