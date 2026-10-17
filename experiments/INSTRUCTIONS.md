# Entorno de Experimentación - Fourier Image Processing (`experiments/`)

Este entorno está configurado para la experimentación, análisis y simulación de transmisión progresiva de imágenes mediante el espectro de Fourier (2D FFT / IFFT) para el proyecto **`<mx-img />`** (según [GOALS-es.md](file:///Users/francomolochegarcia/dev/mx-img/GOALS-es.md)).

---

## 1. Requisitos Previos

- **Python 3.10+** instalado en macOS.

---

## 2. Configuración y Creación del Entorno Virtual

Si necesitas recrear el entorno desde cero dentro de `experiments/`:

```bash
cd /Users/francomolochegarcia/dev/mx-img/experiments

# 1. Crear el entorno virtual (.venv)
python3 -m venv .venv

# 2. Actualizar pip e instalar dependencias
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
```

### Paquetes incluidos (`requirements.txt`):

- `numpy`: Manipulación matricial y operaciones con tensores.
- `scipy`: FFT 2D y transformadas avanzadas (`scipy.fft`).
- `pillow` y `opencv-python-headless`: Carga, manipulación y conversión de imágenes.
- `matplotlib`: Visualización de espectro de magnitud, fase y reconstrucciones progresivas.
- `jupyterlab` / `notebook` / `ipywidgets`: Entorno interactivo y sliders interactivos para simular el streaming de coeficientes/frecuencias.

---

## 3. Iniciar Jupyter Notebook / JupyterLab

Para iniciar el servidor de Jupyter:

```bash
cd /Users/francomolochegarcia/dev/mx-img/experiments

# Activar el entorno virtual
source .venv/bin/activate

# Iniciar Jupyter Lab
jupyter lab

# O si prefieres Jupyter Notebook clásico:
# jupyter notebook
```

Alternativamente, sin activar manualmente el entorno en tu shell:

```bash
/Users/francomolochegarcia/dev/mx-img/experiments/.venv/bin/jupyter lab
```

---

## 4. Estructura de Trabajo Sugerida en `experiments/`

- `notebooks/`: Cuadernos `.ipynb` de pruebas (ej. filtrado paso bajo progresivo, compresión de coeficientes, streaming por paquetes de frecuencias).
- `data/` o `sample_images/`: Imágenes de prueba (ej. patrones de alta/baja frecuencia, fotografías, texturas).
- `src/`: Funciones auxiliares modulares en Python que luego puedan adaptarse a la arquitectura final o servir de referencia para el cliente/servidor.
