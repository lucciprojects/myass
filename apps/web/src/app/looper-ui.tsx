"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LooperAction, LooperLayer, LooperState } from "@myass/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getLooper, postLooper } from "./api-client";
import styles from "./looper.module.css";

// The playhead and a countdown move continuously, so state has to be polled
// while anything is running and left alone when nothing is. 100ms is ten
// updates a second: smooth enough to look continuous, and cheap enough not to
// crowd the agent's control socket, which the chain shares.
const ACTIVE_POLL_MS = 100;

// A level drag would otherwise be one request per pixel, queued against the same
// control connection the chain uses. The optimistic update already moved the
// thumb, so the slider still tracks the pointer.
const LEVEL_DEBOUNCE_MS = 120;

// The max-cap choices offered per layer. The agent clamps to these from the
// global cap, so 16 is only a default; a boot take can stop shorter by hand.
const MAX_OPTIONS = [2, 4, 8, 16];

const QUERY_KEY = ["looper"] as const;

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

// Seconds left shown as 3, 2, 1. A countdown of exactly 3.0 is the turn the
// arm lands (so "3" is right there), and anything under a second is "1".
function countdownTick(countdown: number): number {
  return Math.max(1, Math.ceil(countdown));
}

/**
 * What the agent is about to report, so a button reacts on the click rather
 * than a round trip later. A looper is a live instrument: the gap between
 * pressing record and the take starting is audible as a late entry, so waiting
 * for the response makes the rig feel broken even when it is working.
 *
 * This is a prediction, not a guess about the audio. The next poll overwrites it
 * with the truth, so being wrong corrects itself.
 */
function predict(state: LooperState, action: LooperAction): LooperState {
  const cleared = (layer: LooperLayer): LooperLayer => ({
    ...layer,
    playing: false,
    recording: false,
    waiting: false,
    countdown: 0,
    seconds: 0,
    samples: 0,
    position: 0,
    truncated: false,
  });

  const withLayers = (
    layers: LooperLayer[],
    overrides: { paused?: boolean } = {},
  ): LooperState => ({
    maxSeconds: state.maxSeconds,
    countdownSeconds: state.countdownSeconds,
    transportSeconds: state.transportSeconds,
    paused: state.paused,
    sampleRate: state.sampleRate,
    bpm: state.bpm,
    beatsPerBar: state.beatsPerBar,
    bars: state.bars,
    click: state.click,
    loopSamples: state.loopSamples,
    revision: state.revision,
    layers,
    ...overrides,
  });

  if (action.action === "play" && action.layer === undefined) {
    // The master key freeze-pauses the whole transport: flip the flag and the
    // loops hold exactly where the clock stopped them.
    return withLayers(state.layers, { paused: !state.paused });
  }

  if (action.action === "clear" && action.layer === undefined) {
    return withLayers(state.layers.map(cleared));
  }

  if (action.action === "undo") {
    // The agent drops the highest numbered non-empty layer, so predict that
    // rather than whichever one the player last looked at.
    const layers = [...state.layers];

    for (let i = layers.length - 1; i >= 0; i -= 1) {
      if (layers[i].seconds > 0) {
        layers[i] = cleared(layers[i]);
        break;
      }
    }

    return withLayers(layers);
  }

  if (action.layer === undefined) {
    return state;
  }

  const target = state.layers[action.layer];

  if (!target) {
    return state;
  }

  const layers = [...state.layers];

  switch (action.action) {
    case "record":
      // Arming schedules the take after the countdown. The layer hears its own
      // old pass during an overdub countdown, so playing predicts that; a
      // boot take stays silent until the countdown lands.
      target.recording = false;
      target.waiting = true;
      target.countdown = state.countdownSeconds;
      target.truncated = false;
      target.playing = target.seconds > 0;
      break;

    case "stop":
      // While waiting, stop cancels the arm without touching the layer. While
      // recording, a first pass takes its length from how far it got and an
      // overdub keeps the length it already had.
      if (target.waiting) {
        target.waiting = false;
        target.countdown = 0;
        target.playing = target.seconds > 0;
        break;
      }

      if (target.seconds === 0) {
        target.seconds = target.position;
      }

      target.recording = false;
      target.waiting = false;
      target.countdown = 0;
      target.position = 0;
      target.playing = target.seconds > 0;
      break;

    case "play":
      if (target.seconds > 0) {
        target.playing = !target.playing;
        target.position = 0;
      }
      break;

    case "mute":
      target.muted = !target.muted;
      break;

    case "level":
      target.level = action.value ?? target.level;
      break;

    case "chain":
      // Pasting puts the live board onto the layer, so the two now match.
      target.chainCurrent = true;
      break;

    case "clear":
      layers[action.layer] = cleared(target);
      return withLayers(layers);
  }

  layers[action.layer] = target;
  return withLayers(layers);
}

function statusOf(layer: LooperLayer): { text: string; tone: string } {
  if (layer.waiting) {
    return { text: "ARMED", tone: styles.statusWarn };
  }

  if (layer.recording) {
    return { text: "REC", tone: styles.statusRec };
  }

  if (layer.truncated) {
    return { text: "CUT", tone: styles.statusWarn };
  }

  if (layer.seconds === 0) {
    return { text: "EMPTY", tone: "" };
  }

  if (layer.muted) {
    return { text: "MUTE", tone: "" };
  }

  if (layer.playing) {
    return { text: "PLAY", tone: styles.statusPlay };
  }

  return { text: "HELD", tone: "" };
}

function LayerRow({
  layer,
  maxSeconds,
  paused,
  onAction,
}: {
  layer: LooperLayer;
  maxSeconds: number;
  paused: boolean;
  onAction: (action: LooperAction) => void;
}) {
  const status = statusOf(layer);
  const empty = layer.seconds === 0 && !layer.recording && !layer.waiting;

  // What the next record on this row will use. Held locally so picking a length
  // does not fire a request by itself and so it survives the round trips that
  // report the agent's clamp of a later take back to the cycle length.
  const [max, setMax] = useState(() =>
    layer.max > 0 ? layer.max : maxSeconds,
  );

  // Whether the MAX picker menu is open. A stock <select> popup is drawn by
  // the OS and cannot be themed, so it is a real little menu instead.
  const [maxOpen, setMaxOpen] = useState(false);

  // The menu floats above the whole faceplate via a portal: an absolutely
  // positioned child would be trapped under later rows (empty rows stack via
  // opacity) and clipped by the panel's overflow, so it is anchored to the
  // trigger's screen position instead.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<{
    top: number;
    right: number;
  } | null>(null);

  useEffect(() => {
    if (!maxOpen) {
      setMenuAnchor(null);
      return;
    }

    const trigger = triggerRef.current;

    if (!trigger) {
      return;
    }

    const place = () => {
      const rect = trigger.getBoundingClientRect();
      setMenuAnchor({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    };

    place();

    // The page can scroll under an open menu, so it follows the trigger;
    // capturing picks up element scrolls as well as the window's.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);

    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          setMaxOpen(false);
        }

        return;
      }

      const target = event.target;

      if (
        target instanceof Node &&
        menuRef.current &&
        !menuRef.current.contains(target) &&
        trigger &&
        !trigger.contains(target)
      ) {
        setMaxOpen(false);
      }
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);

    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [maxOpen]);

  // The track is the whole 0..max window, so lengths read against each other.
  // The playhead is the shared transport phase, so every row's head sweeps the
  // same beat; while a boot take is being captured it shows how far the take
  // has got instead.
  const fill = Math.min(100, (layer.seconds / maxSeconds) * 100);
  const head = Math.min(100, (layer.position / maxSeconds) * 100);

  // The REC button is three states: REC arms (with its countdown), STOP ends a
  // take, and CANCEL abandons an arm that is still counting down.
  const rec = layer.recording
    ? { label: "STOP", action: "stop" as const, tone: styles.actionRec }
    : layer.waiting
      ? { label: "CANCEL", action: "stop" as const, tone: styles.actionCancel }
      : { label: "REC", action: "record" as const, tone: "" };

  return (
    <div
      className={[
        styles.row,
        empty ? styles.rowEmpty : "",
        layer.recording ? styles.rowRecording : "",
        layer.waiting ? styles.rowWaiting : "",
      ].join(" ")}
    >
      <span className={styles.index}>{layer.index + 1}</span>

      <div className={styles.track}>
        <div
          className={[
            styles.fill,
            layer.recording
              ? styles.fillRecording
              : layer.muted
                ? styles.fillMuted
                : layer.playing
                  ? styles.fillPlaying
                  : "",
          ].join(" ")}
          style={{ width: `${fill}%` }}
        />

        {(layer.seconds > 0 || layer.recording || layer.waiting) && (
          <span className={styles.head} style={{ left: `${head}%` }} />
        )}
      </div>

      <span className={styles.length}>
        {layer.seconds > 0 ? formatSeconds(layer.seconds) : "—"}
      </span>

      <span className={[styles.status, status.tone].join(" ")}>
        {status.text}
      </span>

      {layer.waiting && (
        <span className={styles.countdown} aria-label="Recording countdown">
          {countdownTick(layer.countdown)}
        </span>
      )}

      <div className={styles.actions}>
        <button
          className={[styles.action, rec.tone].join(" ")}
          onClick={() =>
            onAction(
              rec.label === "REC"
                ? { action: "record", layer: layer.index, max }
                : { action: rec.action, layer: layer.index },
            )
          }
          disabled={rec.label === "REC" && paused}
          title={
            rec.label === "REC" && paused
              ? "Unpause before arming a take"
              : undefined
          }
          aria-label={
            rec.label === "REC"
              ? `Record layer ${layer.index + 1}`
              : rec.label === "STOP"
                ? `Stop recording layer ${layer.index + 1}`
                : `Cancel recording layer ${layer.index + 1}`
          }
        >
          {rec.label}
        </button>

        <button
          className={[styles.action, layer.muted ? styles.actionOn : ""].join(" ")}
          onClick={() => onAction({ action: "mute", layer: layer.index })}
          disabled={empty}
          aria-label={`Toggle mute on layer ${layer.index + 1}`}
        >
          MUTE
        </button>

        <button
          className={[
            styles.action,
            styles.actionChain,
            !layer.chainCurrent && layer.seconds > 0 ? styles.chainDiff : "",
          ].join(" ")}
          onClick={() => onAction({ action: "chain", layer: layer.index })}
          disabled={empty}
          title={
            layer.seconds > 0 && !layer.chainCurrent
              ? "Paste the live chain over this layer's saved one"
              : "Copy the live chain onto this layer"
          }
          aria-label={`Paste live chain onto layer ${layer.index + 1}`}
        >
          CHAIN
        </button>

        <button
          className={[styles.action, styles.actionDanger].join(" ")}
          onClick={() => onAction({ action: "clear", layer: layer.index })}
          disabled={empty}
          aria-label={`Clear layer ${layer.index + 1}`}
        >
          CLR
        </button>
      </div>

      <div className={styles.maxWrap}>
        <span className={styles.levelLabel}>MAX</span>
        <div className={styles.maxPicker}>
          <button
            ref={triggerRef}
            type="button"
            className={styles.maxSelect}
            onClick={() => setMaxOpen((open) => !open)}
            disabled={layer.recording || layer.waiting}
            aria-haspopup="listbox"
            aria-expanded={maxOpen}
            aria-label={`Max length for next recording on layer ${layer.index + 1}`}
          >
            {max}s
          </button>
        </div>
      </div>

      {maxOpen &&
        menuAnchor &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.maxMenu}
            role="listbox"
            style={{ top: menuAnchor.top, right: menuAnchor.right }}
          >
            {MAX_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === max}
                className={[
                  styles.maxOption,
                  option === max ? styles.maxOptionActive : "",
                ].join(" ")}
                onClick={() => {
                  setMax(option);
                  setMaxOpen(false);
                }}
              >
                {option}s
              </button>
            ))}
          </div>,
          document.body,
        )}

      <div className={styles.levelWrap}>
        <span className={styles.levelLabel}>LVL</span>
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(layer.level)}
          disabled={empty}
          onChange={(event) =>
            onAction({
              action: "level",
              layer: layer.index,
              value: Number(event.target.value),
            })
          }
          aria-label={`Level for layer ${layer.index + 1}`}
        />
        <span className={styles.levelValue}>{Math.round(layer.level)}</span>
      </div>
    </div>
  );
}

export function LooperPanel() {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const levelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLevel = useRef<LooperAction | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getLooper,
    retry: 1,
    // An idle rig costs nothing. Polling only runs while something is moving:
    // a countdown, a take, or a playing loop.
    refetchInterval: (latest) => {
      const state = latest.state.data as LooperState | undefined;

      if (!state) {
        return false;
      }

      return state.layers.some(
        (layer) => layer.recording || layer.waiting || layer.playing,
      )
        ? ACTIVE_POLL_MS
        : false;
    },
  });

  const mutation = useMutation({
    mutationFn: postLooper,
    onMutate: async (action) => {
      // Cancel in flight polls. Otherwise a read issued before the click can
      // land after the optimistic write and undo it on screen.
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });

      const previous = queryClient.getQueryData<LooperState>(QUERY_KEY);

      if (previous) {
        queryClient.setQueryData(QUERY_KEY, predict(previous, action));
      }
    },
    onSuccess: (state) => {
      setFailure(null);
      queryClient.setQueryData(QUERY_KEY, state);
    },
    onError: (error) => {
      setFailure(error instanceof Error ? error.message : String(error));
      // Put the truth back rather than leaving an optimistic lie on screen.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  useEffect(() => {
    return () => {
      if (levelTimer.current) {
        clearTimeout(levelTimer.current);
      }
    };
  }, []);

  function send(action: LooperAction) {
    // A level drag coalesces into one request per gesture. Everything else is
    // discrete and goes straight out.
    if (action.action === "level") {
      pendingLevel.current = action;

      if (levelTimer.current) {
        clearTimeout(levelTimer.current);
      }

      levelTimer.current = setTimeout(() => {
        levelTimer.current = null;
        const queued = pendingLevel.current;
        pendingLevel.current = null;

        if (queued) {
          mutation.mutate(queued);
        }
      }, LEVEL_DEBOUNCE_MS);

      return;
    }

    mutation.mutate(action);
  }

  const state = query.data;
  const armed = state?.layers.filter((layer) => layer.seconds > 0).length ?? 0;
  const recording = state?.layers.some((layer) => layer.recording) ?? false;
  const waiting = state?.layers.find((layer) => layer.waiting);
  const loopLength = state?.transportSeconds ?? 0;

  // The master key freeze-pauses the whole transport. Derived off the wire's
  // paused flag so a resume pressed on another screen is mirrored here, and
  // busy guards the one state where freezing the clock would hang the take.
  const hasLoop = state?.layers.some((layer) => layer.seconds > 0) ?? false;
  const paused = state?.paused ?? false;
  const busy = recording || waiting !== undefined;
  const masterLabel = !hasLoop || paused ? "PLAY" : "PAUSE";

  const transportNote = recording
    ? "recording — the length locks when you stop"
    : waiting
      ? `recording in ${countdownTick(waiting.countdown)}s`
      : "layers play through the chain they were recorded with";

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.headerTitle}>LOOPER</h2>
        <span className={styles.headerMeta}>
          {state
            ? `${armed} of ${state.layers.length} armed · ${
                state.paused
                  ? "paused"
                  : loopLength > 0
                    ? `loop ${formatSeconds(loopLength)}`
                    : "no loop"
              } · cap ${formatSeconds(state.maxSeconds)}`
            : "connecting"}
        </span>

        <span className={styles.headerSpacer} />

        {mutation.isPending && <span className={styles.headerMeta}>…</span>}
      </div>

      <div className={styles.transport}>
        <button
          className={[
            styles.globalButton,
            hasLoop && !paused ? styles.globalActionOn : "",
          ].join(" ")}
          onClick={() => send({ action: "play" })}
          disabled={!hasLoop || busy}
          title={
            !hasLoop
              ? "Record a take first"
              : busy
                ? "Stop the take first"
                : undefined
          }
        >
          {masterLabel}
        </button>

        <button
          className={styles.globalButton}
          onClick={() => send({ action: "undo" })}
          disabled={!armed}
          title="Clear the most recent layer"
        >
          UNDO
        </button>

        <button
          className={[styles.globalButton, styles.actionDanger].join(" ")}
          onClick={() => send({ action: "clear" })}
          disabled={!armed}
        >
          CLEAR ALL
        </button>

        <span className={styles.headerSpacer} />

        <span className={styles.transportNote}>{transportNote}</span>
      </div>

      {state ? (
        <div className={styles.rows}>
          {state.layers.map((layer) => (
            <LayerRow
              key={layer.index}
              layer={layer}
              maxSeconds={state.maxSeconds}
              paused={paused}
              onAction={send}
            />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>Waiting for the agent…</p>
      )}

      {query.isError ? (
        <p className={styles.failure} role="alert">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      ) : failure ? (
        <p className={styles.failure} role="alert">{failure}</p>
      ) : null}
    </section>
  );
}