# Debian 13 (trixie): enthält PrusaSlicer ≥ 2.9 (Klipper-G-Code für den Adventurer 5M)
FROM python:3.13-slim-trixie
# 3D-Konverter: assimp-utils (ca. 70 Formate), openscad (.scad), blender (.blend/USD/Alembic/FBX), libglu1-mesa & Co. für gmsh (STEP/IGES)
# ffmpeg: Vorschaubilder und Video-Schnitt · fonts-dejavu-core: Schriften für Texteinblendungen · prusa-slicer: 3D-Druckaufträge slicen (nur Kommandozeile, kein Bildschirm nötig)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg prusa-slicer fonts-dejavu-core \
    assimp-utils openscad blender libglu1-mesa libxcursor1 libxft2 libxinerama1 libgomp1 \
    libgl1 libopengl0 libxrender1 libxext6 libsm6 libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
# Oberfläche der 3D-Drucker-Ansicht (dieselbe wie in der Druckmonitor-App)
COPY druckmonitor/web ./druckmonitor/web
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
