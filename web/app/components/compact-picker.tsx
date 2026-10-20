"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./ui-icon";

export function CompactPicker<Value extends string>({ value, options, onChange, label, className, disabled = false, icon }: {
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
  label: string;
  className: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const interaction = useRef<"pointer" | "keyboard">("pointer");
  const search = useRef({ text: "", time: 0 });
  const [menu, setMenu] = useState({ open: false, disabled });
  const [activeIndex, setActiveIndex] = useState(0);
  // A replay reload must not reopen a menu when the control becomes enabled again.
  if (menu.disabled !== disabled) setMenu({ open: false, disabled });
  const expanded = menu.open && !disabled && options.length > 0;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelClose();
    setMenu((current) => current.open ? { ...current, open: false } : current);
  }, [cancelClose]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    return () => {
      cancelClose();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [expanded, close, cancelClose]);

  const open = (index = selectedIndex) => {
    cancelClose();
    search.current = { text: "", time: 0 };
    setActiveIndex(index);
    setMenu({ open: true, disabled });
  };
  const choose = (index: number) => {
    if (disabled || !options[index]) return;
    close();
    trigger.current?.focus({ preventScroll: true });
    if (options[index].value !== value) onChange(options[index].value);
  };
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !options.length) return;
    interaction.current = "keyboard";
    cancelClose();
    const { key } = event;
    if (key === "Tab") { close(); return; }
    if (key === "Escape") {
      if (expanded) { event.preventDefault(); event.stopPropagation(); close(); }
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (!event.repeat) { if (expanded) choose(activeIndex); else open(); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      const index = key === "Home" ? 0 : key === "End" ? options.length - 1 : expanded
        ? (activeIndex + (key === "ArrowDown" ? 1 : -1) + options.length) % options.length : selectedIndex;
      if (expanded) setActiveIndex(index); else open(index);
      return;
    }
    if (key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
    const now = Date.now();
    const query = (now - search.current.time < 650 ? search.current.text : "") + key.toLowerCase();
    search.current = { text: query, time: now };
    const prefix = [...query].every((letter) => letter === query[0]) ? query[0] : query;
    const start = expanded ? activeIndex : selectedIndex;
    for (let offset = 1; offset <= options.length; offset++) {
      const index = (start + offset) % options.length;
      if (options[index].label.toLowerCase().startsWith(prefix)) {
        event.preventDefault();
        if (expanded) setActiveIndex(index);
        else { setActiveIndex(index); setMenu({ open: true, disabled }); }
        break;
      }
    }
  };

  return <div ref={root} className={"compact-picker " + className}
    onPointerEnter={cancelClose}
    onPointerLeave={(event) => {
      if (!expanded || event.pointerType !== "mouse" || interaction.current !== "pointer") return;
      cancelClose();
      closeTimer.current = window.setTimeout(close, 180);
    }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
  >
    <button ref={trigger} type="button" className="picker-trigger" role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={id + "-options"}
      aria-activedescendant={expanded ? id + "-option-" + activeIndex : undefined}
      disabled={disabled || !options.length}
      onPointerDown={() => { interaction.current = "pointer"; }}
      onKeyDown={handleKey}
      onClick={(event) => { interaction.current = event.detail ? "pointer" : "keyboard"; if (expanded) close(); else open(); }}
    >
      {icon ? <span className="picker-leading">{icon}</span> : null}
      <span className="picker-value">{options[selectedIndex]?.label ?? label}</span>
      <Icon name="arrow" className="picker-chevron" />
    </button>
    {expanded ? <div className="picker-popover">
      <ul id={id + "-options"} className="picker-menu" role="listbox" aria-label={label}
        style={{ "--picker-index": activeIndex } as CSSProperties}>
        {options.map((option, index) => <li key={option.value} id={id + "-option-" + index}
          className="picker-option" role="option" aria-selected={option.value === value}
          data-active={index === activeIndex}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") interaction.current = "pointer";
            cancelClose(); setActiveIndex(index);
          }}
          onPointerDown={(event) => { interaction.current = "pointer"; event.preventDefault(); }}
          onClick={() => choose(index)}
        ><span className="picker-check" aria-hidden="true">{option.value === value ? <Icon name="check" /> : null}</span><span>{option.label}</span></li>)}
      </ul>
    </div> : null}
  </div>;
}
