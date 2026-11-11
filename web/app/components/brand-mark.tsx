/** Two coordinated routes with four endpoints; independent of a letter or vehicle color. */
export function BrandMark({ className = "" }: { className?: string }) {
  return <svg className={`brand-symbol ${className}`} width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="38" height="38" rx="3" stroke="currentColor" strokeOpacity=".3" />
    <path d="M11 28V14a3 3 0 0 1 3-3h14M19 28v-6a3 3 0 0 1 3-3h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="11" cy="28" r="2.2" fill="currentColor" />
    <circle cx="19" cy="28" r="2.2" fill="currentColor" />
    <circle cx="28" cy="11" r="2.2" fill="currentColor" />
    <circle cx="28" cy="19" r="2.2" fill="currentColor" />
  </svg>;
}
