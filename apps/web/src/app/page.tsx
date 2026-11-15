"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChainSchema,
  EFFECT_INFO,
  validateChain,
  type Chain,
  type EffectKind,
  type EffectSlot,
  type OutputSink,
  type OutputState,
} from "@myass/protocol";
import { useEffect, useRef, useState } from "react";
import { getChain, getOutput, putChain, routeOutput } from "./api-client";
import {
  AddEffectMenu,
  ChainStrip,
  PresetMenu,
  SlotRow,
  StatusPill,
  useDropMenu,
} from "./chain-ui";
import styles from "./chain.module.css";
import { LooperPanel } from "./looper-ui";
import type { ChainPreset } from "./presets";
import { WaveformPanel } from "./waveform-ui";
import { queryKeys } from "./queries";

const APPLY_DEBOUNCE_MS = 300;

// The rig's output lives in PipeWire, not in the agent: this key opens a menu
// of every sink the rig can be heard through — the amp's USB codec, the
// computer's speakers, whichever Bluetooth headset is connected — and asks the
// API to relink the agent's stream there, so loops keep playing through the
// swap. Optimistic: a route change is instant and local, so the label follows
// the click and rolls back on error.
function outputLabel(sink: OutputSink | null): string {
  if (!sink) {
    return "OUT · …";
  }
  if (sink.node.includes("Burr-Brown")) {
    return "OUT · AMP";
  }
  if (sink.node.startsWith("bluez_output")) {
    return `OUT · ${sink.description}`;
  }
  return "OUT · SPEAKERS";
}

function OutputKey() {
  const queryClient = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { geometry, setGeometry, open, toggle } = useDropMenu(triggerRef);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const query = useQuery({
    queryKey: queryKeys.output,
    queryFn: getOutput,
    enabled: mounted,
    retry: 1,
  });

  const mutation = useMutation({
    mutationFn: (node: string) => routeOutput(node),
    onMutate: async (node) => {
      await queryClient.cancelQueries({ queryKey: ["output"] });
      const previous = queryClient.getQueryData<OutputState>(["output"]);

      if (previous) {
        queryClient.setQueryData<OutputState>(["output"], {
          ...previous,
          sink: previous.sinks.find((s) => s.node === node) ?? previous.sink,
        });
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData<OutputState>(["output"], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["output"] });
    },
  });

  const state = query.data;
  const sink = state?.sink ?? null;
  const pending = mutation.isPending;

  return (
    <div className={styles.addWrapper}>
      {open && <div className={styles.scrim} onClick={() => setGeometry(null)} />}

      <button
        ref={triggerRef}
        className={styles.outputKey}
        onClick={toggle}
        disabled={state === undefined || pending}
        aria-expanded={open}
        aria-haspopup="true"
        title={
          sink
            ? `Rig plays through ${sink.description}. Click to change where you hear it.`
            : "Rig output: unknown"
        }
      >
        {outputLabel(sink)}
      </button>

      {geometry && (
        <div
          className={styles.menu}
          style={{
            left: geometry.left,
            top: geometry.top,
            bottom: geometry.bottom,
            maxHeight: geometry.maxHeight,
            // Matches MENU_WIDTH in chain-ui.tsx, so all menus share a width.
            width: 300,
          }}
        >
          {state?.sinks.map((candidate) => (
            <button
              key={candidate.node}
              className={[
                styles.menuItem,
                candidate.node === sink?.node ? styles.menuItemCurrent : "",
              ].join(" ")}
              onClick={() => {
                mutation.mutate(candidate.node);
                setGeometry(null);
              }}
            >
              {candidate.description}
              <span className={styles.menuDescription}>
                {candidate.node === sink?.node ? "playing here" : "route here"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [slots, setSlots] = useState<EffectSlot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bypass, setBypass] = useState(false);
  const [pending, setPending] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const [tab, setTab] = useState<"chain" | "looper">("chain");

  const chainRef = useRef<EffectSlot[]>([]);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);
  const hydrated = useRef(false);
  const preBypass = useRef<Record<string, boolean> | null>(null);

  const chainQuery = useQuery({
    queryKey: queryKeys.chain,
    queryFn: getChain,
    retry: 1,
  });

  const chainMutation = useMutation({ mutationFn: putChain });

  // Adopt whatever the agent already has, but only once, so later local
  // edits are never clobbered by a refetch.
  useEffect(() => {
    if (hydrated.current || !chainQuery.data) {
      return;
    }

    hydrated.current = true;

    const remote = chainQuery.data.slots;

    if (remote.length === 0) {
      return;
    }

    chainRef.current = remote;
    setSlots(remote);
    setAppliedCount((count) => count + 1);
  }, [chainQuery.data]);

  useEffect(() => {
    return () => {
      if (applyTimer.current) {
        clearTimeout(applyTimer.current);
      }
    };
  }, []);

  function mintId() {
    nextId.current += 1;
    return `slot-${nextId.current}`;
  }

  /**
   * The single place a chain change reaches the agent. Discrete actions send
   * immediately; slider drags wait for a pause so one drag is one request
   * rather than hundreds against a live audio stream.
   */
  function apply(chain: EffectSlot[], immediate: boolean) {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }

    const send = () => {
      applyTimer.current = null;
      setPending(false);
      chainMutation.mutate(chain);
    };

    if (immediate) {
      send();
      return;
    }

    setPending(true);
    applyTimer.current = setTimeout(send, APPLY_DEBOUNCE_MS);
  }

  function commit(next: EffectSlot[], immediate: boolean) {
    chainRef.current = next;
    setSlots(next);
    apply(next, immediate);
  }

  function addEffect(kind: EffectKind) {
    const id = mintId();

    commit(
      [
        ...chainRef.current,
        { id, kind, enabled: true, params: { ...EFFECT_INFO[kind].defaults } },
      ],
      true,
    );

    setSelectedId(id);
    setBypass(false);
  }

  function removeSlot(id: string) {
    commit(
      chainRef.current.filter((slot) => slot.id !== id),
      true,
    );

    setSelectedId((current) => (current === id ? null : current));
  }

  function moveSlot(id: string, delta: number) {
    const current = chainRef.current;
    const index = current.findIndex((slot) => slot.id === id);
    const target = index + delta;

    if (index === -1 || target < 0 || target >= current.length) {
      return;
    }

    const next = [...current];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);

    commit(next, true);
  }

  function toggleSlot(id: string) {
    commit(
      chainRef.current.map((slot) =>
        slot.id === id ? { ...slot, enabled: !slot.enabled } : slot,
      ),
      true,
    );

    setBypass(false);
  }

  function setParam(id: string, key: string, value: number) {
    commit(
      chainRef.current.map((slot) =>
        slot.id === id
          ? { ...slot, params: { ...slot.params, [key]: value } }
          : slot,
      ),
      false,
    );
  }

  function toggleBypass() {
    if (bypass) {
      const restore = preBypass.current ?? {};

      commit(
        chainRef.current.map((slot) => ({
          ...slot,
          enabled: restore[slot.id] ?? slot.enabled,
        })),
        true,
      );

      preBypass.current = null;
      setBypass(false);
      return;
    }

    preBypass.current = Object.fromEntries(
      chainRef.current.map((slot) => [slot.id, slot.enabled]),
    );

    commit(
      chainRef.current.map((slot) => ({ ...slot, enabled: false })),
      true,
    );

    setBypass(true);
  }

  function applyPreset(preset: ChainPreset) {
    commit(
      preset.slots.map((slot) => ({
        id: mintId(),
        kind: slot.kind,
        enabled: slot.enabled,
        params: { ...EFFECT_INFO[slot.kind].defaults, ...slot.params },
      })),
      true,
    );

    setSelectedId(null);
    setBypass(false);
    preBypass.current = null;
  }

  function clearChain() {
    commit([], true);
    setSelectedId(null);
    setBypass(false);
    preBypass.current = null;
  }

  const activeCount = slots.filter((slot) => slot.enabled).length;
  const chain: Chain = { slots };
  const issues = validateChain(chain);
  const payload = JSON.stringify(ChainSchema.parse(chain), null, 2);

  const applying = pending || chainMutation.isPending;

  // Order matters here. If the API is unreachable the initial GET fails as
  // well, and letting the mutation error win would label a connectivity
  // problem as "apply failed", implying the agent rejected a chain it never
  // heard about.
  const failure = chainMutation.error ?? chainQuery.error;
  const statusState = failure
    ? "down"
    : applying
      ? "busy"
      : "live";

  const statusLabel = chainQuery.isError
    ? "api offline"
    : chainMutation.isError
      ? "apply failed"
      : applying
        ? "applying"
        : bypass
          ? "bypassed"
          : activeCount === 0
            ? "chain empty"
            : `${activeCount} of ${slots.length} active`;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.eyebrow}>MYASS</span>
            <h1 className={styles.title}>Signal Chain</h1>
          </div>

          <div className={styles.topActions}>
            <OutputKey />
            <StatusPill state={statusState} label={statusLabel} />
          </div>
        </div>

        <nav className={styles.tabs} aria-label="Sections">
          <button
            className={[styles.tab, tab === "chain" ? styles.tabActive : ""].join(
              " ",
            )}
            onClick={() => setTab("chain")}
            aria-current={tab === "chain" ? "page" : undefined}
          >
            CHAIN
          </button>
          <button
            className={[styles.tab, tab === "looper" ? styles.tabActive : ""].join(
              " ",
            )}
            onClick={() => setTab("looper")}
            aria-current={tab === "looper" ? "page" : undefined}
          >
            LOOPER
          </button>
        </nav>

        {tab === "chain" && (
          <ChainStrip
            slots={slots}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onClear={clearChain}
          />
        )}
      </header>

      {tab === "chain" ? (
        <div className={styles.body}>
          <div className={styles.slots}>
            {slots.length === 0 ? (
              <div className={styles.empty}>
                Empty chain. Add an effect, or load a preset.
              </div>
            ) : (
              slots.map((slot, index) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  index={index}
                  count={slots.length}
                  selected={slot.id === selectedId}
                  onSelect={() =>
                    setSelectedId((current) =>
                      current === slot.id ? null : slot.id,
                    )
                  }
                  onToggleEnabled={() => toggleSlot(slot.id)}
                  onMove={(delta) => moveSlot(slot.id, delta)}
                  onRemove={() => removeSlot(slot.id)}
                  onParamChange={(key, value) => setParam(slot.id, key, value)}
                />
              ))
            )}
          </div>

          <div className={styles.toolbar}>
            <AddEffectMenu onAdd={addEffect} />

            <PresetMenu onApply={applyPreset} />

            <button
              className={[
                styles.button,
                styles.buttonGhost,
                bypass ? styles.bypassOn : "",
              ].join(" ")}
              onClick={toggleBypass}
              disabled={slots.length === 0}
            >
              {bypass ? "BYPASSED" : "BYPASS"}
            </button>

            <span style={{ flex: 1 }} />

            <span className={styles.appliedCount}>{appliedCount} applied</span>
          </div>

          {slots.length > 0 && <WaveformPanel slots={slots} />}

          <details className={styles.payload}>
            <summary className={styles.payloadSummary}>
              WIRE PAYLOAD
            </summary>
            <pre className={styles.payloadPre}>{payload}</pre>
            {issues.length > 0 && (
              <pre className={styles.payloadPre}>
                {issues
                  .map(
                    (issue) =>
                      `slot ${issue.slotIndex} ${issue.kind}.${issue.param}: ${issue.reason}`,
                  )
                  .join("\n")}
              </pre>
            )}
          </details>

          {failure && (
            <p className={styles.failure} role="alert">
              {failure instanceof Error ? failure.message : String(failure)}
            </p>
          )}
        </div>
      ) : (
        <div className={styles.body}>
          <LooperPanel
            onCancelPendingApply={() => {
              if (applyTimer.current) {
                clearTimeout(applyTimer.current);
                applyTimer.current = null;
              }
              setPending(false);
            }}
          />
        </div>
      )}
    </main>
  );
}
