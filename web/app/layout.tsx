import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const pagesBasePath = process.env.GITHUB_PAGES_BASE_PATH ?? "/";
const sitesOrigin =
  process.env.SITE_ORIGIN ?? "https://adaptive-agent-lab.my20000806.chatgpt.site";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
  const fallbackOrigin = pagesBasePath === "/" ? sitesOrigin : "https://revincxt.github.io";
  const origin = host ? `${protocol}://${host}` : fallbackOrigin;

  return {
    metadataBase: new URL(pagesBasePath, `${origin}/`),
    title: "FleetLab — Fleet Simulation",
    description:
      "Four factory layouts, four coordinated forklifts, and shared warehouse tasks in an interactive 3D replay.",
    applicationName: "FleetLab",
    keywords: [
      "reinforcement learning",
      "automated planning",
      "warehouse robotics",
      "Dyna-Q",
      "DQN",
      "replanning",
    ],
    authors: [{ name: "Revincxt", url: "https://github.com/Revincxt" }],
    alternates: { canonical: "./" },
    icons: { icon: "./favicon.svg" },
    openGraph: {
      type: "website",
      url: "./",
      siteName: "FleetLab",
      title: "FleetLab — Fleet Simulation",
      description:
        "Explore four factory layouts with four forklifts, shared orders, battery management, and recorded disruptions.",
      images: [
        {
          url: "./og.png",
          width: 1536,
          height: 1024,
          alt: "Four coordinated forklifts on a 3D factory floor",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "FleetLab — Fleet Simulation",
      description:
        "Four factory layouts. Four coordinated forklifts. One shared floor.",
      images: ["./og.png"],
    },
  };
}

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
