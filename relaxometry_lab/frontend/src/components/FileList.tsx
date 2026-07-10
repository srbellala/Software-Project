import type { FileListEntry } from "../store/appStore";

export function FileList({ items }: { items: FileListEntry[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2.5 max-h-20 overflow-y-auto text-xs text-muted">
      {items.map((item, i) => (
        <div key={i} className="py-0.5">
          {item.icon} {item.label}
        </div>
      ))}
    </div>
  );
}
