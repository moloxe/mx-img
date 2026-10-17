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
Debe existir un test para validar el funcionamiento con `src/assets/images/image.jpeg`.
