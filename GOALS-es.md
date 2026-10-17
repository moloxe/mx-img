# MxImg <mx-img />

Herramienta para cargar imágenes de forma progresiva.

Características:

- Opción de manejar el porcentaje o peso de datos a transferir de forma dinámica.
- Se transmite progresivamente el espectro de Fourier de las imágenes.

Construcción:

- La transferencia será por streaming

### Fase 0: /experiments

### Fase 1: encoder y decoder

Se usará lo construido en `experiments/notebooks/2026-10-new-format-03.ipynb` en un proyecto que funcione con el runtime de node bun (se traducirá el código con herramientas equivalentes y eficientes).
Se debe tener un script en `/src/utils/encoding/encoder.ts` y `/src/utils/encoding/decoder.ts`.
No es mandatorio que todo esté allí, lo necesario puede distribuirse en el resto del proyecto para bun en `/src`.
Debe existir un test para validar el funcionamiento con `src/assets/images/periodic-surface.jpeg`.

### Fase 2: stream cliente-servidor

#### Build:

- Se propone integrar con vite y generar los assets (formato para la carga progresiva de imágenes) en '/dist/.mx-img/*' con un hash para las imágenes.
- Además de vite, debe ser posible integrarlo con Astro en modo hybrid.
- Bundles esperados en un proyecto hybrid:
  - Cliente:
    - Luego del build, los elementos html quedarían algo como `<canvas is="mx-img" src="some-hash"></canvas>` (o `<mx-img src="some-hash"></mx-img>`), permitiendo el resto de variables equivalentes para `canvas`.
    - La primera carga enciende la configuración inicial, la cual abrirá el único puerto que se necesita para servir los canvas visibles.
  - Servidor: Por cada request buscará localmente en los bundles el hash consultado y responder dependiendo del progreso o porción solicitada.

#### Servidor:

Se crear un servicio en `http://localhost:8080/.mx-img/stream` (`ws://localhost:8080/.mx-img/stream`) para servir los streams de las porciones de imágen para el cliente.
Este servicio debe permitir iniciar streams, aceptar pausas, continuarlos, inicios con desface y lo necesario para casos de uso rutinarios.

- Por cada cliente solo debe existir 1 conexión para servir las porciones.
- Por cada petición de imágenes, se deben servir de forma equitativa hasta lograr el envío total. Por ejemplo:
  - 0 de 100kb -> 100kb de 100kb (Terminado)
  - 0 de 200kb -> 100kb de 200kb -> 200kb de 200kb (Terminado)
  - 0 de 300kb -> 100kb de 300kb -> 200kb de 300kb -> 300kb de 300kb (Terminado)

#### Cliente:

Se debe crear una librería `src/client/lib/index.ts` que registre un Custom Element con el tag `mx-img`, quedaría: `<canvas is="mx-img" src="../some/path.jpeg"></canvas>` (soportando también `<mx-img src="../some/path.jpeg"></mx-img>`).
El cliente debe importar las librerías para la configuración inicial y la ubicación del servidor:

```ts
import { init } from "mx-img";
init({
  streamUrl: "http://localhost:8080/.mx-img/stream",
});
```

El Custom Element `mx-img` extenderá a `canvas` (`HTMLCanvasElement`) y realizará la fase de decodificación (debe contar con dicha función).
Se debe comportar de la siguiente manera:

- Si es visible, debe iniciar solicitar progresivamente las porciones que faltan.
- Si se deja de ver, se pone en pausa.
- Si no es visible, permanece dormido.

#### Pruebas locales

Los archivos en `src/client/mockup` deben servir para poder probar en un cliente local la carga de imágenes.
Debe cargarse en el `index.html` las imágenes en `src/assets`.
Cargar la librería cliente (no necesariamente importar con `mx-img`, pero si una referencia local a la librería), iniciar la conexión y funcionar como se esperaría con el Custom Element `mx-img`
