import type { KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { faNum } from "./ui";

const SEPARATOR = /\n[ \t]*-{3,}[ \t]*\n/;

/** The parts as typed, empty ones included, so a just-added box doesn't vanish. */
export const editorParts = (value: string) => value.split(SEPARATOR);
const joinParts = (parts: string[]) => parts.join("\n---\n");

/**
 * Several messages in one field: each box is one message, sent in order. Stored as text with
 * "---" lines between the messages, which is what the server splits on.
 */
export function MultiMessageEditor({ value, onChange, placeholder, onKeyDown, addLabel = "افزودن پیام بعدی", single }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  addLabel?: string;
  /** One message only (e.g. Instagram's private reply); the boxes are joined into paragraphs. */
  single?: boolean;
}) {
  const parts = editorParts(value);
  const set = (i: number, text: string) => onChange(joinParts(parts.map((p, j) => (j === i ? text : p))));
  const remove = (i: number) => onChange(joinParts(parts.filter((_, j) => j !== i)));
  return (
    <div className="multi-message">
      {parts.map((part, i) => (
        <div className="multi-message-part" key={i}>
          {parts.length > 1 && (
            <div className="multi-message-head">
              <span>{single ? `بند ${faNum(i + 1)}` : `پیام ${faNum(i + 1)}`}</span>
              <button type="button" className="icon-button" aria-label="حذف این پیام" onClick={() => remove(i)}><X size={13} /></button>
            </div>
          )}
          <textarea value={part} onChange={(e) => set(i, e.target.value)} onKeyDown={onKeyDown} placeholder={i === 0 ? placeholder : "پیام بعدی..."} />
        </div>
      ))}
      <button type="button" className="text-button multi-message-add" onClick={() => onChange(joinParts([...parts, ""]))}><Plus size={13} /> {addLabel}</button>
    </div>
  );
}
