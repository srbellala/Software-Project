import { useRef, useState, type DragEvent } from "react";

interface DropZoneProps {
  icon: string;
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}

export function DropZone({ icon, label, hint, accept, multiple = false, onFiles }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    onFiles(Array.from(e.dataTransfer.files));
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`mb-3 cursor-pointer rounded-card border-2 border-dashed px-5 py-8 text-center transition-colors ${
        dragOver ? "border-accent bg-accent-light text-navy" : "border-border text-muted hover:border-accent hover:bg-accent-light hover:text-navy"
      }`}
    >
      <div className="mb-2 text-[28px]">{icon}</div>
      <div className="text-[13px] font-semibold">{label}</div>
      <div className="mt-1 text-[11px] opacity-70">{hint}</div>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}
