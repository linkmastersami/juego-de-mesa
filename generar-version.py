#!/usr/bin/env python3
"""Genera version.json: lista de archivos del juego (index, cartas, música, iconos...)
con una huella de cada uno. El juego lo lee para saber si hay algo nuevo que actualizar.

Uso manual:  python3 generar-version.py   (desde la carpeta del juego, junto a index.html)
Con GitHub:  lo ejecuta solo el workflow .github/workflows/version.yml en cada subida."""
import hashlib, json, os

RAIZ = os.path.dirname(os.path.abspath(__file__))
EXT = {'.html', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico',
       '.mp3', '.ogg', '.m4a', '.wav', '.json'}
IGNORAR = {'version.json'}

archivos = {}
for carpeta, subs, nombres in os.walk(RAIZ):
    subs[:] = sorted(d for d in subs if not d.startswith('.') and d != 'node_modules')
    for n in sorted(nombres):
        if n in IGNORAR or n.startswith('.') or os.path.splitext(n)[1].lower() not in EXT:
            continue
        ruta = os.path.join(carpeta, n)
        rel = os.path.relpath(ruta, RAIZ).replace(os.sep, '/')
        with open(ruta, 'rb') as f:
            archivos[rel] = hashlib.sha1(f.read()).hexdigest()[:12]

resumen = hashlib.sha1(json.dumps(archivos, sort_keys=True).encode()).hexdigest()[:12]
with open(os.path.join(RAIZ, 'version.json'), 'w', encoding='utf-8') as f:
    json.dump({'version': resumen, 'files': archivos}, f, ensure_ascii=False, indent=1, sort_keys=True)
    f.write('\n')
print(f'version.json listo: {len(archivos)} archivos · versión {resumen}')
