import { createContext, useCallback, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";

const STORAGE_KEY = "nooscape:owl";

/** The visitor's choice, remembered in this browser. On unless they turned it off; storage can be blocked, so a failure means the default. */
function readStoredChoice(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeChoice(enabled: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The choice still holds for this visit.
  }
}

type OwlContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Where the owl's feet are, in viewport pixels. Written every frame by the owl and read by anything that wants to know what it is standing near; a ref, so it never re-renders. */
  position: MutableRefObject<{ x: number; y: number }>;
  /** Set to true while the owl is scanning something, which turns its radar eye. */
  scanning: MutableRefObject<boolean>;
};

const OwlContext = createContext<OwlContextValue | undefined>(undefined);

export function OwlProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(readStoredChoice);
  const position = useRef({ x: 0, y: 0 });
  const scanning = useRef(false);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    storeChoice(next);
  }, []);
  const value = useMemo(() => ({ enabled, setEnabled, position, scanning }), [enabled, setEnabled]);
  return <OwlContext.Provider value={value}>{children}</OwlContext.Provider>;
}

export function useOwl(): OwlContextValue {
  const context = useContext(OwlContext);
  if (!context) throw new Error("useOwl must be used inside an OwlProvider");
  return context;
}
