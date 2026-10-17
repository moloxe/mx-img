import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildLibBundles } from "../../../scripts/build-lib.ts";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const DIST_DIR = resolve(ROOT_DIR, "dist");

describe("MxImg Fase 3: Lib Bundles (mx-img/client, mx-img/server, mx-img/build) & Docs", () => {
  test("1. Genera los bundles ESM y declaraciones TypeScript (.d.ts) para client, server, build e index", async () => {
    await buildLibBundles();

    const expectedFiles = [
      "client.js",
      "client.d.ts",
      "server.js",
      "server.d.ts",
      "build.js",
      "build.d.ts",
      "index.js",
      "index.d.ts",
      "types/client/lib/index.d.ts",
      "types/server/index.d.ts",
      "types/build/index.d.ts",
    ];

    for (const relPath of expectedFiles) {
      expect(existsSync(resolve(DIST_DIR, relPath))).toBe(true);
    }
  });

  test("2. El bundle de cliente (dist/client.js) es autocontenido para navegador, usa '/.mx-img/stream' por defecto y no depende del servidor", async () => {
    const clientCode = await readFile(resolve(DIST_DIR, "client.js"), "utf8");
    expect(clientCode).not.toContain(`from "sharp"`);
    expect(clientCode).not.toContain(`from "node:fs"`);

    const clientMod = await import(resolve(DIST_DIR, "client.js"));
    expect(typeof clientMod.init).toBe("function");
    expect(typeof clientMod.MxImg).toBe("function");
    expect(typeof clientMod.registerMxImgElement).toBe("function");

    // Verificar que init() sin argumentos asigna "/.mx-img/stream" por defecto
    clientMod.connectionManager.configure();
    expect(clientMod.connectionManager.getConfig()?.streamUrl).toBe("/.mx-img/stream");
  });

  test("3. Los bundles de servidor (dist/server.js) y build (dist/build.js) exportan las APIs para Bun y Astro/Vite", async () => {
    const serverMod = await import(resolve(DIST_DIR, "server.js"));
    expect(typeof serverMod.createMxImgStreamServer).toBe("function");
    expect(typeof serverMod.encodeServerChunkFrame).toBe("function");
    expect(typeof serverMod.decodeServerChunkFrame).toBe("function");
    expect(serverMod.DEFAULT_STREAM_URL).toBe("/.mx-img/stream");

    const buildMod = await import(resolve(DIST_DIR, "build.js"));
    expect(typeof buildMod.mxImgAstroIntegration).toBe("function");
    expect(typeof buildMod.mxImgVitePlugin).toBe("function");
    expect(typeof buildMod.buildMxImgAssets).toBe("function");
    expect(typeof buildMod.transformHtmlForMxImg).toBe("function");
  });

  test("4. package.json, README.md y LICENSE están sincronizados con los requisitos de Fase 3", async () => {
    const pkg = JSON.parse(await readFile(resolve(ROOT_DIR, "package.json"), "utf8"));
    expect(pkg.exports["./client"].import).toBe("./dist/client.js");
    expect(pkg.exports["./server"].import).toBe("./dist/server.js");
    expect(pkg.exports["./build"].import).toBe("./dist/build.js");
    expect(pkg.license).toBe("MIT");

    const readme = await readFile(resolve(ROOT_DIR, "README.md"), "utf8");
    expect(readme).toContain("bun add github:moloxe/mx-img");
    expect(readme).toContain("mx-img/build");
    expect(readme).toContain("mx-img/server");
    expect(readme).toContain("mx-img/client");
    expect(readme).toContain("/.mx-img/stream");
    expect(readme).not.toContain("8080");
    expect(readme).toContain("Disclaimer");

    const license = await readFile(resolve(ROOT_DIR, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("WITHOUT WARRANTY OF ANY KIND");
  });
});
