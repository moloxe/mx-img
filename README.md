# MxImg (`<mx-img />`)

Progressive image streaming powered by the 2D Fourier spectrum (`YCbCr` + radial frequency ordering).

- **Dynamic transfer control**: Stream any target percentage or byte budget on demand (`max-percent`, `data-offset-bytes`).
- **Single-socket multiplexing**: One WebSocket connection per client serves all visible `<mx-img />` (`<canvas is="mx-img">`) elements using fair Round-Robin 100 KB chunks.
- **Viewport-aware lifecycle**: Automatically starts when visible, pauses when scrolled out of view, and stays sleeping when off-screen.

## Why Bun-Only?

`mx-img` targets the **Bun** runtime (`>= 1.1.0`) exclusively on the server and build pipeline for maximum throughput and minimal latency:

- **Native WebSocket Multiplexer**: `Bun.serve` runs on a native Zig/uWebSockets engine, delivering binary `MXCH` spectrum chunks with near-zero framing overhead.
- **Fast Binary & FFT Pipeline**: Direct zero-copy `Uint8Array` slicing and fast asset pre-compilation during Vite/Astro builds.

## Installation

Install directly from GitHub using Bun:

```bash
bun add github:moloxe/mx-img
```

## Subpath Imports

| Subpath         | Environment         | Main Exports                                                   |
| :-------------- | :------------------ | :------------------------------------------------------------- |
| `mx-img/build`  | Astro / Vite Config | `mxImgAstroIntegration`, `mxImgVitePlugin`, `buildMxImgAssets` |
| `mx-img/server` | Bun Server          | `createMxImgStreamServer`                                      |
| `mx-img/client` | Browser             | `init`, `MxImg`, `registerMxImgElement`                        |

## Minimal Implementation (Astro Hybrid / Server)

### 1. Configure Astro (`astro.config.mjs`)

Register the integration so `<mx-img src="..." />` tags are compiled into hashed `.mximg` spectral bundles inside `/dist/.mx-img/*`:

```js
import { defineConfig } from "astro/config";
import { mxImgAstroIntegration } from "mx-img/build";

export default defineConfig({
  output: "hybrid",
  integrations: [
    mxImgAstroIntegration({
      assetsDir: "src/assets/images",
    }),
  ],
});
```

### 2. Start the Stream Server (`server.ts`)

Run the Bun WebSocket streaming service pointing to the generated `/dist/.mx-img` directory:

```ts
import { createMxImgStreamServer } from "mx-img/server";

createMxImgStreamServer({
  port: 8080,
  mxImgDir: "dist/.mx-img",
});
```

### 3. Initialize Client & Render (`src/pages/index.astro`)

Initialize the single WebSocket connection on the client and place `<mx-img>` (or `<canvas is="mx-img">`) in your markup:

```astro
---
---
<html>
  <body>
    <mx-img src="/assets/images/photo.jpeg" class="hero-img" max-percent="100"></mx-img>

    <script>
      import { init } from "mx-img/client";

      init({
        streamUrl: "http://localhost:8080/.mx-img/stream",
      });
    </script>
  </body>
</html>
```

## License & Disclaimer

Released under the [MIT License](./LICENSE).

**Disclaimer**: This software is provided _"as is"_, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.
