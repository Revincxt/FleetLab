import type { Metadata, Viewport } from "next";
import "./globals.css";

const description =
  "Explore coordinated forklifts, pedestrian-aware routing, and on-demand warehouse tasks in an interactive 3D replay.";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.GITHUB_PAGES_BASE_PATH ?? "/FleetLab/",
    "https://revincxt.github.io/",
  ),
  title: "FleetLab — Fleet Simulation",
  description,
  applicationName: "FleetLab",
  keywords: [
    "fleet simulation",
    "multi-agent pathfinding",
    "warehouse robotics",
    "Coordinated A*",
    "WHCA*",
    "RHCR",
  ],
  authors: [{ name: "Revincxt", url: "https://github.com/Revincxt" }],
  alternates: { canonical: "./" },
  icons: { icon: `${process.env.GITHUB_PAGES_BASE_PATH ?? "/"}favicon.svg` },
  openGraph: {
    type: "website",
    url: "./",
    siteName: "FleetLab",
    title: "FleetLab — Fleet Simulation",
    description,
    images: [
      {
        url: "./og.png",
        width: 1536,
        height: 1024,
        alt: "FleetLab industrial factory with current-task routes, chargers, and task queue",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FleetLab — Fleet Simulation",
    description,
    images: ["./og.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0d1115",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
