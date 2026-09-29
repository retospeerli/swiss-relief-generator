Swiss Relief STL Generator v0.6.17

Daten: swissALTI³D · swissALTIRegio · swissBUILDINGS³D · Quelle: swisstopo

# Swiss Relief STL Generator

**Autor:** Reto Speerli

## v0.6 – Abdeckung und Kachelgrenzen

- STAC-Abfrage wird aus der tatsächlichen LV95-Modellfläche berechnet, nicht aus dem ursprünglichen Kartenrechteck.
- Automatischer Coverage-Recovery-Pass für fehlende Zielrasterpunkte.
- Exaktes LV95-Sampling auf nativen GeoTIFF-Pixeln.
- Werte auf gemeinsamen 1-km-Kachelgrenzen werden gemittelt statt von einem zufälligen Download überschrieben.
- Interpolation wird erst nach vollständigem Quellen-Fallback und nur für winzige isolierte NoData-Reste verwendet.
- Keine STL-Ausgabe, solange echte Lücken vorhanden sind.


Reine Browser-Web-App für 3D-druckbare Gelände-Reliefs aus **swissALTI³D** von swisstopo. Läuft ohne Backend auf GitHub Pages.

## Version 0.2 – Robustheits-/Performance-Update

- automatische Wahl zwischen 2-m- und 0,5-m-Quelle passend zur tatsächlichen Mesh-Auflösung
- 2-m-COGs werden als kompakte Komplettdatei geladen (~1 MB/Kachel statt ~26 MB bei 0,5 m)
- bis zu 6 Kacheln parallel
- Wiederholungsversuche bei Netzwerkfehlern
- Fallback auf ältere Jahrgänge derselben 1-km-Kachel
- Fallback auf alternative Auflösung
- kleine NoData-Restlücken werden interpoliert
- **keine STL bei verbleibenden Höhenlücken** – rechteckige Krater durch fehlende Kacheln werden nicht mehr exportiert
- korrigierte Berechnung der STL-Dreiecksanzahl/Puffergrösse (behebt `RangeError: Offset is outside the bounds of the DataView`)

## Installation auf GitHub Pages

1. Inhalt dieses Ordners in das Repository kopieren.
2. GitHub → Settings → Pages.
3. `Deploy from a branch`, Branch `main`, Ordner `/ (root)`.
4. Speichern.

Es ist kein Build-Schritt erforderlich.

## Bedienung

1. Rechteck auf der Karte aufziehen.
2. Modellbreite, Basis, Höhenüberhöhung und Mesh-Auflösung wählen.
3. `Automatisch – empfohlen` bei Quelldaten belassen.
4. Relief laden.
5. Nach erfolgreicher vollständiger Datenprüfung STL herunterladen.

## Warum Automatik?

swissALTI³D wird in 1-km²-Kacheln angeboten. Eine 0,5-m-COG-Kachel ist laut swisstopo ungefähr 26 MB gross, eine 2-m-COG-Kachel ungefähr 1 MB. Bei grossflächigen Druckreliefs liegt der Abstand der STL-Meshpunkte meist deutlich über 2 m in der Realität; dann liefert 0,5 m keine zusätzliche druckbare Geometrie, verursacht aber ein Vielfaches an Datenverkehr.

Daten: © swisstopo, swissALTI³D.


## v0.3 – Kachelnaht-Fix
- GeoTIFF-Kacheln werden nicht mehr separat auf Teilraster skaliert.
- Jeder Zielpunkt wird an seiner exakten LV95-Koordinate bilinear aus nativen Rasterpixeln berechnet.
- 1-km-Kachelgrenzen erhalten eine gezielte, gradientenerhaltende Nahtkorrektur; kein globaler Blur.

## Grenzgebiete (v0.6)
Wenn swissALTI3D am Landesrand keine Daten mehr liefert, ergänzt die App fehlende Rasterpunkte automatisch aus swissALTIRegio (10 m, LV95). Bereits vorhandene hochauflösende swissALTI3D-Punkte werden nicht überschrieben. swissALTIRegio reicht mindestens 100 km über die Schweizer Landesgrenze hinaus.


## Neu in v0.6 – optionale Gebäude

- Checkbox **Gebäude darstellen (swissBUILDINGS³D)**.
- Die Checkbox wird nur freigeschaltet, wenn der Druckmassstab für Gebäude sinnvoll ist (standardmässig bis etwa 1:15'000) und die gewählte Fläche nicht zu gross ist.
- Quelle: offizieller 3D-Tiles-Dienst `ch.swisstopo.swissbuildings3d.3d`.
- Gebäude werden an das bereits berechnete Terrain angeglichen und zusammen mit dem Relief in dieselbe STL geschrieben.
- Bei kleinen Druckmassstäben wird die Gebäudehöhe druckgerecht verstärkt, damit typische Gebäude nicht unter der praktisch druckbaren Höhe verschwinden.
- Bei ungeeignetem Massstab oder zu grosser Fläche deaktiviert die App die Checkbox automatisch und nennt den Grund.

Die Gebäudefunktion ist für Orts-, Quartier- und kleinere Landschaftsmodelle gedacht. Für Kantons- oder Grossregionsmodelle bleibt sie bewusst deaktiviert.


## v0.6.9
Gebäude an Hanglagen werden nicht mehr punktweise an das Gelände verformt. Die Gebäudehöhe bleibt geometrisch stabil; untere Fassadenkanten werden lokal bis leicht unter die Terrainoberfläche verlängert, damit keine schwebenden Häuser/Sockel entstehen.


## v0.6.17
- Gebäude werden nicht mehr mit der Gelände-Höhenüberhöhung gestreckt.
- Jeder zusammenhängende Gebäudekörper bleibt geometrisch starr und erhält nur einen konstanten Z-Versatz passend zur lokalen Terrain-Überhöhung.
- Fundamente werden weiterhin nur nach unten ins Gelände verlängert.


## v0.6.17
Randgebäude werden nicht mehr dreiecksweise abgeschnitten. Jeder zusammenhängende Gebäudekörper, der den Reliefrahmen überschreitet, wird vollständig ausgelassen. Dadurch entstehen am Modellrand keine offenen Gebäude-Meshes.
