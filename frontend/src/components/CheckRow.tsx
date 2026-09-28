export function CheckRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start gap-3 py-2.5"><input className="check mt-0.5 shrink-0" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span className={checked ? "text-sm text-[var(--dim)] line-through" : "text-sm text-[var(--text)]"}>{label}</span></label>;
}
