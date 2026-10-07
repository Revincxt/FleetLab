import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("README links resolve to existing project files and current commands", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  const localLinks = links.filter(link => !/^(?:https?:|#)/.test(link));
  assert.ok(localLinks.length >= 5);
  for (const link of localLinks) {
    await access(new URL(link.split("#")[0], root));
  }
  const pkg = JSON.parse(await readFile(new URL("web/package.json", root), "utf8"));
  for (const [, command] of readme.matchAll(/pnpm (?!install\b)([a-z][\w:-]*)/g)) {
    assert.ok(Object.hasOwn(pkg.scripts, command), `README command: pnpm ${command}`);
  }
  assert.doesNotMatch(readme, /export-demo|export-gallery|demo-gallery\.json|chatgpt\.site|Revincxt\/adaptive-agent|Documentation|Alpha · Demo only/);
});

test("README and social previews use full-size PNG assets with matching metadata", async () => {
  for (const [path, width, height] of [
    ["docs/assets/replay-explorer.png", 1600, 1000],
    ["web/public/og.png", 1536, 1024],
  ]) {
    const png = await readFile(new URL(path, root));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), path);
    assert.equal(png.readUInt32BE(16), width, path);
    assert.equal(png.readUInt32BE(20), height, path);
  }
  const layout = await readFile(new URL("web/app/layout.tsx", root), "utf8");
  assert.match(layout, /width: 1536/);
  assert.match(layout, /height: 1024/);
  assert.doesNotMatch(layout, /chatgpt\.site|SITE_ORIGIN|Dyna-Q|DQN/);
});
