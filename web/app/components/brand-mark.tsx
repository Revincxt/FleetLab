/** Two coordinated routes with four endpoints; independent of a letter or vehicle color. */
export function BrandMark({ className = "" }: { className?: string }) {
  return <svg className={`brand-symbol ${className}`} width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="38" height="38" rx="11" fill="currentColor" />
    <rect x="1.5" y="1.5" width="37" height="37" rx="10.5" stroke="white" strokeOpacity=".2" />
    <path d="M11 28V14a3 3 0 0 1 3-3h14M19 28v-6a3 3 0 0 1 3-3h6" stroke="#172019" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="11" cy="28" r="2.2" fill="#172019" />
    <circle cx="19" cy="28" r="2.2" fill="#172019" />
    <circle cx="28" cy="11" r="2.2" fill="#172019" />
    <circle cx="28" cy="19" r="2.2" fill="#172019" />
  </svg>;
}
