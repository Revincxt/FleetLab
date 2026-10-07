const iconPaths = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  box: "m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M7.5 5.5l9 5",
  play: "m9 5 11 7-11 7V5Z",
  pause: "M8 5v14M16 5v14",
  back: "m15 5-9 7 9 7M4 5v14",
  next: "m9 5 9 7-9 7M20 5v14",
  restart: "M3 10a9 9 0 1 1 1 7M3 4v6h6",
  bolt: "m13 2-9 12h7l-1 8 10-13h-7l1-7Z",
  charger: "M2 21h13M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M7 6h4v4H7zM9.5 12 7 16h3l-1 3M14 8h2a2 2 0 0 1 2 2v7a2 2 0 0 0 4 0V9M20 4v2m2-2v2M19 6h4v3h-4z",
  check: "m5 12 4 4L19 6",
  arrow: "m9 5 7 7-7 7",
  priority: "M5 21V4m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0",
  robot:
    "M8 7h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3ZM12 3v4M2 11v5M22 11v5M9 12v1M15 12v1M9 17h6",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18",
};

export function Icon({
  name,
  className = "",
}: {
  name: keyof typeof iconPaths;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}
