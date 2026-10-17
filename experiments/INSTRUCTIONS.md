# Entorno de Experimentación - Fourier Image Processing (`experiments/`)

Este entorno está configurado para la experimentación, análisis y simulación de transmisión progresiva de imágenes mediante el espectro de Fourier (2D FFT / IFFT) para el proyecto **`<mx-img />`** (según [GOALS-es.md](../GOALS-es.md)).

---

## 1. Requisitos Previos

- **Python 3.10+** instalado en macOS.

---

## 2. Configuración y Creación del Entorno Virtual

El entorno principal se aloja en `experiments/.venv`.

### Opción A: Desde el directorio `experiments/` (Recomendado)
```bash
cd /Users/francomolochegarcia/dev/mx-img/experiments

# 1. Crear el entorno virtual (.venv)
python3 -m venv .venv

# 2. Actualizar pip e instalar dependencias
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

# 3. Registrar el kernel en Jupyter
./.venv/bin/python -m ipykernel install --user --name mx-img-experiments --display-name "Python (mx-img-experiments)"
```

### Opción B: Si estás en la raíz del repositorio (`mx-img/`)
```bash
cd /Users/francomolochegarcia/dev/mx-img

# Instalar dependencias usando el requirements de la raíz
./experiments/.venv/bin/pip install -r requirements.txt
```

---

## 3. Iniciar Jupyter Notebook / JupyterLab

### En la terminal:
```bash
cd /Users/francomolochegarcia/dev/mx-img/experiments
source .venv/bin/activate
jupyter lab
```

### Directamente con el binario del entorno:
```bash
/Users/francomolochegarcia/dev/mx-img/experiments/.venv/bin/jupyter lab
```

### Si abres los cuadernos desde VS Code / Antigravity IDE:
Selecciona el kernel de Jupyter:
- **`Python (mx-img-experiments)`** o el intérprete en `/Users/francomolochegarcia/dev/mx-img/experiments/.venv/bin/python`.

---

## 4. Cuadernos de Experimentación Disponibles

- **[2026-10.ipynb](notebooks/2026-10.ipynb)**: Experimento de corte circular en el espectro de Fourier (2D-FFT / 2D-IFFT).
  - **Stage 1:** Muestra la imagen original (`images/image.jpeg`).
  - **Stage 2:** Muestra su espectro de Fourier centrado en escala logarítmica.
  - **Stage 3:** Muestra la máscara del corte circular (filtro paso bajo).
  - **Stage 4:** Muestra el espectro cortado con contorno blanco del radio y métricas de retención de energía.
  - **Stage 5:** Reconstruye la imagen espacial mediante IFFT comparada con la original.
  - **Stage Interactivo:** Réplica en cuadrícula 2x2 con slider dinámico de radio en tiempo real.
