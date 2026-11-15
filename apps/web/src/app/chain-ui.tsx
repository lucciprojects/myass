"use client";

import {
  EFFECT_INFO,
  EFFECT_PARAMS,
  type EffectKind,
  type EffectParamSpec,
  type EffectSlot,
} from "@myass/protocol";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import styles from "./chain.module.css";
import { CHAIN_PRESETS, type ChainPreset } from "./presets";

const POSITION_STEPS = 1000;

function sliderToValue(position: number, spec: EffectParamSpec): number {
  const ratio = position / POSITION_STEPS;

  if (spec.curve === "log") {
    const low = Math.log(spec.min);
    const high = Math.log(spec.max);

    return Math.exp(low + ratio * (high - low));
  }

  return spec.min + ratio * (spec.max - spec.min);
}

function valueToSlider(value: number, spec: EffectParamSpec): number {
  if (spec.curve === "log") {
    const low = Math.log(spec.min);
    const high = Math.log(spec.max);
    const clamped = Math.min(Math.max(value, spec.min), spec.max);

    return ((Math.log(clamped) - low) / (high - low)) * POSITION_STEPS;
  }

  return ((value - spec.min) / (spec.max - spec.min)) * POSITION_STEPS;
}

function formatValue(value: number, spec: EffectParamSpec): string {
  if (spec.unit === "percent") {
    return `${Math.round(value)}%`;
  }

  return String(Number(value.toFixed(2)));
}

function ParamSlider({
  spec,
  value,
  onChange,
}: {
  spec: EffectParamSpec;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div>
      <div className={styles.paramHead}>
        <span className={styles.paramLabel}>{spec.label}</span>
        <span className={styles.paramValue}>{formatValue(value, spec)}</span>
      </div>

      <input
        className={styles.slider}
        type="range"
        min={0}
        max={POSITION_STEPS}
        step={1}
        value={Math.round(valueToSlider(value, spec))}
        onChange={(event) =>
          onChange(sliderToValue(Number(event.target.value), spec))
        }
      />
    </div>
  );
}

export function StatusPill({
  state,
  label,
}: {
  state: "live" | "busy" | "down";
  label: string;
}) {
  return (
    <div className={styles.status}>
      <span
        className={[
          styles.statusDot,
          state === "busy" ? styles.statusDotBusy : "",
          state === "down" ? styles.statusDotDown : "",
        ].join(" ")}
      />
      {label}
    </div>
  );
}

export function ChainStrip({
  slots,
  selectedId,
  onSelect,
  onClear,
}: {
  slots: EffectSlot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className={styles.strip}>
      <span className={styles.node}>IN</span>

      {slots.length === 0 ? (
        <span className={styles.stripEmpty}>bypassed</span>
      ) : (
        slots.map((slot, index) => (
          <Fragment key={slot.id}>
            <span className={styles.arrow}>&#9654;</span>

            <button
              className={[
                styles.chip,
                slot.id === selectedId ? styles.chipSelected : "",
                slot.enabled ? "" : styles.chipOff,
              ].join(" ")}
              onClick={() => onSelect(slot.id)}
            >
              <span className={styles.chipIndex}>{index + 1}</span>
              {EFFECT_INFO[slot.kind].name}
              <span
                className={[
                  styles.chipDot,
                  slot.enabled ? styles.chipDotOn : "",
                ].join(" ")}
              />
            </button>
          </Fragment>
        ))
      )}

      <span className={styles.arrow}>&#9654;</span>
      <span className={styles.node}>AMP</span>

      <span className={styles.stripSpacer} />

      {slots.length > 0 && (
        <button className={styles.stripClear} onClick={onClear}>
          CLEAR
        </button>
      )}
    </div>
  );
}

export function SlotRow({
  slot,
  index,
  count,
  selected,
  onSelect,
  onToggleEnabled,
  onMove,
  onRemove,
  onParamChange,
}: {
  slot: EffectSlot;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onParamChange: (key: string, value: number) => void;
}) {
  const info = EFFECT_INFO[slot.kind];
  const specs = EFFECT_PARAMS[slot.kind];

  return (
    <div
      className={[
        styles.slot,
        selected ? styles.slotSelected : "",
        slot.enabled ? "" : styles.slotDisabled,
      ].join(" ")}
    >
      <div className={styles.slotRow}>
        <button className={styles.slotSelect} onClick={onSelect}>
          <span className={styles.slotIndex}>{index + 1}</span>
          <span className={styles.slotName}>{info.name}</span>
          <span
            className={[
              styles.slotState,
              slot.enabled ? styles.slotStateOn : "",
            ].join(" ")}
          >
            {slot.enabled ? "ON" : "OFF"}
          </span>
        </button>

        <button
          className={[styles.toggle, slot.enabled ? styles.toggleOn : ""].join(" ")}
          onClick={onToggleEnabled}
          role="switch"
          aria-checked={slot.enabled}
          aria-label={`${info.name} enabled`}
        >
          <span className={styles.toggleKnob} />
        </button>

        {selected && (
          <div className={styles.slotActions}>
            <button
              className={styles.iconButton}
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label={`Move ${info.name} earlier in chain`}
            >
              &#9650;
            </button>

            <button
              className={styles.iconButton}
              onClick={() => onMove(1)}
              disabled={index === count - 1}
              aria-label={`Move ${info.name} later in chain`}
            >
              &#9660;
            </button>

            <button
              className={styles.iconButton}
              onClick={onRemove}
              aria-label={`Remove ${info.name}`}
            >
              &times;
            </button>
          </div>
        )}
      </div>

      {selected && (
        <div className={styles.slotBody}>
          <p className={styles.slotDescription}>{info.description}</p>

          <div className={styles.paramGrid}>
            {Object.entries(specs).map(([key, spec]) => (
              <ParamSlider
                key={key}
                spec={spec}
                value={slot.params[key] ?? spec.min}
                onChange={(next) => onParamChange(key, next)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const MENU_WIDTH = 300;
const MENU_MAX_HEIGHT = 340;
const MENU_MIN_HEIGHT = 150;
const MENU_GAP = 8;
const MENU_EDGE = 16;

interface MenuGeometry {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

// Shared mechanics for the toolbar drop menus: anchored to the trigger's
// screen position, flipping above when there is more room there, closing on
// Escape or when the page moves under it. ADD EFFECT, PRESETS and the output
// route picker all use it.
export function useDropMenu(triggerRef: RefObject<HTMLButtonElement | null>) {
  const [geometry, setGeometry] = useState<MenuGeometry | null>(null);
  const open = geometry !== null;

  useEffect(() => {
    if (!open) {
      return;
    }

    const close = () => setGeometry(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("resize", close);
    window.addEventListener("scroll", close);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setGeometry(null);
      return;
    }

    const rect = triggerRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
    const spaceAbove = rect.top - MENU_GAP;
    const side = spaceAbove > spaceBelow ? "above" : "below";
    const available = side === "above" ? spaceAbove : spaceBelow;

    setGeometry({
      left: Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_EDGE),
      top: side === "below" ? rect.bottom + MENU_GAP : undefined,
      bottom:
        side === "above" ? window.innerHeight - rect.top + MENU_GAP : undefined,
      maxHeight: Math.max(
        Math.min(MENU_MAX_HEIGHT, available),
        Math.min(MENU_MIN_HEIGHT, MENU_MAX_HEIGHT),
      ),
    });
  }

  return { geometry, setGeometry, open, toggle };
}

export function AddEffectMenu({
  onAdd,
}: {
  onAdd: (kind: EffectKind) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { geometry, setGeometry, open, toggle } = useDropMenu(triggerRef);

  return (
    <div className={styles.addWrapper}>
      {open && <div className={styles.scrim} onClick={() => setGeometry(null)} />}

      <button
        ref={triggerRef}
        className={styles.button}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
      >
        + ADD EFFECT
      </button>

      {geometry && (
        <div
          className={styles.menu}
          style={{
            left: geometry.left,
            top: geometry.top,
            bottom: geometry.bottom,
            maxHeight: geometry.maxHeight,
            width: MENU_WIDTH,
          }}
        >
          {(Object.keys(EFFECT_INFO) as EffectKind[]).map((kind) => (
            <button
              key={kind}
              className={styles.menuItem}
              onClick={() => {
                onAdd(kind);
                setGeometry(null);
              }}
            >
              {EFFECT_INFO[kind].name}
              <span className={styles.menuDescription}>
                {EFFECT_INFO[kind].description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The preset loader shares ADD EFFECT's behaviour and faceplate: a key that
// opens a menu of preset names, each with its slot count as the description.
export function PresetMenu({
  onApply,
}: {
  onApply: (preset: ChainPreset) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { geometry, setGeometry, open, toggle } = useDropMenu(triggerRef);

  return (
    <div className={styles.addWrapper}>
      {open && <div className={styles.scrim} onClick={() => setGeometry(null)} />}

      <button
        ref={triggerRef}
        className={styles.button}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
      >
        PRESETS
      </button>

      {geometry && (
        <div
          className={styles.menu}
          style={{
            left: geometry.left,
            top: geometry.top,
            bottom: geometry.bottom,
            maxHeight: geometry.maxHeight,
            width: MENU_WIDTH,
          }}
        >
          {CHAIN_PRESETS.map((preset) => (
            <button
              key={preset.name}
              className={styles.menuItem}
              onClick={() => {
                onApply(preset);
                setGeometry(null);
              }}
            >
              {preset.name}
              <span className={styles.menuDescription}>
                {preset.slots.length}{" "}
                {preset.slots.length === 1 ? "slot" : "slots"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
