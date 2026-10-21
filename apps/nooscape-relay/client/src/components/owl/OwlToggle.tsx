import { Switch } from "@/components/ui/switch";
import { useOwl } from "@/contexts/OwlContext";

/** The Owl guide switch, as a row for the header's phone menu. The menu on a wide screen has the same choice as a checkbox item. */
export function OwlToggle() {
  const { enabled, setEnabled } = useOwl();
  return (
    <label className="flex min-h-11 w-full cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-3 text-base text-ns-ink transition-colors hover:bg-white/[0.06]">
      <span>Owl guide</span>
      <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Owl guide" />
    </label>
  );
}
