# Debian 13 (trixie): enthält PrusaSlicer ≥ 2.9 (Klipper-G-Code für den Adventurer 5M)
FROM python:3.13-slim-trixie
# ffmpeg: Vorschaubilder · prusa-slicer: 3D-Druckaufträge slicen (nur Kommandozeile, kein Bildschirm nötig)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg prusa-slicer && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
# Oberfläche der 3D-Drucker-Ansicht (dieselbe wie in der Druckmonitor-App)
COPY druckmonitor/web ./druckmonitor/web
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
