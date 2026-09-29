import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/DRACOLoader.js';

const STAC_COLLECTION = 'ch.swisstopo.swissalti3d';
const STAC_ITEMS = `https://data.geo.admin.ch/api/stac/v1/collections/${STAC_COLLECTION}/items`;
const REGIO_COLLECTION = 'ch.swisstopo.swissaltiregio';
const APP_VERSION = '0.6.17';
const REGIO_ITEMS = `https://data.geo.admin.ch/api/stac/v1/collections/${REGIO_COLLECTION}/items`;
const MAX_TILES = 1600;
const MAX_STAC_PAGES = 120;
const TILE_CONCURRENCY = 6;
const REQUEST_RETRIES = 3;
const RETRY_BASE_MS = 450;
const BUILDINGS_TILESET = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';
const BUILDING_MAX_SCALE = 15000;
const BUILDING_MAX_AREA_KM2 = 60;
const BUILDING_MIN_TYPICAL_WIDTH_MM = 0.55;
const BUILDING_TYPICAL_WIDTH_M = 8;
const BUILDING_MIN_TYPICAL_HEIGHT_MM = 0.8;
const BUILDING_TYPICAL_HEIGHT_M = 10;
const BUILDING_MAX_TRIANGLES = 1500000;

const APP_DATASETS = 'swissALTI³D · swissALTIRegio · swissBUILDINGS³D';
const APP_SOURCE = 'swisstopo';

const $ = (id) => document.getElementById(id);
const els = {
  generateBtn: $('generateBtn'), downloadBtn: $('downloadBtn'), clearBtn: $('clearBtn'), resetViewBtn: $('resetViewBtn'),
  sourceResolution: $('sourceResolution'), modelWidth: $('modelWidth'), baseThickness: $('baseThickness'),
  zExaggeration: $('zExaggeration'), gridSize: $('gridSize'), smoothMissing: $('smoothMissing'), includeBuildings: $('includeBuildings'), buildingEligibility: $('buildingEligibility'),
  selectionInfo: $('selectionInfo'), metrics: $('metrics'), statusText: $('statusText'), statusPct: $('statusPct'),
  progress: $('progress'), preview: $('preview'), resultInfo: $('resultInfo'), debug: $('debug')
};

const versionEl = $('appVersion');
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
document.title = `Swiss Relief STL Generator v${APP_VERSION} · ${APP_DATASETS} · Quelle: ${APP_SOURCE}`;

let selectedBounds = null;
let selectedLayer = null;
let terrain = null;
let lastStlBlob = null;
let renderer, scene, camera, controls, terrainGroup;
let lastBuildingTriangles = null;
let lastBuildingMeta = null;
let TilesRendererClass = null;
let CsgModulePromise = null;
let BufferUtilsPromise = null;

async function getTilesRendererClass() {
  if (TilesRendererClass) return TilesRendererClass;
  try {
    // Gebäudecode darf die Grund-App niemals blockieren. Dieses Modul wird erst
    // geladen, wenn Gebäude ausdrücklich aktiviert wurden. esm.sh löst die
    // Paketabhängigkeiten browsergerecht auf; THREE bleibt über die Importmap extern.
    const mod = await import('https://esm.sh/3d-tiles-renderer@0.5.3?external=three');
    TilesRendererClass = mod.TilesRenderer;
    if (!TilesRendererClass) throw new Error('TilesRenderer-Export fehlt');
    return TilesRendererClass;
  } catch (err) {
    throw new Error(`Gebäudemodul konnte nicht geladen werden: ${err?.message || err}`);
  }
}

// CH1903+ / LV95 (EPSG:2056). proj4 contains the transformation logic; definition is explicit for portability.
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');

const map = L.map('map', { zoomControl: true }).setView([46.82, 8.23], 8);
L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
  maxZoom: 19,
  attribution: '© swisstopo'
}).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  draw: { polygon: false, polyline: false, circle: false, circlemarker: false, marker: false, rectangle: { shapeOptions: { color: '#b82025', weight: 2 } } },
  edit: { featureGroup: drawnItems, edit: false, remove: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  selectedLayer = e.layer;
  drawnItems.addLayer(selectedLayer);
  selectedBounds = selectedLayer.getBounds();
  terrain = null;
  lastStlBlob = null;
  lastBuildingTriangles = null;
  lastBuildingMeta = null;
  els.downloadBtn.disabled = true;
  updateSelectionUI();
});

els.clearBtn.addEventListener('click', () => {
  drawnItems.clearLayers();
  selectedBounds = null;
  selectedLayer = null;
  terrain = null;
  lastStlBlob = null;
  lastBuildingTriangles = null;
  lastBuildingMeta = null;
  els.generateBtn.disabled = true;
  els.downloadBtn.disabled = true;
  els.selectionInfo.textContent = 'Noch kein Gebiet gewählt.';
  els.resultInfo.textContent = '';
  updateMetrics();
updateBuildingEligibility();
  clearPreview();
});

['input','change'].forEach(evt => {
  [els.modelWidth, els.baseThickness, els.zExaggeration, els.gridSize, els.sourceResolution, els.includeBuildings].forEach(el => el.addEventListener(evt, () => {
    updateMetrics();
    if (lastStlBlob) {
      lastStlBlob = null;
      lastBuildingTriangles = null;
      lastBuildingMeta = null;
      els.downloadBtn.disabled = true;
      els.resultInfo.textContent = 'Einstellungen geändert – Relief bitte neu erzeugen.';
    }
  }));
});

els.generateBtn.addEventListener('click', generateTerrain);
els.downloadBtn.addEventListener('click', downloadStl);
els.resetViewBtn.addEventListener('click', resetCamera);
window.addEventListener('resize', resizePreview);

function lv95FromLonLat(lon, lat) {
  return proj4('EPSG:4326', 'EPSG:2056', [lon, lat]);
}

function lonLatFromLv95(x, y) {
  return proj4('EPSG:2056', 'EPSG:4326', [x, y]);
}

function projectedExtent(bounds) {
  const corners = [
    [bounds.getWest(), bounds.getSouth()], [bounds.getEast(), bounds.getSouth()],
    [bounds.getEast(), bounds.getNorth()], [bounds.getWest(), bounds.getNorth()]
  ].map(([lon,lat]) => lv95FromLonLat(lon,lat));
  return {
    minX: Math.min(...corners.map(p => p[0])), maxX: Math.max(...corners.map(p => p[0])),
    minY: Math.min(...corners.map(p => p[1])), maxY: Math.max(...corners.map(p => p[1]))
  };
}

function modelDimensions() {
  if (!selectedBounds) return null;
  const ext = projectedExtent(selectedBounds);
  const groundW = ext.maxX - ext.minX;
  const groundH = ext.maxY - ext.minY;
  const widthMm = Math.max(1, Number(els.modelWidth.value) || 220);
  const depthMm = widthMm * groundH / groundW;
  return { ...ext, groundW, groundH, widthMm, depthMm, mmPerMeter: widthMm / groundW };
}

function updateSelectionUI() {
  if (!selectedBounds) return;
  const d = modelDimensions();
  const areaKm2 = d.groundW * d.groundH / 1e6;
  els.selectionInfo.textContent = `${(d.groundW/1000).toFixed(2)} × ${(d.groundH/1000).toFixed(2)} km · ca. ${areaKm2.toFixed(1)} km²`;
  els.generateBtn.disabled = false;
  updateMetrics();
}

function updateMetrics() {
  const rows = els.metrics.querySelectorAll('b');
  if (!selectedBounds) { rows.forEach(x => x.textContent = '–'); return; }
  const d = modelDimensions();
  const maxN = Number(els.gridSize.value);
  const cols = d.groundW >= d.groundH ? maxN : Math.max(2, Math.round(maxN * d.groundW / d.groundH));
  const rowsN = d.groundH >= d.groundW ? maxN : Math.max(2, Math.round(maxN * d.groundH / d.groundW));
  const spacing = d.widthMm / Math.max(1, cols - 1);
  const tri = 2 * (cols - 1) * (rowsN - 1) + 2 * ((cols - 1) + (rowsN - 1)) + 2;
  rows[0].textContent = `${d.widthMm.toFixed(0)} × ${d.depthMm.toFixed(1)} mm`;
  rows[1].textContent = `1 : ${Math.round(d.groundW * 1000 / d.widthMm).toLocaleString('de-CH')}`;
  rows[2].textContent = `${spacing.toFixed(3)} mm`;
  rows[3].textContent = `${(tri/1e6).toFixed(2)} Mio.`;
  updateBuildingEligibility(d);
}

function buildingEligibility(d = null) {
  if (!selectedBounds) return { ok:false, reason:'Zuerst ein Gebiet wählen.' };
  d = d || modelDimensions();
  const scale = d.groundW * 1000 / d.widthMm;
  const areaKm2 = d.groundW * d.groundH / 1e6;
  const typicalWidthMm = BUILDING_TYPICAL_WIDTH_M * d.mmPerMeter;
  if (scale > BUILDING_MAX_SCALE || typicalWidthMm < BUILDING_MIN_TYPICAL_WIDTH_MM) {
    return { ok:false, scale, areaKm2, reason:`Massstab zu klein: ca. 1:${Math.round(scale).toLocaleString('de-CH')}. Gebäude werden bis etwa 1:${BUILDING_MAX_SCALE.toLocaleString('de-CH')} freigeschaltet.` };
  }
  if (areaKm2 > BUILDING_MAX_AREA_KM2) {
    return { ok:false, scale, areaKm2, reason:`Fläche zu gross (${areaKm2.toFixed(1)} km²). Für Gebäude maximal ${BUILDING_MAX_AREA_KM2} km² wählen.` };
  }
  return { ok:true, scale, areaKm2, typicalWidthMm, reason:`Geeignet: ca. 1:${Math.round(scale).toLocaleString('de-CH')} · typische 8-m-Gebäudebreite ≈ ${typicalWidthMm.toFixed(2)} mm.` };
}

function updateBuildingEligibility(d = null) {
  if (!els.includeBuildings || !els.buildingEligibility) return;
  const e = buildingEligibility(d);
  els.includeBuildings.disabled = !e.ok;
  if (!e.ok && els.includeBuildings.checked) els.includeBuildings.checked = false;
  els.buildingEligibility.textContent = e.reason;
  els.buildingEligibility.className = `building-hint ${e.ok ? 'ok' : 'warn'}`;
}

function setStatus(text, pct = null) {
  els.statusText.textContent = text;
  if (pct == null) { els.statusPct.textContent = ''; return; }
  const v = Math.max(0, Math.min(100, pct));
  els.progress.value = v;
  els.statusPct.textContent = `${Math.round(v)} %`;
}

function debug(text) {
  els.debug.textContent += `${text}\n`;
  els.debug.scrollTop = els.debug.scrollHeight;
}

function stacBbox(bounds) {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(v => v.toFixed(8)).join(',');
}

// IMPORTANT: the STL grid is an axis-aligned LV95 rectangle. A Leaflet/WGS84
// rectangle transformed to LV95 is not exactly the same area. Query STAC from
// the actual LV95 model rectangle, otherwise narrow uncovered strips can appear
// at the model edges. Padding is in metres and only affects catalogue discovery.
function stacBboxForDims(d, paddingM = 100) {
  const corners = [
    [d.minX - paddingM, d.minY - paddingM],
    [d.maxX + paddingM, d.minY - paddingM],
    [d.maxX + paddingM, d.maxY + paddingM],
    [d.minX - paddingM, d.maxY + paddingM]
  ].map(([x, y]) => lonLatFromLv95(x, y));
  const lons = corners.map(p => p[0]);
  const lats = corners.map(p => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
    .map(v => v.toFixed(8)).join(',');
}

async function fetchStacItemsForBbox(bboxString, itemsUrl = STAC_ITEMS, label = 'STAC-Katalog') {
  let url = `${itemsUrl}?bbox=${encodeURIComponent(bboxString)}&limit=100`;
  const all = [];
  let page = 0;
  while (url && page < MAX_STAC_PAGES) {
    page++;
    setStatus(`${label} abfragen · Seite ${page}`, Math.min(12, page));
    const r = await fetchWithRetry(url, { cache: 'no-cache' });
    const json = await r.json();
    all.push(...(json.features || []));
    if (all.length > 12000) throw new Error('Zu viele STAC-Einträge. Bitte einen kleineren Ausschnitt wählen.');
    const next = (json.links || []).find(l => l.rel === 'next');
    url = next?.href ? new URL(next.href, itemsUrl).href : null;
  }
  if (page >= MAX_STAC_PAGES && url) throw new Error('Sehr grosser Ausschnitt: STAC-Seitenlimit erreicht. Bitte Gebiet verkleinern.');
  return all;
}

function tileKey(item) {
  const m = String(item.id || '').match(/(\d{4}-\d{4})$/);
  if (m) return m[1];
  const b = item.bbox || [];
  return b.length >= 4 ? b.map(v => Number(v).toFixed(5)).join('/') : item.id;
}

function itemYear(item) {
  const dt = item.properties?.datetime || item.properties?.start_datetime || '';
  const y = Number(String(dt).slice(0,4));
  if (Number.isFinite(y)) return y;
  const m = String(item.id || '').match(/_(\d{4})_/);
  return m ? Number(m[1]) : 0;
}

function findGeoTiffAsset(item, resolution) {
  const assets = Object.values(item.assets || {});
  const candidates = assets.filter(a => {
    const href = String(a.href || '');
    const type = String(a.type || '').toLowerCase();
    const gsd = Number(a['eo:gsd']);
    const isTif = /\.tiff?(?:$|\?)/i.test(href) || type.includes('geotiff') || type.includes('image/tiff');
    return isTif && Math.abs(gsd - resolution) < 1e-9;
  });
  if (candidates.length) return candidates[0];
  // Fallback for older metadata where eo:gsd may be absent.
  const token = resolution === 0.5 ? '_0.5_' : '_2_';
  return assets.find(a => /\.tiff?(?:$|\?)/i.test(String(a.href || '')) && String(a.href).includes(token)) || null;
}

function groupTileCandidates(items) {
  const groups = new Map();
  for (const item of items) {
    const key = tileKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const arr of groups.values()) arr.sort((a, b) => itemYear(b) - itemYear(a));
  return groups;
}

function makeTilePlans(items, preferredResolution) {
  const groups = groupTileCandidates(items);
  const fallbackResolution = preferredResolution === 0.5 ? 2 : 0.5;
  const plans = [];
  for (const [key, versions] of groups) {
    const candidates = [];
    // First try newest versions in the requested/automatic resolution.
    for (const item of versions) {
      const asset = findGeoTiffAsset(item, preferredResolution);
      if (asset) candidates.push({ item, asset, resolution: preferredResolution });
    }
    // If that fails, prefer 2 m as a compact and very robust fallback.
    // For a forced 2 m request we only add 0.5 m after all 2 m versions.
    for (const item of versions) {
      const asset = findGeoTiffAsset(item, fallbackResolution);
      if (asset) candidates.push({ item, asset, resolution: fallbackResolution });
    }
    if (candidates.length) plans.push({ key, candidates });
  }
  return plans;
}

function chooseAutomaticResolution(d, grid) {
  const sx = d.groundW / Math.max(1, grid.cols - 1);
  const sy = d.groundH / Math.max(1, grid.rows - 1);
  const meshGroundSpacing = Math.max(sx, sy);
  // 2 m source is still comfortably finer than a mesh with >= 4 m spacing.
  // This reduces a typical tile from ~26 MB to ~1 MB without reducing STL detail.
  return meshGroundSpacing >= 4 ? 2 : 0.5;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithRetry(url, options = {}, retries = REQUEST_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < retries) await sleep(RETRY_BASE_MS * (2 ** attempt));
    }
  }
  throw lastErr || new Error('Download fehlgeschlagen');
}

function outputGrid(d) {
  const maxN = Number(els.gridSize.value);
  let cols, rows;
  if (d.groundW >= d.groundH) {
    cols = maxN;
    rows = Math.max(2, Math.round(maxN * d.groundH / d.groundW));
  } else {
    rows = maxN;
    cols = Math.max(2, Math.round(maxN * d.groundW / d.groundH));
  }
  return {
    cols, rows,
    values: new Float32Array(cols * rows).fill(NaN),
    sums: new Float64Array(cols * rows),
    counts: new Uint16Array(cols * rows)
  };
}

function indexRangeForTile(tileBox, d, grid) {
  const overlap = {
    minX: Math.max(tileBox[0], d.minX), minY: Math.max(tileBox[1], d.minY),
    maxX: Math.min(tileBox[2], d.maxX), maxY: Math.min(tileBox[3], d.maxY)
  };
  if (overlap.maxX <= overlap.minX || overlap.maxY <= overlap.minY) return null;
  const fx = (x) => (x - d.minX) / d.groundW * (grid.cols - 1);
  // Output row 0 represents north/maxY.
  const fy = (y) => (d.maxY - y) / d.groundH * (grid.rows - 1);
  const c0 = Math.max(0, Math.floor(fx(overlap.minX)));
  const c1 = Math.min(grid.cols - 1, Math.ceil(fx(overlap.maxX)));
  const r0 = Math.max(0, Math.floor(fy(overlap.maxY)));
  const r1 = Math.min(grid.rows - 1, Math.ceil(fy(overlap.minY)));
  return { c0, c1, r0, r1 };
}

async function sampleTile(url, d, grid, resolution = 2, options = {}) {
  const { onlyMissing = false, forceRange = false } = options;
  let tiff;
  // 2 m COGs are small enough to download completely. 0.5 m COGs continue
  // to use HTTP range access so a large landscape remains practical.
  if (resolution >= 2 && !forceRange) {
    const response = await fetchWithRetry(url, { cache: 'force-cache' });
    const buffer = await response.arrayBuffer();
    tiff = await GeoTIFF.fromArrayBuffer(buffer);
  } else {
    let lastErr;
    for (let attempt = 0; attempt < REQUEST_RETRIES; attempt++) {
      try {
        tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false, cacheSize: 64 * 1024 * 1024 });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt + 1 < REQUEST_RETRIES) await sleep(RETRY_BASE_MS * (2 ** attempt));
      }
    }
    if (!tiff) throw lastErr || new Error('GeoTIFF konnte nicht geöffnet werden');
  }

  try {
    const image = await tiff.getImage();
    const box = image.getBoundingBox(); // pixel-edge bbox [minX,minY,maxX,maxY]
    const ir = indexRangeForTile(box, d, grid);
    if (!ir) return 0;

    const imgW = image.getWidth(), imgH = image.getHeight();
    const resX = (box[2] - box[0]) / imgW;
    const resY = (box[3] - box[1]) / imgH;

    // Read native pixels around the required output points. Do NOT ask
    // GeoTIFF.js to resize every tile independently: independent resize grids
    // are the main cause of visible 1-km seams in the final terrain.
    const xMin = d.minX + ir.c0 / (grid.cols - 1) * d.groundW;
    const xMax = d.minX + ir.c1 / (grid.cols - 1) * d.groundW;
    const yMax = d.maxY - ir.r0 / (grid.rows - 1) * d.groundH;
    const yMin = d.maxY - ir.r1 / (grid.rows - 1) * d.groundH;

    // Pixel centres are half a pixel inside the bounding box. Keep a small
    // native-pixel halo for bilinear interpolation right across tile edges.
    const px0f = (xMin - box[0]) / resX - 0.5;
    const px1f = (xMax - box[0]) / resX - 0.5;
    const py0f = (box[3] - yMax) / resY - 0.5;
    const py1f = (box[3] - yMin) / resY - 0.5;
    const wx0 = Math.max(0, Math.floor(Math.min(px0f, px1f)) - 2);
    const wx1 = Math.min(imgW, Math.ceil(Math.max(px0f, px1f)) + 3);
    const wy0 = Math.max(0, Math.floor(Math.min(py0f, py1f)) - 2);
    const wy1 = Math.min(imgH, Math.ceil(Math.max(py0f, py1f)) + 3);
    if (wx1 <= wx0 || wy1 <= wy0) return 0;

    const data = await image.readRasters({
      window: [wx0, wy0, wx1, wy1], samples: [0], interleave: true
    });
    const srcW = wx1 - wx0, srcH = wy1 - wy0;
    const noDataRaw = image.getGDALNoData();
    const noData = noDataRaw == null ? null : Number(noDataRaw);

    const valid = (v) => Number.isFinite(v) && !(noData != null && Math.abs(v - noData) < 1e-6) && v >= -1000;
    const at = (x, y) => {
      x = Math.max(0, Math.min(srcW - 1, x));
      y = Math.max(0, Math.min(srcH - 1, y));
      return Number(data[y * srcW + x]);
    };

    const bilinearAtMap = (x, y) => {
      // Convert the exact global LV95 coordinate to native pixel-centre space.
      const px = (x - box[0]) / resX - 0.5 - wx0;
      const py = (box[3] - y) / resY - 0.5 - wy0;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const tx = px - x0, ty = py - y0;
      const v00 = at(x0, y0), v10 = at(x0 + 1, y0);
      const v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
      if (valid(v00) && valid(v10) && valid(v01) && valid(v11)) {
        const a = v00 * (1 - tx) + v10 * tx;
        const b = v01 * (1 - tx) + v11 * tx;
        return a * (1 - ty) + b * ty;
      }
      // Near a NoData edge use the nearest valid native sample instead of
      // inventing a low value that could create a trench.
      const nearest = [v00, v10, v01, v11].filter(valid);
      return nearest.length ? nearest.reduce((a,b) => a+b, 0) / nearest.length : NaN;
    };

    let written = 0;
    for (let r = ir.r0; r <= ir.r1; r++) {
      const y = d.maxY - r / (grid.rows - 1) * d.groundH;
      // Tile bbox is half-open for ownership. This prevents neighbouring
      // workers from alternately overwriting the same grid line.
      if (y < box[1] - 1e-6 || y > box[3] + 1e-6) continue;
      for (let c = ir.c0; c <= ir.c1; c++) {
        const x = d.minX + c / (grid.cols - 1) * d.groundW;
        if (x < box[0] - 1e-6 || x > box[2] + 1e-6) continue;
        const v = bilinearAtMap(x, y);
        if (!valid(v)) continue;
        const gi = r * grid.cols + c;
        if (onlyMissing && Number.isFinite(grid.values[gi])) continue;
        // Average samples where adjacent 1-km tiles meet. At a tile boundary
        // each raster can only interpolate from its own interior pixel centres;
        // averaging both sides reconstructs the boundary value and removes the
        // characteristic horizontal/vertical 'weld seam' without blurring terrain.
        const wasMissing = grid.counts[gi] === 0;
        grid.sums[gi] += v;
        grid.counts[gi] += 1;
        grid.values[gi] = grid.sums[gi] / grid.counts[gi];
        if (wasMissing) written++;
      }
    }
    return written;
  } finally {
    if (typeof tiff?.close === 'function') tiff.close();
  }
}

async function loadTilePlan(plan, d, grid) {
  const errors = [];
  for (const candidate of plan.candidates) {
    try {
      const written = await sampleTile(candidate.asset.href, d, grid, candidate.resolution);
      if (written > 0) return { written, candidate, errors };
      errors.push(`${candidate.item.id} (${candidate.resolution} m): kein Überlappungsbereich`);
    } catch (err) {
      errors.push(`${candidate.item.id} (${candidate.resolution} m): ${err.message}`);
    }
  }
  return { written: 0, candidate: null, errors };
}

async function loadPlansConcurrent(plans, d, grid, progressCb) {
  let next = 0, done = 0, totalWritten = 0;
  const failed = [];
  const fallbackUsed = [];

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= plans.length) return;
      const plan = plans[i];
      const result = await loadTilePlan(plan, d, grid);
      totalWritten += result.written;
      if (!result.candidate) failed.push({ plan, errors: result.errors });
      else if (result.candidate !== plan.candidates[0]) fallbackUsed.push(result.candidate);
      done++;
      progressCb(done, plans.length);
      if (done % 12 === 0) await sleep(0);
    }
  }

  const workers = Array.from({ length: Math.min(TILE_CONCURRENCY, plans.length) }, () => worker());
  await Promise.all(workers);
  return { totalWritten, failed, fallbackUsed };
}

function fillSmallGaps(grid, passes = 12) {
  const { cols, rows } = grid;
  let src = grid.values;
  let totalChanged = 0;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    const dst = new Float32Array(src);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (Number.isFinite(src[i])) continue;
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const v = src[rr * cols + cc];
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      if (n >= 4) { dst[i] = sum / n; changed++; }
    }
    src = dst;
    totalChanged += changed;
    if (!changed) break;
  }
  grid.values = src;
  return totalChanged;
}

// Remove only step-like artefacts exactly on the 1-km swissALTI tile grid.
// We compare the cross-boundary jump with the local slopes on both sides and
// distribute only the anomalous component over a few cells. Genuine terrain
// slope is retained; this is deliberately not a global blur.
function missingTileKeys(grid, d, neighbourRing = 1) {
  const keys = new Set();
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (Number.isFinite(grid.values[i])) continue;
      const x = d.minX + c / (grid.cols - 1) * d.groundW;
      const y = d.maxY - r / (grid.rows - 1) * d.groundH;
      const tx = Math.floor(x / 1000);
      const ty = Math.floor(y / 1000);
      for (let dx = -neighbourRing; dx <= neighbourRing; dx++) {
        for (let dy = -neighbourRing; dy <= neighbourRing; dy++) {
          keys.add(`${tx + dx}-${ty + dy}`);
        }
      }
    }
  }
  return keys;
}

async function recoverMissingCoverage(grid, d, preferredResolution, progressBase = 82) {
  let stats = terrainStats(grid);
  if (!stats.missing) return { passes: 0, recovered: 0, queried: 0 };
  const before = stats.missing;
  let queried = 0;

  // A larger catalogue bbox guarantees that tiles intersecting the true LV95
  // model rectangle are discoverable even close to projection/selection edges.
  for (let pass = 1; pass <= 2 && stats.missing > 0; pass++) {
    const needed = missingTileKeys(grid, d, 1);
    const bbox = stacBboxForDims(d, pass === 1 ? 1600 : 2600);
    setStatus(`Abdeckung vervollständigen · Durchgang ${pass}`, progressBase + pass * 2);
    const items = await fetchStacItemsForBbox(bbox);
    queried += items.length;
    const plans = makeTilePlans(items, preferredResolution).filter(p => needed.has(p.key));
    if (!plans.length) break;
    await loadPlansConcurrent(plans, d, grid, () => {});
    stats = terrainStats(grid);
  }
  return { passes: 2, recovered: before - stats.missing, queried };
}

function findAnyGeoTiffAsset(item) {
  const assets = Object.values(item.assets || {});
  const tiffs = assets.filter(a => {
    const href = String(a.href || '');
    const type = String(a.type || '').toLowerCase();
    return /\.tiff?(?:$|\?)/i.test(href) || type.includes('geotiff') || type.includes('image/tiff');
  });
  return tiffs.find(a => /2056_5728/i.test(String(a.href || ''))) || tiffs[0] || null;
}

function findRegioXyzAssets(item) {
  const out = [];
  for (const [key, a] of Object.entries(item.assets || {})) {
    const href = String(a?.href || '');
    const type = String(a?.type || '').toLowerCase();
    const title = String(a?.title || '');
    const hay = `${key} ${href} ${type} ${title}`.toLowerCase();
    // swissALTIRegio is distributed both as one huge COG and as 10×10-km
    // ASCII XYZ tiles. Prefer the spatial XYZ tiles in a browser: they are
    // finite downloads (~23 MB each) and avoid fragile cross-origin byte-range
    // access to the ~12-GB national COG.
    if (/\.xyz(?:\.zip)?(?:$|\?)/i.test(href) || (hay.includes('xyz') && (hay.includes('zip') || type.includes('text/plain')))) {
      out.push(a);
    }
  }
  return out;
}

function decodeRegioTextFromBytes(bytes, url) {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return new TextDecoder('utf-8').decode(bytes);
  if (!globalThis.fflate?.unzipSync) throw new Error('ZIP-Dekompressor (fflate) nicht geladen');
  const files = globalThis.fflate.unzipSync(bytes);
  const entries = Object.entries(files)
    .filter(([name, data]) => data?.length && !name.endsWith('/'))
    .sort((a, b) => {
      const ax = /\.(xyz|txt|asc)$/i.test(a[0]) ? 1 : 0;
      const bx = /\.(xyz|txt|asc)$/i.test(b[0]) ? 1 : 0;
      return (bx - ax) || (b[1].length - a[1].length);
    });
  if (!entries.length) throw new Error(`ZIP enthält keine XYZ-Datei: ${url}`);
  return new TextDecoder('utf-8').decode(entries[0][1]);
}

function eachXyzLine(text, cb) {
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue;
    let line = text.slice(start, i).trim();
    start = i + 1;
    if (!line || line[0] === '#') continue;
    // Official files are whitespace separated; accepting commas/semicolons
    // makes the fallback tolerant of future export variants.
    const parts = line.split(/[\s,;]+/);
    if (parts.length < 3) continue;
    const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) cb(x, y, z);
  }
}

async function sampleRegioXyzAsset(url, d, grid) {
  const response = await fetchWithRetry(url, { cache: 'force-cache' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = decodeRegioTextFromBytes(bytes, url);

  // Determine the actual regular 10-m tile bounds first. This avoids making
  // assumptions from filenames and keeps the parser compatible with any
  // official XYZ tile naming convention.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  eachXyzLine(text, (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y; n++;
  });
  if (!n || !Number.isFinite(minX)) throw new Error('XYZ-Datei enthält keine gültigen Höhenpunkte');
  if (maxX < d.minX - 20 || minX > d.maxX + 20 || maxY < d.minY - 20 || minY > d.maxY + 20) return 0;

  const step = 10;
  const cols = Math.round((maxX - minX) / step) + 1;
  const rows = Math.round((maxY - minY) / step) + 1;
  if (cols < 2 || rows < 2 || cols * rows > 2_000_000) throw new Error(`Unerwartetes swissALTIRegio-XYZ-Raster ${cols}×${rows}`);
  const src = new Float32Array(cols * rows);
  src.fill(NaN);
  eachXyzLine(text, (x, y, z) => {
    const c = Math.round((x - minX) / step);
    const r = Math.round((maxY - y) / step); // north to south
    if (c >= 0 && c < cols && r >= 0 && r < rows) src[r * cols + c] = z;
  });

  const valid = v => Number.isFinite(v) && v >= -1000;
  const at = (c, r) => {
    c = Math.max(0, Math.min(cols - 1, c));
    r = Math.max(0, Math.min(rows - 1, r));
    return src[r * cols + c];
  };
  let written = 0;
  for (let r = 0; r < grid.rows; r++) {
    const y = d.maxY - r / (grid.rows - 1) * d.groundH;
    if (y < minY - 1e-6 || y > maxY + 1e-6) continue;
    const rf = (maxY - y) / step;
    const r0 = Math.floor(rf), ty = rf - r0;
    for (let c = 0; c < grid.cols; c++) {
      const gi = r * grid.cols + c;
      if (Number.isFinite(grid.values[gi])) continue;
      const x = d.minX + c / (grid.cols - 1) * d.groundW;
      if (x < minX - 1e-6 || x > maxX + 1e-6) continue;
      const cf = (x - minX) / step;
      const c0 = Math.floor(cf), tx = cf - c0;
      const v00 = at(c0, r0), v10 = at(c0 + 1, r0), v01 = at(c0, r0 + 1), v11 = at(c0 + 1, r0 + 1);
      let v = NaN;
      if (valid(v00) && valid(v10) && valid(v01) && valid(v11)) {
        const a = v00 * (1 - tx) + v10 * tx;
        const b = v01 * (1 - tx) + v11 * tx;
        v = a * (1 - ty) + b * ty;
      } else {
        const vals = [v00, v10, v01, v11].filter(valid);
        if (vals.length) v = vals.reduce((a,b) => a+b, 0) / vals.length;
      }
      if (!valid(v)) continue;
      grid.sums[gi] += v;
      grid.counts[gi] += 1;
      grid.values[gi] = grid.sums[gi] / grid.counts[gi];
      written++;
    }
  }
  return written;
}

async function recoverWithSwissAltiRegio(grid, d, progressBase = 91) {
  const before = terrainStats(grid).missing;
  if (!before) return { recovered: 0, items: 0, assetsTried: 0, xyzTried: 0, cogTried: 0 };
  const bbox = stacBboxForDims(d, 1000);
  setStatus('Grenzgebiet: swissALTIRegio-Fallback suchen', progressBase);
  const items = await fetchStacItemsForBbox(bbox, REGIO_ITEMS, 'swissALTIRegio');

  // First choice: official 10×10-km XYZ tiles. They are much more reliable
  // from a static GitHub-Pages app than byte-range reads against the national COG.
  const xyzCandidates = [];
  const seenXyz = new Set();
  for (const item of items) {
    for (const asset of findRegioXyzAssets(item)) {
      const href = String(asset.href || '');
      if (!href || seenXyz.has(href)) continue;
      seenXyz.add(href);
      xyzCandidates.push({ item, asset });
    }
  }
  xyzCandidates.sort((a, b) => itemYear(b.item) - itemYear(a.item));
  let xyzTried = 0, cogTried = 0;
  for (const candidate of xyzCandidates) {
    if (!terrainStats(grid).missing) break;
    xyzTried++;
    try {
      const added = await sampleRegioXyzAsset(candidate.asset.href, d, grid);
      if (added) debug(`swissALTIRegio XYZ ${candidate.item.id || xyzTried}: ${added.toLocaleString('de-CH')} Punkte ergänzt.`);
    } catch (err) {
      debug(`swissALTIRegio XYZ ${candidate.item.id || xyzTried}: ${err.message}`);
    }
  }

  // Last resort only: the single national COG. It is ~12 GB, so GeoTIFF.js
  // must use HTTP range requests; some browser/CDN combinations reject them.
  if (terrainStats(grid).missing) {
    const cogCandidates = [];
    const seenCog = new Set();
    for (const item of items) {
      const asset = findAnyGeoTiffAsset(item);
      const href = String(asset?.href || '');
      if (asset && href && !seenCog.has(href)) {
        seenCog.add(href);
        cogCandidates.push({ item, asset });
      }
    }
    cogCandidates.sort((a, b) => itemYear(b.item) - itemYear(a.item));
    for (const candidate of cogCandidates) {
      if (!terrainStats(grid).missing) break;
      cogTried++;
      try {
        await sampleTile(candidate.asset.href, d, grid, 10, { onlyMissing: true, forceRange: true });
      } catch (err) {
        debug(`swissALTIRegio COG ${candidate.item.id || cogTried}: ${err.message}`);
      }
    }
  }
  return {
    recovered: before - terrainStats(grid).missing,
    items: items.length,
    assetsTried: xyzTried + cogTried,
    xyzTried,
    cogTried
  };
}

function terrainStats(grid) {
  let min = Infinity, max = -Infinity, missing = 0;
  for (const v of grid.values) {
    if (!Number.isFinite(v)) { missing++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, missing, total: grid.values.length };
}


function terrainElevationAtXY(t, x, y) {
  const { cols, rows, values } = t.grid;
  const d = t.dims;
  const cf = (x - d.minX) / d.groundW * (cols - 1);
  const rf = (d.maxY - y) / d.groundH * (rows - 1);
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(cf)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(rf)));
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, cf - c0)), ty = Math.max(0, Math.min(1, rf - r0));
  const v00 = values[r0 * cols + c0], v10 = values[r0 * cols + c1];
  const v01 = values[r1 * cols + c0], v11 = values[r1 * cols + c1];
  return (v00 * (1-tx) + v10 * tx) * (1-ty) + (v01 * (1-tx) + v11 * tx) * ty;
}

function geodeticToEcef(lonDeg, latDeg, h = 0) {
  const a = 6378137.0, e2 = 6.69437999014e-3;
  const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  const N = a / Math.sqrt(1 - e2 * sl * sl);
  return new THREE.Vector3((N+h)*cl*co, (N+h)*cl*so, (N*(1-e2)+h)*sl);
}

function ecefToGeodetic(x, y, z) {
  const a = 6378137.0, e2 = 6.69437999014e-3, b = a * Math.sqrt(1-e2);
  const ep2 = (a*a-b*b)/(b*b), p = Math.hypot(x,y);
  const th = Math.atan2(a*z, b*p);
  const sth=Math.sin(th), cth=Math.cos(th);
  const lon=Math.atan2(y,x);
  const lat=Math.atan2(z + ep2*b*sth*sth*sth, p - e2*a*cth*cth*cth);
  const sl=Math.sin(lat), N=a/Math.sqrt(1-e2*sl*sl);
  const h=p/Math.max(1e-12,Math.cos(lat))-N;
  return [lon*180/Math.PI, lat*180/Math.PI, h];
}

function percentile(arr, q) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const pos = Math.max(0, Math.min(a.length-1, Math.floor((a.length-1)*q)));
  return a[pos];
}


function cloneClipVertex(v) {
  return { x:v.x, y:v.y, p:[v.p[0], v.p[1], v.p[2]] };
}

function lerpClipVertex(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: [
      a.p[0] + (b.p[0] - a.p[0]) * t,
      a.p[1] + (b.p[1] - a.p[1]) * t,
      a.p[2] + (b.p[2] - a.p[2]) * t
    ]
  };
}

function makeBuildingClipPlanes(t) {
  return [
    { name:'xmin', axis:'x', coord:t.dims.minX, modelCoord:-t.dims.widthMm/2, keep:'ge', outward:'negx' },
    { name:'xmax', axis:'x', coord:t.dims.maxX, modelCoord: t.dims.widthMm/2, keep:'le', outward:'posx' },
    { name:'ymin', axis:'y', coord:t.dims.minY, modelCoord:-t.dims.depthMm/2, keep:'ge', outward:'negy' },
    { name:'ymax', axis:'y', coord:t.dims.maxY, modelCoord: t.dims.depthMm/2, keep:'le', outward:'posy' }
  ];
}

function clipInsidePlane(v, plane, eps = 1e-9) {
  return plane.keep === 'ge' ? v[plane.axis] >= plane.coord - eps : v[plane.axis] <= plane.coord + eps;
}

function clipPolygonAgainstPlane(poly, plane, segmentsOut) {
  if (!poly.length) return poly;
  const out = [];
  const intersections = [];
  let prev = poly[poly.length - 1];
  let prevIn = clipInsidePlane(prev, plane);
  for (const curr of poly) {
    const currIn = clipInsidePlane(curr, plane);
    if (currIn !== prevIn) {
      const denom = (curr[plane.axis] - prev[plane.axis]);
      const t = Math.abs(denom) < 1e-12 ? 0 : (plane.coord - prev[plane.axis]) / denom;
      const inter = lerpClipVertex(prev, curr, Math.max(0, Math.min(1, t)));
      inter[plane.axis] = plane.coord;
      if (plane.axis === 'x') inter.p[0] = plane.modelCoord;
      else inter.p[1] = plane.modelCoord;
      intersections.push(inter);
      out.push(inter);
    }
    if (currIn) out.push(curr);
    prev = curr; prevIn = currIn;
  }
  if (intersections.length === 2) segmentsOut.push([intersections[0], intersections[1]]);
  return out;
}

function pointKey2D(v, plane, scale = 10000) {
  const u = plane.axis === 'x' ? v.p[1] : v.p[0];
  const w = v.p[2];
  return `${Math.round(u * scale)}:${Math.round(w * scale)}`;
}

function buildCapLoopsFromSegments(segments, plane) {
  const nodeMap = new Map();
  const edges = [];
  const addNode = (v) => {
    const key = pointKey2D(v, plane);
    if (!nodeMap.has(key)) nodeMap.set(key, { key, pt:v, edges:[] });
    return nodeMap.get(key);
  };
  for (const seg of segments) {
    const a = addNode(seg[0]), b = addNode(seg[1]);
    if (a.key === b.key) continue;
    const edge = { a:a.key, b:b.key, used:false };
    const idx = edges.push(edge) - 1;
    a.edges.push(idx); b.edges.push(idx);
  }
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].used) continue;
    const first = edges[i];
    first.used = true;
    let startKey = first.a;
    let prevKey = first.a;
    let currKey = first.b;
    const loop = [nodeMap.get(startKey).pt, nodeMap.get(currKey).pt];
    let guard = 0;
    while (currKey !== startKey && guard++ < 10000) {
      const node = nodeMap.get(currKey);
      if (!node) break;
      const nextEdgeIdx = node.edges.find(ei => !edges[ei].used && ((edges[ei].a === currKey && edges[ei].b !== prevKey) || (edges[ei].b === currKey && edges[ei].a !== prevKey)))
        ?? node.edges.find(ei => !edges[ei].used);
      if (nextEdgeIdx == null) break;
      const e = edges[nextEdgeIdx];
      e.used = true;
      const nextKey = e.a === currKey ? e.b : e.a;
      if (nextKey !== startKey) loop.push(nodeMap.get(nextKey).pt);
      prevKey = currKey;
      currKey = nextKey;
    }
    if (currKey === startKey && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function appendCapTrianglesForPlane(out, segments, plane) {
  let count = 0;
  const loops = buildCapLoopsFromSegments(segments, plane);
  for (const loop of loops) {
    const contour = loop.map(v => plane.axis === 'x' ? new THREE.Vector2(v.p[1], v.p[2]) : new THREE.Vector2(v.p[0], v.p[2]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const tri of tris) {
      const A = loop[tri[0]].p.slice();
      const B = loop[tri[1]].p.slice();
      const C = loop[tri[2]].p.slice();
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const sign = plane.outward === 'negx' ? -nx : plane.outward === 'posx' ? nx : plane.outward === 'negy' ? -ny : ny;
      if (sign < 0) out.push(...A, ...C, ...B);
      else out.push(...A, ...B, ...C);
      count++;
    }
  }
  return count;
}


function makeModelClipPlanes(t) {
  return [
    { name:'xmin', axis:0, coord:-t.dims.widthMm/2, keep:'ge', outward:'negx' },
    { name:'xmax', axis:0, coord: t.dims.widthMm/2, keep:'le', outward:'posx' },
    { name:'ymin', axis:1, coord:-t.dims.depthMm/2, keep:'ge', outward:'negy' },
    { name:'ymax', axis:1, coord: t.dims.depthMm/2, keep:'le', outward:'posy' }
  ];
}

function cloneModelClipVertex(v) {
  return { p:[v.p[0], v.p[1], v.p[2]] };
}

function lerpModelClipVertex(a, b, t) {
  return { p:[
    a.p[0] + (b.p[0]-a.p[0])*t,
    a.p[1] + (b.p[1]-a.p[1])*t,
    a.p[2] + (b.p[2]-a.p[2])*t
  ] };
}

function modelInsidePlane(v, plane, eps=1e-8) {
  const q=v.p[plane.axis];
  return plane.keep==='ge' ? q >= plane.coord-eps : q <= plane.coord+eps;
}

function clipModelPolygonAgainstPlane(poly, plane, segmentsOut) {
  if(!poly.length) return poly;
  const out=[], intersections=[];
  let prev=poly[poly.length-1], prevIn=modelInsidePlane(prev,plane);
  for(const curr of poly){
    const currIn=modelInsidePlane(curr,plane);
    if(currIn!==prevIn){
      const denom=curr.p[plane.axis]-prev.p[plane.axis];
      const tt=Math.abs(denom)<1e-14 ? 0 : (plane.coord-prev.p[plane.axis])/denom;
      const inter=lerpModelClipVertex(prev,curr,Math.max(0,Math.min(1,tt)));
      inter.p[plane.axis]=plane.coord;
      intersections.push(inter);
      out.push(inter);
    }
    if(currIn) out.push(curr);
    prev=curr; prevIn=currIn;
  }
  if(intersections.length===2) segmentsOut.push([intersections[0],intersections[1]]);
  return out;
}

function modelPointKey2D(v, plane, scale=100000) {
  const u=plane.axis===0 ? v.p[1] : v.p[0];
  return `${Math.round(u*scale)}:${Math.round(v.p[2]*scale)}`;
}

function normalizeCutSegments(segments, plane) {
  const unique=new Map();
  for(const seg of segments){
    const a=modelPointKey2D(seg[0],plane), b=modelPointKey2D(seg[1],plane);
    if(a===b) continue;
    const key=a<b ? `${a}|${b}` : `${b}|${a}`;
    if(!unique.has(key)) unique.set(key,seg);
  }
  return [...unique.values()];
}

function buildValidatedCutLoops(segments, plane) {
  const clean=normalizeCutSegments(segments,plane);
  if(!clean.length) return {ok:true,loops:[],segments:clean};
  const nodes=new Map(), edges=[];
  const add=(v)=>{
    const k=modelPointKey2D(v,plane);
    if(!nodes.has(k)) nodes.set(k,{pt:v,edges:[]});
    return k;
  };
  for(const seg of clean){
    const a=add(seg[0]), b=add(seg[1]);
    if(a===b) continue;
    const ei=edges.length;
    edges.push({a,b,used:false});
    nodes.get(a).edges.push(ei); nodes.get(b).edges.push(ei);
  }
  // A watertight manifold cross-section must be a union of closed 2-regular loops.
  for(const n of nodes.values()) if(n.edges.length!==2) return {ok:false,loops:[],segments:clean};
  const loops=[];
  for(let i=0;i<edges.length;i++){
    if(edges[i].used) continue;
    const e0=edges[i]; e0.used=true;
    const start=e0.a; let prev=e0.a, curr=e0.b;
    const loop=[nodes.get(start).pt,nodes.get(curr).pt];
    let guard=0;
    while(curr!==start && guard++<100000){
      const opts=nodes.get(curr).edges.filter(ei=>!edges[ei].used);
      if(opts.length!==1) return {ok:false,loops:[],segments:clean};
      const e=edges[opts[0]]; e.used=true;
      const next=e.a===curr?e.b:e.a;
      if(next!==start) loop.push(nodes.get(next).pt);
      prev=curr; curr=next;
    }
    if(curr!==start || loop.length<3) return {ok:false,loops:[],segments:clean};
    loops.push(loop);
  }
  return {ok:true,loops,segments:clean};
}


function buildCutPaths(segments, plane) {
  const clean=normalizeCutSegments(segments,plane);
  if(!clean.length) return {ok:true,paths:[],segments:clean};
  const nodes=new Map(), edges=[];
  const add=(v)=>{
    const k=modelPointKey2D(v,plane);
    if(!nodes.has(k)) nodes.set(k,{pt:v,edges:[]});
    return k;
  };
  for(const seg of clean){
    const a=add(seg[0]), b=add(seg[1]);
    if(a===b) continue;
    const ei=edges.length;
    edges.push({a,b,used:false});
    nodes.get(a).edges.push(ei); nodes.get(b).edges.push(ei);
  }
  // A sliced shell may legitimately be open at the building foundation. We
  // accept degree 1 endpoints and degree 2 chain vertices. Branches indicate
  // ambiguous/non-manifold source geometry and are rejected here.
  for(const n of nodes.values()) if(n.edges.length<1 || n.edges.length>2) return {ok:false,paths:[],segments:clean};

  const paths=[];
  const walk=(startKey,startEdge)=>{
    const path=[nodes.get(startKey).pt];
    let curr=startKey, edgeIdx=startEdge, guard=0;
    while(edgeIdx!=null && guard++<100000){
      const e=edges[edgeIdx];
      if(e.used) break;
      e.used=true;
      const next=e.a===curr?e.b:e.a;
      path.push(nodes.get(next).pt);
      curr=next;
      const opts=nodes.get(curr).edges.filter(ei=>!edges[ei].used);
      edgeIdx=opts.length?opts[0]:null;
      if(curr===startKey) break;
    }
    return {points:path,closed:curr===startKey};
  };

  // Open chains first, starting at degree-1 endpoints.
  for(const [k,n] of nodes){
    if(n.edges.length!==1) continue;
    const ei=n.edges.find(e=>!edges[e].used);
    if(ei!=null) paths.push(walk(k,ei));
  }
  // Remaining edges are closed loops.
  for(let i=0;i<edges.length;i++){
    if(edges[i].used) continue;
    paths.push(walk(edges[i].a,i));
  }
  if(edges.some(e=>!e.used)) return {ok:false,paths:[],segments:clean};
  return {ok:true,paths,segments:clean};
}

function borderTerrainPoint(t, plane, uMm) {
  const baseMm=Number(els.baseThickness.value);
  const zExag=Number(els.zExaggeration.value);
  let x,y,px,py;
  if(plane.axis===0){
    x=plane.coord<0 ? t.dims.minX : t.dims.maxX;
    y=t.dims.minY + (uMm + t.dims.depthMm/2) / t.dims.mmPerMeter;
    px=plane.coord; py=uMm;
  } else {
    y=plane.coord<0 ? t.dims.minY : t.dims.maxY;
    x=t.dims.minX + (uMm + t.dims.widthMm/2) / t.dims.mmPerMeter;
    px=uMm; py=plane.coord;
  }
  x=Math.max(t.dims.minX,Math.min(t.dims.maxX,x));
  y=Math.max(t.dims.minY,Math.min(t.dims.maxY,y));
  const terr=terrainElevationAtXY(t,x,y);
  const z=baseMm+(terr-t.stats.min)*t.dims.mmPerMeter*zExag;
  return {p:[px,py,z]};
}

function planeU(v,plane){ return plane.axis===0 ? v.p[1] : v.p[0]; }

function sampleTerrainClosure(t, plane, uFrom, uTo) {
  const span=Math.abs(uTo-uFrom);
  // Sample finely enough to match the visible side-wall profile, without
  // exploding triangle counts. The terrain mesh spacing is the natural scale.
  const meshStepMm=Math.max(0.08, Math.min(0.5, t.dims.widthMm / Math.max(2,t.grid.cols-1)));
  const n=Math.max(1,Math.ceil(span/meshStepMm));
  const pts=[];
  for(let i=0;i<=n;i++){
    const f=i/n;
    pts.push(borderTerrainPoint(t,plane,uFrom+(uTo-uFrom)*f));
  }
  return pts;
}

function compactCapContour(points, plane) {
  const out=[];
  const dist2=(a,b)=>{
    const au=planeU(a,plane), bu=planeU(b,plane);
    const dz=a.p[2]-b.p[2], du=au-bu;
    return du*du+dz*dz;
  };
  for(const p of points){
    if(!out.length || dist2(out[out.length-1],p)>1e-10) out.push(p);
  }
  if(out.length>2 && dist2(out[0],out[out.length-1])<1e-10) out.pop();
  // Remove nearly collinear intermediate points in the 2D cut plane.
  let changed=true;
  while(changed && out.length>3){
    changed=false;
    for(let i=0;i<out.length;i++){
      const a=out[(i-1+out.length)%out.length], b=out[i], c=out[(i+1)%out.length];
      const ax=planeU(b,plane)-planeU(a,plane), ay=b.p[2]-a.p[2];
      const bx=planeU(c,plane)-planeU(b,plane), by=c.p[2]-b.p[2];
      const cross=Math.abs(ax*by-ay*bx);
      const scale=Math.max(1e-9,Math.hypot(ax,ay)*Math.hypot(bx,by));
      if(cross/scale<1e-7){ out.splice(i,1); changed=true; break; }
    }
  }
  return out;
}

function appendTerrainClosedCaps(out, paths, plane, t) {
  let count=0;
  for(const pathInfo of paths){
    let chain=pathInfo.points.slice();
    if(pathInfo.closed && chain.length>1){
      if(modelPointKey2D(chain[0],plane)===modelPointKey2D(chain[chain.length-1],plane)) chain.pop();
    }
    if(chain.length<2) return {ok:false,count};
    let contour;
    if(pathInfo.closed){
      contour=chain;
    } else {
      const a=chain[0], b=chain[chain.length-1];
      const ua=planeU(a,plane), ub=planeU(b,plane);
      const terrB=borderTerrainPoint(t,plane,ub);
      const terrA=borderTerrainPoint(t,plane,ua);
      // Cross-section follows the actual building shell from A→B, then drops
      // vertically to the terrain and follows the exact relief edge back to A.
      const ground=sampleTerrainClosure(t,plane,ub,ua);
      contour=[...chain,terrB,...ground.slice(1,-1),terrA];
    }
    contour=compactCapContour(contour,plane);
    if(contour.length<3) return {ok:false,count};
    const pts2=contour.map(v=>plane.axis===0 ? new THREE.Vector2(v.p[1],v.p[2]) : new THREE.Vector2(v.p[0],v.p[2]));
    const tris=THREE.ShapeUtils.triangulateShape(pts2,[]);
    if(!tris.length) return {ok:false,count};
    for(const tr of tris){
      const A=contour[tr[0]].p.slice(),B=contour[tr[1]].p.slice(),C=contour[tr[2]].p.slice();
      const ux=B[0]-A[0],uy=B[1]-A[1],uz=B[2]-A[2];
      const vx=C[0]-A[0],vy=C[1]-A[1],vz=C[2]-A[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz;
      const sign=plane.outward==='negx'?-nx:plane.outward==='posx'?nx:plane.outward==='negy'?-ny:ny;
      if(sign<0) out.push(...A,...C,...B); else out.push(...A,...B,...C);
      count++;
    }
  }
  return {ok:true,count};
}

function appendValidatedCaps(out, loopSets, plane) {
  let count=0;
  for(const loop of loopSets){
    const contour=loop.map(v=>plane.axis===0 ? new THREE.Vector2(v.p[1],v.p[2]) : new THREE.Vector2(v.p[0],v.p[2]));
    const tris=THREE.ShapeUtils.triangulateShape(contour,[]);
    if(!tris.length && loop.length>2) return {ok:false,count};
    for(const tr of tris){
      const A=loop[tr[0]].p.slice(), B=loop[tr[1]].p.slice(), C=loop[tr[2]].p.slice();
      const ux=B[0]-A[0],uy=B[1]-A[1],uz=B[2]-A[2];
      const vx=C[0]-A[0],vy=C[1]-A[1],vz=C[2]-A[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz;
      const sign=plane.outward==='negx'?-nx:plane.outward==='posx'?nx:plane.outward==='negy'?-ny:ny;
      if(sign<0) out.push(...A,...C,...B); else out.push(...A,...B,...C);
      count++;
    }
  }
  return {ok:true,count};
}

function triangleIndices(idx, ti){
  return idx ? [idx.getX(ti*3),idx.getX(ti*3+1),idx.getX(ti*3+2)] : [ti*3,ti*3+1,ti*3+2];
}


async function getCsgModule() {
  if (!CsgModulePromise) {
    CsgModulePromise = import('https://esm.sh/three-bvh-csg@0.0.18?external=three');
  }
  return CsgModulePromise;
}

async function getBufferUtils() {
  if (!BufferUtilsPromise) {
    BufferUtilsPromise = import('three/addons/utils/BufferGeometryUtils.js');
  }
  return BufferUtilsPromise;
}

function geometryTrianglesToArray(geometry) {
  const out = [];
  const pos = geometry.getAttribute('position');
  const idx = geometry.index;
  if (!pos) return out;
  const start = Math.max(0, geometry.drawRange?.start || 0);
  const rawCount = Number.isFinite(geometry.drawRange?.count) ? geometry.drawRange.count : (idx ? idx.count : pos.count);
  const end = Math.min(idx ? idx.count : pos.count, start + rawCount);
  const readVertex = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  for (let i = start; i + 2 < end; i += 3) {
    const ia = idx ? idx.getX(i) : i;
    const ib = idx ? idx.getX(i + 1) : i + 1;
    const ic = idx ? idx.getX(i + 2) : i + 2;
    out.push(...readVertex(ia), ...readVertex(ib), ...readVertex(ic));
  }
  return out;
}

async function hardCropBuildingSolid(fullTriangles, t) {
  // Second-stage boolean crop. This is intentionally used only for border
  // buildings where the lightweight polygon clip could not produce a validated
  // closed cap. The input remains the complete watertight building body.
  const { Brush, Evaluator, INTERSECTION } = await getCsgModule();
  const { mergeVertices } = await getBufferUtils();

  let geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(fullTriangles, 3));
  geom = mergeVertices(geom, 1e-5);
  geom.computeVertexNormals();
  geom.deleteAttribute('uv');
  geom.deleteAttribute('uv1');
  geom.deleteAttribute('color');

  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb || !Number.isFinite(bb.min.z) || !Number.isFinite(bb.max.z)) throw new Error('ungültige Gebäude-Boundingbox');

  const padZ = Math.max(10, (bb.max.z - bb.min.z) * 0.25 + 2);
  const boxHeight = (bb.max.z - bb.min.z) + 2 * padZ;
  const boxCenterZ = (bb.max.z + bb.min.z) / 2;

  const boxGeom = new THREE.BoxGeometry(t.dims.widthMm, t.dims.depthMm, boxHeight);
  boxGeom.deleteAttribute('uv');
  boxGeom.computeVertexNormals();

  const a = new Brush(geom);
  a.updateMatrixWorld(true);
  const b = new Brush(boxGeom);
  b.position.set(0, 0, boxCenterZ);
  b.updateMatrixWorld(true);

  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  evaluator.consolidateGroups = true;
  const result = evaluator.evaluate(a, b, INTERSECTION);
  result.updateMatrixWorld(true);
  let resultGeom = result.geometry;
  if (!resultGeom?.getAttribute('position')) throw new Error('CSG lieferte keine Geometrie');

  // Bake result matrix in case the implementation returns a transformed brush.
  resultGeom = resultGeom.clone();
  resultGeom.applyMatrix4(result.matrixWorld);
  const arr = geometryTrianglesToArray(resultGeom);
  if (!arr.length) throw new Error('CSG-Schnitt ist leer');

  const bx0 = -t.dims.widthMm / 2, bx1 = t.dims.widthMm / 2;
  const by0 = -t.dims.depthMm / 2, by1 = t.dims.depthMm / 2;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1];
    if (x < bx0 - 1e-3 || x > bx1 + 1e-3 || y < by0 - 1e-3 || y > by1 + 1e-3) {
      throw new Error('CSG-Ergebnis ragt noch über den Reliefrahmen');
    }
  }
  return arr;
}

async function loadBuildingTriangles(t) {
  const elig = buildingEligibility(t.dims);
  if (!els.includeBuildings.checked || !elig.ok) return { triangles:null, meta:null };
  setStatus('Gebäude laden · swissBUILDINGS³D', 96);
  debug(`Gebäude: ${BUILDINGS_TILESET}`);
  debug(`Gebäude aktiviert · Massstab ca. 1:${Math.round(elig.scale).toLocaleString('de-CH')} · Fläche ${elig.areaKm2.toFixed(2)} km².`);

  const b = selectedBounds;
  const center = b.getCenter();
  const centerEcef = geodeticToEcef(center.lng, center.lat, 0);
  const up = centerEcef.clone().normalize();
  const lon = center.lng * Math.PI/180, lat = center.lat * Math.PI/180;
  const north = new THREE.Vector3(-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)).normalize();
  const span = Math.max(t.dims.groundW, t.dims.groundH);
  const altitude = Math.max(1200, span * 1.25);
  const tileCam = new THREE.PerspectiveCamera(58, Math.max(.4, t.dims.groundW/t.dims.groundH), 10, Math.max(50000, altitude*5));
  tileCam.position.copy(centerEcef).addScaledVector(up, altitude);
  tileCam.up.copy(north);
  tileCam.lookAt(centerEcef);
  tileCam.updateProjectionMatrix();
  tileCam.updateMatrixWorld(true);

  const TilesRenderer = await getTilesRendererClass();
  const tiles = new TilesRenderer(BUILDINGS_TILESET);

  // swissBUILDINGS³D currently delivers Draco-compressed glTF payloads inside
  // B3DM tiles. 3d-tiles-renderer delegates embedded glTF/GLB decoding to its
  // LoadingManager, so install one shared GLTFLoader with a DRACOLoader here.
  // Without this every tile fails with "No DRACOLoader instance provided".
  const dracoLoader = new DRACOLoader(tiles.manager);
  dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/draco/gltf/');
  dracoLoader.setWorkerLimit(4);
  const gltfLoader = new GLTFLoader(tiles.manager);
  gltfLoader.setDRACOLoader(dracoLoader);
  tiles.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);
  debug('Gebäude-Decoder: Draco aktiviert (three 0.180.0).');

  tiles.setCamera(tileCam);
  tiles.setResolution(tileCam, 1600, 1600);
  if ('errorTarget' in tiles) tiles.errorTarget = 2.5;
  if (tiles.lruCache) {
    if ('maxSize' in tiles.lruCache) tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize || 0, 1200);
    if ('maxBytesSize' in tiles.lruCache) tiles.lruCache.maxBytesSize = Math.max(tiles.lruCache.maxBytesSize || 0, 700e6);
  }
  let loadedEvents=0, lastEvents=-1, stable=0;
  // Keep references to every model that was successfully loaded. A 3D-Tiles
  // renderer can mark parent / refined tiles invisible even though their
  // geometry is valid and already in memory. Visibility is a rendering state,
  // not a criterion for whether we may use the mesh for STL extraction.
  const loadedRoots = new Set();
  const onLoad=(ev)=>{
    loadedEvents++; stable=0;
    if (ev?.scene) loadedRoots.add(ev.scene);
  };
  tiles.addEventListener?.('load-model', onLoad);
  tiles.addEventListener?.('load-error', (ev) => {
    debug(`Gebäude-Tile Fehler: ${ev?.url || ''} ${ev?.error?.message || ev?.error || ''}`);
  });
  const tmpScene = new THREE.Scene();
  tmpScene.add(tiles.group);
  for (let i=0; i<180; i++) {
    tileCam.updateMatrixWorld(true);
    tiles.group.updateMatrixWorld(true);
    tiles.update();
    await sleep(80);
    if (loadedEvents === lastEvents) stable++; else stable=0;
    lastEvents=loadedEvents;
    if (i > 25 && stable > 18) break;
  }
  tiles.group.updateMatrixWorld(true);

  // Add models still managed by the renderer as well. Do NOT filter by
  // root.visible / mesh.visible: refinement and frustum selection routinely
  // make loaded tiles invisible, which caused v0.6.3 to report zero meshes.
  tiles.forEachLoadedModel?.((root) => { if (root) loadedRoots.add(root); });
  const meshes=[];
  const seenMeshes = new Set();
  for (const root of loadedRoots) {
    root.updateMatrixWorld(true);
    root.traverse(o => {
      if (o.isMesh && o.geometry?.attributes?.position && !seenMeshes.has(o)) {
        seenMeshes.add(o);
        meshes.push(o);
      }
    });
  }
  debug(`swissBUILDINGS³D: ${meshes.length} auswertbare Meshes aus ${loadedRoots.size} geladenen Tile-Szenen (${loadedEvents} Tile-Ladevorgänge).`);
  if (!meshes.length) {
    dracoLoader.dispose?.();
    tiles.dispose?.();
    throw new Error(`Gebäude waren aktiviert, aber swissBUILDINGS³D lieferte keine auswertbaren Meshes (Tile-Ladevorgänge: ${loadedEvents}).`);
  }

  // Estimate the local ellipsoid→terrain vertical offset from low building vertices.
  const diffs=[];
  const wp=new THREE.Vector3();
  for (const mesh of meshes) {
    const pos=mesh.geometry.attributes.position;
    const stride=Math.max(1,Math.floor(pos.count/1200));
    for(let i=0;i<pos.count;i+=stride){
      wp.fromBufferAttribute(pos,i).applyMatrix4(mesh.matrixWorld);
      const [lo,la,h]=ecefToGeodetic(wp.x,wp.y,wp.z);
      const [x,y]=lv95FromLonLat(lo,la);
      if(x<t.dims.minX||x>t.dims.maxX||y<t.dims.minY||y>t.dims.maxY) continue;
      diffs.push(h-terrainElevationAtXY(t,x,y));
      if(diffs.length>80000) break;
    }
    if(diffs.length>80000) break;
  }
  if (!diffs.length) {
    dracoLoader.dispose?.();
    tiles.dispose?.();
    throw new Error('Gebäudedaten liegen ausserhalb des gewählten Reliefausschnitts.');
  }
  const geoidOffset=percentile(diffs,0.03);
  const heightFactor=1;
  debug(`Gebäude-Höhenabgleich: lokaler Offset ≈ ${geoidOffset.toFixed(2)} m · Gebäudehöhe 1.00× (keine Relief-Überhöhung).`);

  const out=[];
  let triCount=0, clippedTriangles=0, capTriangles=0, foundationVertices=0, borderBuildingsClipped=0, borderFallbackFull=0, borderHardCropped=0, borderHardCropFailed=0;
  const va=new THREE.Vector3(), vb=new THREE.Vector3(), vc=new THREE.Vector3();
  const modelClipPlanes = makeModelClipPlanes(t);
  const baseMm=Number(els.baseThickness.value);
  const zExag=Number(els.zExaggeration.value);
  const embedMm=0.18;
  const typicalHeightMm=BUILDING_TYPICAL_HEIGHT_M*t.dims.mmPerMeter;
  // A true foundation vertex should lie close to the terrain. Eaves and gable
  // shoulders are substantially higher and must never be pulled down. The
  // tolerance scales with print scale so steep-slope downhill foundations are
  // still caught without mistaking roof/eave vertices for the building base.
  const foundationBandMm=Math.max(0.35, Math.min(2.2, typicalHeightMm*0.45));

  const toModelBase=(v)=>{
    const [lo,la,h]=ecefToGeodetic(v.x,v.y,v.z);
    const [x,y]=lv95FromLonLat(lo,la);
    const terr=terrainElevationAtXY(t,x,y);
    const correctedH=h-geoidOffset;
    const xm=(x-t.dims.minX)*t.dims.mmPerMeter-t.dims.widthMm/2;
    const ym=(y-t.dims.minY)*t.dims.mmPerMeter-t.dims.depthMm/2;
    const terrainZ=baseMm+(terr-t.stats.min)*t.dims.mmPerMeter*zExag;
    // Gebäudehöhe selbst bleibt massstäblich 1:1. Die Relief-Überhöhung wird
    // später als EIN konstanter Z-Versatz pro zusammenhängendem Gebäudekörper
    // hinzugefügt. So bleiben Wände und Dächer geometrisch starr.
    const unexaggeratedZ=baseMm+(correctedH-t.stats.min)*t.dims.mmPerMeter;
    return {x,y,terr,correctedH,terrainZ,p:[xm,ym,unexaggeratedZ]};
  };

  for(const mesh of meshes){
    const pos=mesh.geometry.attributes.position, idx=mesh.geometry.index;
    // Transform every mesh vertex exactly once. This keeps all triangles that
    // share a vertex watertight after the foundation correction.
    const verts=new Array(pos.count);
    for(let vi=0;vi<pos.count;vi++){
      va.fromBufferAttribute(pos,vi).applyMatrix4(mesh.matrixWorld);
      verts[vi]=toModelBase(va);
    }

    // Zusammenhängende Gebäudekörper bestimmen. Die Randbearbeitung muss pro
    // Gebäude erfolgen, nicht pro Tile-Mesh: ein swisstopo-Tile enthält viele Häuser.
    const parent=new Int32Array(pos.count);
    for(let i=0;i<parent.length;i++) parent[i]=i;
    const find=(a)=>{ while(parent[a]!==a){ parent[a]=parent[parent[a]]; a=parent[a]; } return a; };
    const unite=(a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };
    const ntri=idx ? Math.floor(idx.count/3) : Math.floor(pos.count/3);
    for(let ti=0;ti<ntri;ti++){
      const [ia,ib,ic]=triangleIndices(idx,ti);
      unite(ia,ib); unite(ib,ic);
    }
    // WICHTIG: swissBUILDINGS³D / glTF dupliziert Vertices oft an harten
    // Kanten (Fassade ↔ Dach, Giebel ↔ Dach), AUCH bei indexierten Meshes.
    // Topologisch sind diese Flächen dann über Indizes nicht verbunden, obwohl
    // sie geometrisch exakt dieselben Eckpunkte besitzen. Für das saubere
    // Schneiden eines Randhauses müssen wir deshalb IMMER geometrisch
    // identische Punkte verschweissen, nicht nur bei nicht-indexierten Meshes.
    // 1e-4 mm im fertigen Modell ist deutlich kleiner als jede Druckrelevanz,
    // aber gross genug, um numerisches Transformationsrauschen aufzufangen.
    const weld=new Map();
    let weldedVertices=0;
    const WELD_SCALE=10000; // 0.0001 mm
    for(let vi=0;vi<verts.length;vi++){
      const v=verts[vi];
      const k=`${Math.round(v.p[0]*WELD_SCALE)}:${Math.round(v.p[1]*WELD_SCALE)}:${Math.round(v.p[2]*WELD_SCALE)}`;
      if(weld.has(k)){
        const other=weld.get(k);
        if(find(vi)!==find(other)){ unite(vi,other); weldedVertices++; }
      } else weld.set(k,vi);
    }
    if(weldedVertices) debug(`Gebäude-Topologie: ${weldedVertices.toLocaleString('de-CH')} geometrisch identische Vertex-Verbindungen verschweisst.`);

    const compTris=new Map(), compVerts=new Map(), compTerr=new Map();
    for(let ti=0;ti<ntri;ti++){
      const inds=triangleIndices(idx,ti); const r=find(inds[0]);
      if(!compTris.has(r)) compTris.set(r,[]);
      compTris.get(r).push(inds);
    }
    for(let vi=0;vi<verts.length;vi++){
      const r=find(vi);
      if(!compVerts.has(r)) compVerts.set(r,[]);
      compVerts.get(r).push(vi);
      if(!compTerr.has(r)) compTerr.set(r,[]);
      compTerr.get(r).push(verts[vi].terr);
    }

    for(const [r,tris] of compTris){
      const vis=compVerts.get(r)||[];
      if(!vis.length) continue;
      const arr=(compTerr.get(r)||[]).slice().sort((a,b)=>a-b);
      const qi=Math.min(arr.length-1,Math.max(0,Math.floor(arr.length*0.15)));
      const refTerr=arr[qi];
      const exaggerationShift=(refTerr-t.stats.min)*t.dims.mmPerMeter*(zExag-1);
      for(const vi of vis) verts[vi].p[2]+=exaggerationShift;

      // Nur echte Sockelpunkte dieses Gebäudes bis leicht ins Terrain ziehen.
      const foundationIdx=new Set();
      for(const [ia,ib,ic] of tris){
        const A=verts[ia],B=verts[ib],C=verts[ic];
        const ax=B.p[0]-A.p[0], ay=B.p[1]-A.p[1], az=B.p[2]-A.p[2];
        const bx=C.p[0]-A.p[0], by=C.p[1]-A.p[1], bz=C.p[2]-A.p[2];
        const nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
        const nlen=Math.hypot(nx,ny,nz)||1;
        if(Math.abs(nz)/nlen>0.45) continue;
        for(const vi of [ia,ib,ic]){
          const v=verts[vi], above=v.p[2]-v.terrainZ;
          if(above>=-0.25 && above<=foundationBandMm) foundationIdx.add(vi);
        }
      }
      for(const vi of foundationIdx){
        const v=verts[vi], target=v.terrainZ-embedMm;
        if(v.p[2]>target){v.p[2]=target;foundationVertices++;}
      }

      // Klassifikation ausschliesslich in den fertigen Modellkoordinaten (mm).
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for(const vi of vis){
        const p=verts[vi].p;
        minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);
        minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);
      }
      const bx0=-t.dims.widthMm/2, bx1=t.dims.widthMm/2, by0=-t.dims.depthMm/2, by1=t.dims.depthMm/2;
      const eps=1e-5;
      const disjoint=maxX<bx0-eps || minX>bx1+eps || maxY<by0-eps || minY>by1+eps;
      if(disjoint) continue;
      const inside=minX>=bx0-eps && maxX<=bx1+eps && minY>=by0-eps && maxY<=by1+eps;

      if(inside){
        for(const [ia,ib,ic] of tris){ out.push(...verts[ia].p,...verts[ib].p,...verts[ic].p); triCount++; }
        continue;
      }

      borderBuildingsClipped++;
      const temp=[];
      const segs={xmin:[],xmax:[],ymin:[],ymax:[]};
      let localClipped=0;
      for(const [ia,ib,ic] of tris){
        let poly=[cloneModelClipVertex(verts[ia]),cloneModelClipVertex(verts[ib]),cloneModelClipVertex(verts[ic])];
        for(const plane of modelClipPlanes){
          poly=clipModelPolygonAgainstPlane(poly,plane,segs[plane.name]);
          if(poly.length<3) break;
        }
        if(poly.length<3){localClipped++;continue;}
        for(let i=1;i<poly.length-1;i++) temp.push(...poly[0].p,...poly[i].p,...poly[i+1].p);
      }

      // Die swissBUILDINGS³D-Hülle ist am Gebäudeboden häufig offen. Deshalb
      // entsteht am Reliefrahmen keine geschlossene Ringkontur, sondern eine
      // offene Kette zwischen zwei Fundamentpunkten. Diese wird exakt auf der
      // Relief-Seitenebene bis zur lokalen Terrainkante geschlossen. So bildet
      // die neue Schnittfassade unten eine einzige Fläche mit dem Reliefrand.
      let valid=true, localCaps=0;
      for(const plane of modelClipPlanes){
        const info=buildCutPaths(segs[plane.name],plane);
        if(!info.ok){ valid=false; break; }
        const cap=appendTerrainClosedCaps(temp,info.paths,plane,t);
        if(!cap.ok){ valid=false; break; }
        localCaps+=cap.count;
      }

      // Harte Kontrolle: Kein ausgegebener Randhauspunkt darf ausserhalb liegen.
      if(valid){
        for(let i=0;i<temp.length;i+=3){
          const x=temp[i], y=temp[i+1];
          if(x<bx0-1e-5||x>bx1+1e-5||y<by0-1e-5||y>by1+1e-5){valid=false;break;}
        }
      }
      if(localCaps===0) valid=false;

      if(!valid || !temp.length){
        // Kein Vollhaus-Fallback mehr: ein über den Reliefrahmen ragendes Haus
        // darf niemals ausgegeben werden. Lieber gezielt dieses Randhaus
        // verwerfen als ein geometrisch falsches, überstehendes Modell erzeugen.
        borderHardCropFailed++;
        debug('Randhaus konnte nicht eindeutig geschlossen werden und wurde verworfen (kein Vollhaus-Fallback).');
        continue;
      }
      out.push(...temp);
      const added=Math.floor(temp.length/9);
      triCount+=added;
      capTriangles+=localCaps;
      clippedTriangles+=localClipped;
      borderHardCropped++;
      if(triCount>BUILDING_MAX_TRIANGLES){ tiles.dispose?.(); throw new Error(`Zu viele Gebäudedreiecke (> ${BUILDING_MAX_TRIANGLES.toLocaleString('de-CH')}). Bitte einen kleineren Ausschnitt wählen oder Gebäude deaktivieren.`); }
    }
  }
  debug(`Gebäude-Fundamentband: ${foundationBandMm.toFixed(2)} mm über lokalem Terrain.`);
  tiles.dispose?.();
  if (!triCount) throw new Error('Keine Gebäudedreiecke innerhalb des Reliefausschnitts gefunden.');
  debug(`Gebäude: ${triCount.toLocaleString('de-CH')} Dreiecke übernommen; ${borderBuildingsClipped.toLocaleString('de-CH')} Randhäuser bearbeitet; ${capTriangles.toLocaleString('de-CH')} Abschluss-Dreiecke im Primärschnitt; Randhäuser exakt gekappt/geschlossen: ${borderHardCropped.toLocaleString('de-CH')}; Randhäuser verworfen statt überstehend ausgegeben: ${borderHardCropFailed.toLocaleString('de-CH')}; ${foundationVertices.toLocaleString('de-CH')} Fassaden-Bodenpunkte ins Terrain verlängert.`);
  return { triangles:new Float32Array(out), meta:{ triangleCount:triCount, meshCount:meshes.length, heightFactor, geoidOffset } };
}

async function generateTerrain() {
  if (!selectedBounds) return;
  els.generateBtn.disabled = true;
  els.downloadBtn.disabled = true;
  els.debug.textContent = '';
  els.resultInfo.textContent = '';
  lastStlBlob = null;
  try {
    const d = modelDimensions();
    if (d.groundW > 80000 || d.groundH > 80000) throw new Error('Version 1 ist auf Ausschnitte bis etwa 80 × 80 km begrenzt. Bitte ein kleineres Gebiet wählen.');

    const grid = outputGrid(d);
    const sourceSetting = els.sourceResolution.value;
    const sourceRes = sourceSetting === 'auto' ? chooseAutomaticResolution(d, grid) : Number(sourceSetting);
    const meshSpacingM = Math.max(d.groundW / Math.max(1, grid.cols - 1), d.groundH / Math.max(1, grid.rows - 1));

    const catalogueBbox = stacBboxForDims(d, 100);
    debug(`STAC: ${STAC_ITEMS}`);
    debug(`Karten-BBOX: ${stacBbox(selectedBounds)}`);
    debug(`Abdeckungs-BBOX (aus tatsächlichem LV95-Modell): ${catalogueBbox}`);
    debug(`Mesh-Bodenabstand: ${meshSpacingM.toFixed(2)} m · gewählte Quelle: ${sourceRes} m${sourceSetting === 'auto' ? ' (automatisch)' : ''}`);
    const items = await fetchStacItemsForBbox(catalogueBbox);
    debug(`${items.length} STAC-Items gefunden.`);
    const plans = makeTilePlans(items, sourceRes);
    debug(`${plans.length} räumliche 1-km-Kacheln geplant; Fallback-Jahrgänge und Alternativauflösung verfügbar.`);
    if (!plans.length) throw new Error(`Keine swissALTI³D-GeoTIFFs für diesen Ausschnitt gefunden.`);
    if (plans.length > MAX_TILES) throw new Error(`${plans.length} Kacheln wären nötig. Bitte einen kleineren Ausschnitt wählen.`);

    const loadResult = await loadPlansConcurrent(plans, d, grid, (done, total) => {
      const pct = 12 + 68 * (done / total);
      setStatus(`Höhendaten ${done}/${total} · ${TILE_CONCURRENCY} parallele Downloads`, pct);
    });
    if (loadResult.fallbackUsed.length) debug(`${loadResult.fallbackUsed.length} Kacheln erfolgreich über Fallback geladen.`);
    if (loadResult.failed.length) {
      debug(`${loadResult.failed.length} Kacheln nach allen Versuchen nicht geladen:`);
      for (const f of loadResult.failed.slice(0, 30)) debug(`  ${f.plan.key}: ${f.errors.slice(-2).join(' | ')}`);
      if (loadResult.failed.length > 30) debug(`  … ${loadResult.failed.length - 30} weitere`);
    }

    setStatus('Rasterabdeckung prüfen', 82);
    let statsBeforeRecovery = terrainStats(grid);
    let recovery = { passes: 0, recovered: 0, queried: 0 };
    if (statsBeforeRecovery.missing > 0) {
      debug(`Nach Erstladung fehlen ${statsBeforeRecovery.missing.toLocaleString('de-CH')} Punkte. Coverage-Recovery wird gestartet.`);
      recovery = await recoverMissingCoverage(grid, d, sourceRes, 82);
      debug(`Coverage-Recovery: ${recovery.recovered.toLocaleString('de-CH')} Punkte nachgeladen.`);
    }

    // If swissALTI³D has no coverage (typically just across the national border),
    // fill ONLY missing cells from swissALTIRegio. Existing high-resolution cells
    // remain untouched.
    let regioRecovery = { recovered: 0, items: 0, assetsTried: 0 };
    const afterAlti3d = terrainStats(grid);
    if (afterAlti3d.missing > 0) {
      debug(`${afterAlti3d.missing.toLocaleString('de-CH')} Punkte weiterhin ohne swissALTI³D-Abdeckung. swissALTIRegio (10 m) wird als Grenzgebiets-Fallback versucht.`);
      regioRecovery = await recoverWithSwissAltiRegio(grid, d, 91);
      debug(`swissALTIRegio: ${regioRecovery.recovered.toLocaleString('de-CH')} Punkte ergänzt (${regioRecovery.items} STAC-Items; XYZ: ${regioRecovery.xyzTried || 0}, COG: ${regioRecovery.cogTried || 0} geprüft).`);
    }

    // Interpolate only genuinely isolated residual NoData cells after every
    // possible source has been tried. Never use interpolation to hide a
    // missing catalogue/download strip.
    setStatus('Isolierte Restlücken prüfen', 94);
    let filled = 0;
    let preFill = terrainStats(grid);
    if (els.smoothMissing.checked && preFill.missing > 0 && preFill.missing / preFill.total < 0.001) {
      filled = fillSmallGaps(grid, 20);
    }
    const stats = terrainStats(grid);
    const missingPct = stats.missing / stats.total * 100;
    debug(`Raster: ${grid.cols} × ${grid.rows}; Erstbelegung: ${loadResult.totalWritten}; swissALTI³D-Recovery: ${recovery.recovered}; swissALTIRegio: ${regioRecovery.recovered}; isoliert interpoliert: ${filled}; Restlücken: ${missingPct.toFixed(4)} %`);
    if (!Number.isFinite(stats.min)) throw new Error('Keine gültigen Höhenwerte geladen.');
    // Critical invariant: never export a terrain with NaN / missing elevations.
    // A failed generation is preferable to a rectangular crater in the print.
    if (stats.missing > 0) {
      throw new Error(`Relief nicht erzeugt: ${stats.missing.toLocaleString('de-CH')} Höhenpunkte (${missingPct.toFixed(3)} %) fehlen noch. Es wird bewusst KEINE fehlerhafte STL mit Löchern erzeugt. Die Abdeckung wurde automatisch mit swissALTI³D-Fallbacks und swissALTIRegio geprüft. Bitte das technische Log melden; eine defekte STL wird nicht ausgegeben.`);
    }

    terrain = { grid, dims: d, stats };
    lastBuildingTriangles = null;
    lastBuildingMeta = null;
    if (els.includeBuildings.checked) {
      const buildings = await loadBuildingTriangles(terrain);
      lastBuildingTriangles = buildings.triangles;
      lastBuildingMeta = buildings.meta;
    }
    setStatus('3D-Vorschau erzeugen', 98);
    renderTerrainPreview(terrain, lastBuildingTriangles);
    await new Promise(r => setTimeout(r, 20));

    setStatus('STL vorbereiten', 99);
    lastStlBlob = buildBinaryStl(terrain, lastBuildingTriangles);
    const stlMb = lastStlBlob.size / 1024 / 1024;
    const elevRange = stats.max - stats.min;
    const modelReliefHeight = elevRange * d.mmPerMeter * Number(els.zExaggeration.value);
    const bInfo = lastBuildingMeta ? ` · Gebäude: ${lastBuildingMeta.triangleCount.toLocaleString('de-CH')} Dreiecke` : '';
    els.resultInfo.textContent = `Höhen: ${stats.min.toFixed(1)}–${stats.max.toFixed(1)} m · Reliefhöhe: ${modelReliefHeight.toFixed(1)} mm + Basis${bInfo} · STL: ${stlMb.toFixed(1)} MB`;
    els.downloadBtn.disabled = false;
    setStatus('Fertig', 100);
  } catch (err) {
    console.error(err);
    setStatus('Fehler', 0);
    els.statusText.textContent = err.message || String(err);
    debug(err.stack || String(err));
  } finally {
    els.generateBtn.disabled = !selectedBounds;
  }
}

function zMm(elev, terrainObj) {
  const base = Number(els.baseThickness.value);
  const exag = Number(els.zExaggeration.value);
  return base + (elev - terrainObj.stats.min) * terrainObj.dims.mmPerMeter * exag;
}

function buildBinaryStl(t, buildingTriangles = null) {
  const { cols, rows, values } = t.grid;
  const w = t.dims.widthMm, h = t.dims.depthMm;
  const topTriangles = 2 * (cols - 1) * (rows - 1);
  // Two walls per axis side, two triangles per wall segment = 4× perimeter segments.
  const sideTriangles = 4 * ((cols - 1) + (rows - 1));
  const buildingTriCount = buildingTriangles ? Math.floor(buildingTriangles.length / 9) : 0;
  const triCount = topTriangles + sideTriangles + 2 + buildingTriCount;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode('Swiss Relief STL Generator · swissALTI3D · swisstopo');
  new Uint8Array(buffer, 0, Math.min(80, header.length)).set(header.slice(0,80));
  view.setUint32(80, triCount, true);
  let off = 84;

  const point = (r, c) => {
    const x = c / (cols - 1) * w - w/2;
    const y = h/2 - r / (rows - 1) * h;
    const z = zMm(values[r * cols + c], t);
    return [x,y,z];
  };
  const bottom = (r,c) => {
    const p = point(r,c); p[2] = 0; return p;
  };
  const tri = (a,b,c) => {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const len=Math.hypot(nx,ny,nz)||1; nx/=len; ny/=len; nz/=len;
    for (const n of [nx,ny,nz]) { view.setFloat32(off,n,true); off+=4; }
    for (const p of [a,b,c]) for (const n of p) { view.setFloat32(off,n,true); off+=4; }
    view.setUint16(off,0,true); off+=2;
  };

  // Top surface, counter-clockwise when viewed from above.
  for (let r=0;r<rows-1;r++) for (let c=0;c<cols-1;c++) {
    const p00=point(r,c), p10=point(r,c+1), p01=point(r+1,c), p11=point(r+1,c+1);
    tri(p00,p01,p10); tri(p10,p01,p11);
  }
  // North and south walls.
  for (let c=0;c<cols-1;c++) {
    let a=point(0,c), b=point(0,c+1), ba=bottom(0,c), bb=bottom(0,c+1);
    tri(a,b,ba); tri(b,bb,ba);
    a=point(rows-1,c); b=point(rows-1,c+1); ba=bottom(rows-1,c); bb=bottom(rows-1,c+1);
    tri(a,ba,b); tri(b,ba,bb);
  }
  // West and east walls.
  for (let r=0;r<rows-1;r++) {
    let a=point(r,0), b=point(r+1,0), ba=bottom(r,0), bb=bottom(r+1,0);
    tri(a,ba,b); tri(b,ba,bb);
    a=point(r,cols-1); b=point(r+1,cols-1); ba=bottom(r,cols-1); bb=bottom(r+1,cols-1);
    tri(a,b,ba); tri(b,bb,ba);
  }
  // Flat bottom: 2 triangles only.
  const sw=[-w/2,-h/2,0], se=[w/2,-h/2,0], nw=[-w/2,h/2,0], ne=[w/2,h/2,0];
  tri(sw,nw,se); tri(se,nw,ne);

  if (buildingTriangles) {
    for (let i=0;i<buildingTriangles.length;i+=9) {
      tri(
        [buildingTriangles[i],buildingTriangles[i+1],buildingTriangles[i+2]],
        [buildingTriangles[i+3],buildingTriangles[i+4],buildingTriangles[i+5]],
        [buildingTriangles[i+6],buildingTriangles[i+7],buildingTriangles[i+8]]
      );
    }
  }

  return new Blob([buffer], {type:'model/stl'});
}

function fileName() {
  const d = modelDimensions();
  return `swiss-relief_${(d.groundW/1000).toFixed(1)}x${(d.groundH/1000).toFixed(1)}km_${Math.round(d.widthMm)}mm.stl`.replace(/\./g,'-').replace('-stl','.stl');
}

function downloadStl() {
  if (!lastStlBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastStlBlob);
  a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initPreview() {
  if (renderer) return;
  els.preview.querySelector('.preview-placeholder')?.remove();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  els.preview.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.7));
  const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(-2,3,4); scene.add(light);
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); };
  animate();
  resizePreview();
}

function clearPreview() {
  if (terrainGroup && scene) { scene.remove(terrainGroup); terrainGroup = null; }
  if (!renderer && !els.preview.querySelector('.preview-placeholder')) {
    const p=document.createElement('div'); p.className='preview-placeholder'; p.textContent='Nach dem Laden erscheint hier das Relief.'; els.preview.appendChild(p);
  }
}

function renderTerrainPreview(t, buildingTriangles = null) {
  initPreview();
  if (terrainGroup) scene.remove(terrainGroup);
  terrainGroup = new THREE.Group();
  const src = t.grid;
  const maxPreview = 260;
  const step = Math.max(1, Math.ceil(Math.max(src.cols, src.rows) / maxPreview));
  const cols = Math.floor((src.cols-1)/step)+1;
  const rows = Math.floor((src.rows-1)/step)+1;
  const pos = new Float32Array(cols*rows*3);
  let k=0;
  for (let r=0;r<rows;r++) {
    const sr=Math.min(src.rows-1,r*step);
    for (let c=0;c<cols;c++) {
      const sc=Math.min(src.cols-1,c*step);
      pos[k++]=sc/(src.cols-1)*t.dims.widthMm-t.dims.widthMm/2;
      pos[k++]=t.dims.depthMm/2-sr/(src.rows-1)*t.dims.depthMm;
      pos[k++]=zMm(src.values[sr*src.cols+sc],t);
    }
  }
  const idx=[];
  for(let r=0;r<rows-1;r++) for(let c=0;c<cols-1;c++){
    const a=r*cols+c,b=a+1,d=(r+1)*cols+c,e=d+1;
    idx.push(a,d,b,b,d,e);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.MeshStandardMaterial({color:0xc8c2b7,roughness:.88,metalness:0,side:THREE.DoubleSide});
  terrainGroup.add(new THREE.Mesh(g,m));

  const baseT=Number(els.baseThickness.value);
  const baseGeo=new THREE.BoxGeometry(t.dims.widthMm,t.dims.depthMm,baseT);
  const baseMesh=new THREE.Mesh(baseGeo,new THREE.MeshStandardMaterial({color:0x88837b,roughness:1}));
  baseMesh.position.z=baseT/2; terrainGroup.add(baseMesh);

  if (buildingTriangles && buildingTriangles.length) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(buildingTriangles, 3));
    bg.computeVertexNormals();
    const bm = new THREE.MeshStandardMaterial({color:0xddd8cf,roughness:.82,metalness:0,side:THREE.DoubleSide});
    terrainGroup.add(new THREE.Mesh(bg,bm));
  }
  scene.add(terrainGroup);
  resetCamera();
}

function resetCamera() {
  if (!camera || !terrain) return;
  const size=Math.max(terrain.dims.widthMm,terrain.dims.depthMm);
  const relief=(terrain.stats.max-terrain.stats.min)*terrain.dims.mmPerMeter*Number(els.zExaggeration.value)+Number(els.baseThickness.value);
  camera.position.set(size*.72,-size*.92,Math.max(size*.70,relief*3));
  controls.target.set(0,0,Math.min(relief/3,size*.15));
  controls.update();
}

function resizePreview() {
  if (!renderer || !camera) return;
  const w=els.preview.clientWidth,h=els.preview.clientHeight;
  renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
}

updateMetrics();
