import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..");
const DIST_DIR = resolve(ROOT_DIR, "dist");

interface BundleTarget {
  name: string;
  entrypoint: string;
  outfile: string;
  dtsFile: string;
  dtsReExport: string;
  target: "browser" | "bun";
  external?: string[];
}

const TARGETS: BundleTarget[] = [
  {
    name: "mx-img/client",
    entrypoint: resolve(ROOT_DIR, "src/client/lib/index.ts"),
    outfile: resolve(DIST_DIR, "client.js"),
    dtsFile: resolve(DIST_DIR, "client.d.ts"),
    dtsReExport: `export * from "./types/client/lib/index.js";\n`,
    target: "browser",
  },
  {
    name: "mx-img/server",
    entrypoint: resolve(ROOT_DIR, "src/server/index.ts"),
    outfile: resolve(DIST_DIR, "server.js"),
    dtsFile: resolve(DIST_DIR, "server.d.ts"),
    dtsReExport: `export * from "./types/server/index.js";\n`,
    target: "bun",
    external: ["sharp"],
  },
  {
    name: "mx-img/build",
    entrypoint: resolve(ROOT_DIR, "src/build/index.ts"),
    outfile: resolve(DIST_DIR, "build.js"),
    dtsFile: resolve(DIST_DIR, "build.d.ts"),
    dtsReExport: `export * from "./types/build/index.js";\n`,
    target: "bun",
    external: ["sharp"],
  },
  {
    name: "mx-img (root)",
    entrypoint: resolve(ROOT_DIR, "src/index.ts"),
    outfile: resolve(DIST_DIR, "index.js"),
    dtsFile: resolve(DIST_DIR, "index.d.ts"),
    dtsReExport: `export * from "./types/index.js";\n`,
    target: "bun",
    external: ["sharp"],
  },
];

export async function buildLibBundles(): Promise<void> {
  const t0 = performance.now();
  await mkdir(DIST_DIR, { recursive: true });

  // Clean previous declaration output without touching dist/.mx-img
  await rm(resolve(DIST_DIR, "types"), { recursive: true, force: true });

  for (const item of TARGETS) {
    const result = await Bun.build({
      entrypoints: [item.entrypoint],
      target: item.target,
      format: "esm",
      minify: false,
      sourcemap: "none",
      external: item.external ?? [],
    });

    if (!result.success || result.outputs.length === 0) {
      const logs = result.logs.map((l) => l.message).join("\n");
      throw new Error(`Failed building ${item.name}:\n${logs}`);
    }

    const code = await result.outputs[0].text();
    await writeFile(item.outfile, code, "utf8");
    await writeFile(item.dtsFile, item.dtsReExport, "utf8");
  }

  // Emit TypeScript declarations into dist/types
  const tscProc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.build.json"], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (tscProc.exitCode !== 0) {
    const out = new TextDecoder().decode(tscProc.stdout);
    const err = new TextDecoder().decode(tscProc.stderr);
    throw new Error(`Failed generating TypeScript declarations:\n${out}\n${err}`);
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(
    `✅ Built mx-img library bundles (client, server, build, index + .d.ts) in ${elapsed} ms`
  );
}

if (import.meta.main) {
  await buildLibBundles();
}
