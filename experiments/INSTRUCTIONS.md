# Entorno Conda

Todos los comandos se ejecutan desde la raíz del proyecto.

## Comandos rápidos

```bash
# Crear entorno (primera vez)
conda env create -f environment.yml

# Registrar kernel para Antigravity IDE
python -m ipykernel install --user --name mx-img --display-name "Python (mx-img)"

# Actualizar si cambia environment.yml
conda env update -f environment.yml --prune
```

## Uso en Antigravity IDE

1. Abre el notebook [experiments/notebooks/2026-10.ipynb](notebooks/2026-10.ipynb).
2. Arriba a la derecha selecciona el kernel: **`Python (mx-img)`**.
