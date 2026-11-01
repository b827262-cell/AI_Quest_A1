import { PaneSplitter } from "./PaneSplitter";

export function OuterResizeHandle({
  onResize,
  label
}: {
  onResize: (dx: number) => void;
  label: string;
}) {
  return (
    <PaneSplitter onResize={onResize} label={label} className="outer" />
  );
}
