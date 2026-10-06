/** A compact fleet silhouette; its load mirrors the recorded vehicle state. */
export function ForkliftGlyph({ loaded = false }: { loaded?: boolean }) {
  return <svg className="forklift-glyph" width="44" height="36" viewBox="0 0 48 40" fill="none" aria-hidden="true">
    <path d="M5 23h21l5 7H5Z" fill="currentColor" fillOpacity=".16" />
    <path d="M5 30V23h21l5 7M9 22V12h12v10M7 12h16M32 7v23h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="11" cy="32" r="3" fill="currentColor" />
    <circle cx="27" cy="32" r="3" fill="currentColor" />
    {loaded ? <><rect x="35" y="14" width="10" height="13" rx="1.5" fill="#dfb482" /><path d="M40 14v5m-5 2h10" stroke="#795f42" strokeWidth="1.2" /></> : null}
  </svg>;
}
