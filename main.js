import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger.js';
import { SplitText } from 'gsap/SplitText.js';
import Lenis from 'lenis';

/* =====================================================================
   PERSONALIZZA QUI
   ===================================================================== */
const MODEL_NAME = 'gmt.studio';
const DESIGNER = 'gmt.studio';
const GLB_URL = 'assets/occhiali.glb';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const lerp = THREE.MathUtils.lerp;

gsap.registerPlugin(ScrollTrigger, SplitText);

/* Testi dipendenti dalle costanti */
document.title = `${MODEL_NAME} – Occhiali di ${DESIGNER}`;
$$('[data-model-name]').forEach(e => (e.textContent = MODEL_NAME));
$$('[data-designer]').forEach(e => (e.textContent = DESIGNER));
$('#year').textContent = new Date().getFullYear();

/* =====================================================================
   SMOOTH SCROLL (Lenis) + ScrollTrigger
   ===================================================================== */
let lenis = null;
if (!REDUCED) {
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(t => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
function scrollToEl(sel) {
  const el = $(sel); if (!el) return;
  const y = el.getBoundingClientRect().top + scrollY - (sel === '#vista' ? 0 : 0);
  if (lenis) lenis.scrollTo(y, { duration: 1.4, easing: t => 1 - Math.pow(1 - t, 4) });
  else scrollTo({ top: y });
}
$$('[data-scroll]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); scrollToEl(a.dataset.scroll); }));

/* =====================================================================
   MATERIALI CONDIVISI (la sezione "Indossali" li ricolora)
   ===================================================================== */
const MATERIALS = {
  // montatura e aste: vetro satinato azzurrino, semitrasparente
  frame: new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#a9d6fa'), transmission: 0.6, roughness: 0.14, thickness: 0.03, ior: 1.45,
    clearcoat: 1, clearcoatRoughness: 0.08, opacity: 0.9, transparent: true,
    attenuationColor: new THREE.Color('#5fb4f0'), attenuationDistance: 0.1,
  }),
  // lenti: azzurro più chiaro, trasparente
  lens: new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#8ec6f2'), transmission: 0.85, roughness: 0.04, thickness: 0.01, ior: 1.5,
    opacity: 0.5, transparent: true, side: THREE.DoubleSide,
  }),
  hinge: new THREE.MeshStandardMaterial({ color: 0xd6dde5, metalness: 1, roughness: 0.28 }),
};
for (const m of Object.values(MATERIALS)) m.userData.baseOpacity = m.opacity;

/* =====================================================================
   RENDERER, SCENA, LUCI
   ===================================================================== */
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.transmissionResolutionScale = 0.5;   // la rifrazione non ha bisogno della piena risoluzione

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-2.5, 4, -3); // in alto a destra (la destra dello schermo è -X)
scene.add(sun);

addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight, false));

/* Ombra di contatto morbida */
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.5, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.5, 1.5),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false })
);
shadow.rotation.x = -Math.PI / 2;
shadow.renderOrder = -2;
scene.add(shadow);
const SHADOW_BASE = 0.32;

/* =====================================================================
   MODELLO
   ===================================================================== */
const holder = new THREE.Group();   // posa per-view (rotazione, posizione, scala)
const inner = new THREE.Group();    // coordinate originali, centrato e scalato a larghezza 1
holder.add(inner);
scene.add(holder);
holder.visible = false;

const model = {
  ready: false, k: 1, mmPerUnit: 1000, dims: { w: 158, h: 68, d: 155 }, count: 10,
  parts: {}, pivotSX: null, pivotDX: null, hinge: { SX: new THREE.Vector3(), DX: new THREE.Vector3() },
  anchor: new THREE.Vector3(), head: null,
};
const CLOSE_ANGLE = THREE.MathUtils.degToRad(95);
const CLOSE_Y_OFFSET = 0.004; // 4 mm reali tra le due aste quando sono ripiegate
const CLOSE_Z_OFFSET = 0.0025; // 2,5 mm: le due aste non si toccano ma le cerniere restano attaccate
const DEBUG_COLORS = { frame: 0x4aa3ff, lens: 0xff4a8d, pads: 0xffd400, hinge: 0x35d07f, arm: 0xb06cff, term: 0xff7a00 };

function prepareModel(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // 1) centro + scala: larghezza = 1 unità di scena
  const k = 1 / size.x;
  const mmPerUnit = size.x < 1 ? 1000 : 1;       // il file è in metri
  const T = mm => mm / mmPerUnit;                  // soglie espresse in mm → unità del file
  model.k = k; model.mmPerUnit = mmPerUnit;
  model.dims = { w: Math.round(size.x * mmPerUnit), h: Math.round(size.y * mmPerUnit), d: Math.round(size.z * mmPerUnit) };
  inner.scale.setScalar(k);
  inner.position.copy(center).multiplyScalar(-k);

  // 2) classificazione per bounding box (coordinate originali)
  const info = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    let tag = '';
    for (let p = o; p; p = p.parent) {
      const n = (p.name || '').toUpperCase();
      if (n.includes('STANGHETTA')) { tag = n.includes('DX') ? 'DX' : 'SX'; break; }
      if (n.includes('LENTE')) { tag = 'F'; break; }
    }
    const c = b.getCenter(new THREE.Vector3());
    if (!tag) tag = c.z > center.z - T(60) && Math.abs(c.x - center.x) > T(55) ? (c.x > center.x ? 'SX' : 'DX') : 'F';
    info.push({ mesh: o, b, c, tag });
  });

  const groups = { frame: [], lens: { SX: [], DX: [] }, pads: [], arm: { SX: [], DX: [] }, hinge: { SX: [], DX: [] }, term: { SX: [], DX: [] } };
  const cx = center.x;
  for (const it of info) {
    const { b, c, tag } = it;
    if (tag === 'SX' || tag === 'DX') {
      if (b.min.z > T(80)) groups.term[tag].push(it);        // gomma: punte dietro l'orecchio
      else if (b.max.z < T(50)) groups.hinge[tag].push(it);  // cerniere: zona di attacco vicino al frontale
      else groups.arm[tag].push(it);
    } else {
      const w = b.max.x - b.min.x, d = b.max.z - b.min.z;
      if (Math.abs(c.x - cx) < T(25) && b.max.y < T(90) && b.min.y < T(66)) groups.pads.push(it);   // naselli
      else if (w > T(30) && d < T(20)) groups.lens[c.x >= cx ? 'SX' : 'DX'].push(it);               // superfici delle lenti
      else groups.frame.push(it);
    }
  }
  const tri = list => list.reduce((s, it) => s + (it.mesh.geometry.index ? it.mesh.geometry.index.count : it.mesh.geometry.attributes.position.count) / 3, 0);
  const summary = {
    'montatura': groups.frame, 'lente SX': groups.lens.SX, 'lente DX': groups.lens.DX, 'naselli': groups.pads,
    'asta SX': groups.arm.SX, 'asta DX': groups.arm.DX, 'cerniera SX': groups.hinge.SX, 'cerniera DX': groups.hinge.DX,
    'terminale SX': groups.term.SX, 'terminale DX': groups.term.DX,
  };
  console.log(`[${MODEL_NAME}] ${info.length} mesh figlie — dimensioni ${model.dims.w}×${model.dims.h}×${model.dims.d} mm`);
  console.table(Object.fromEntries(Object.entries(summary).map(([n, l]) => [n, { mesh: l.length, triangoli: Math.round(tri(l)) }])));

  // 3) pivot delle cerniere (estremo anteriore di ogni asta)
  const armBox = tag => {
    const bb = new THREE.Box3();
    for (const g of [groups.arm, groups.hinge, groups.term]) g[tag].forEach(it => bb.union(it.b));
    return bb;
  };
  // perno = nodini della cerniera (mesh dell'asta attaccate al frontale, z < 15 mm): centro x/z, centro y dell'asta
  const hingePivot = tag => {
    const ab = armBox(tag), kb = new THREE.Box3();
    groups.hinge[tag].filter(it => it.b.max.z < T(15)).forEach(it => kb.union(it.b));
    if (kb.isEmpty()) return new THREE.Vector3(tag === 'SX' ? ab.max.x : ab.min.x, (ab.min.y + ab.max.y) / 2, ab.min.z);
    const c = kb.getCenter(new THREE.Vector3());
    return new THREE.Vector3(c.x, (ab.min.y + ab.max.y) / 2, c.z);
  };
  model.hinge.SX.copy(hingePivot('SX'));
  model.hinge.DX.copy(hingePivot('DX'));
  const pivots = {
    SX: new THREE.Group(), DX: new THREE.Group(),
  };
  pivots.SX.position.copy(model.hinge.SX); pivots.DX.position.copy(model.hinge.DX);
  model.pivotSX = pivots.SX; model.pivotDX = pivots.DX;
  model.pivotBaseY = { SX: pivots.SX.position.y, DX: pivots.DX.position.y };
  inner.add(pivots.SX, pivots.DX);

  // 4) costruzione dei componenti (un Group + una mesh unita per componente)
  const dbg = k2 => new THREE.MeshStandardMaterial({ color: DEBUG_COLORS[k2], roughness: 0.6, metalness: 0 });
  const mk = (name, list, matKey, parent, base, dir, dist) => {
    if (!list.length) return null;
    const g = new THREE.Group(); g.name = name;
    parent.add(g);
    // unisce le geometrie (position + normal) in una sola mesh
    const geos = list.map(it => {
      let geo = it.mesh.geometry.clone();
      for (const n of Object.keys(geo.attributes)) if (n !== 'position' && n !== 'normal') geo.deleteAttribute(n);
      if (geo.index) geo = geo.toNonIndexed();
      geo.applyMatrix4(it.mesh.matrixWorld);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      return geo;
    });
    const merged = mergeGeometries(geos, false);
    let mesh;
    const mat = DEBUG ? dbg(matKey === 'rubber' ? (name.startsWith('naselli') ? 'pads' : 'term') : matKey === 'lens' ? 'lens' : matKey === 'hinge' ? 'hinge' : name.startsWith('asta') ? 'arm' : 'frame') : MATERIALS[matKey === 'rubber' ? 'frame' : matKey];
    if (merged) { mesh = new THREE.Mesh(merged, mat); g.add(mesh); }
    else list.forEach(it => { const m = new THREE.Mesh(it.mesh.geometry, mat); m.applyMatrix4(it.mesh.matrixWorld); g.add(m); });
    if (parent !== inner) { g.position.copy(parent.position).negate(); }
    g.userData = { base: g.position.clone(), dir: dir.clone().normalize(), dist, name };
    return g;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const parts = {
    frame: mk('montatura', groups.frame, 'frame', inner, null, V(0, 0, 0), 0),
    lensSX: mk('lente SX', groups.lens.SX, 'lens', inner, null, V(0.18, -0.25, -1), 0.5),
    lensDX: mk('lente DX', groups.lens.DX, 'lens', inner, null, V(-0.18, -0.25, -1), 0.5),
    pads: mk('naselli', groups.pads, 'rubber', inner, null, V(0, -1, -0.55), 0.42),
    armSX: mk('asta SX', groups.arm.SX, 'frame', pivots.SX, null, V(1, 0, 0.75), 0.42),
    armDX: mk('asta DX', groups.arm.DX, 'frame', pivots.DX, null, V(-1, 0, 0.75), 0.42),
    hingeSX: mk('cerniera SX', groups.hinge.SX, 'hinge', pivots.SX, null, V(1, 0, 0.1), 0.62),
    hingeDX: mk('cerniera DX', groups.hinge.DX, 'hinge', pivots.DX, null, V(-1, 0, 0.1), 0.62),
    termSX: mk('terminale SX', groups.term.SX, 'rubber', pivots.SX, null, V(0.55, 0, 1), 0.8),
    termDX: mk('terminale DX', groups.term.DX, 'rubber', pivots.DX, null, V(-0.55, 0, 1), 0.8),
  };
  // prepass di profondità delle lenti (solo prova virtuale): le stanghette dietro una lente non si vedono attraverso
  model.lensDepth = [];
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  for (const g of [parts.lensSX, parts.lensDX]) {
    if (!g) continue;
    g.traverse(o => {
      if (!o.isMesh) return;
      const d = new THREE.Mesh(o.geometry, depthMat);
      d.renderOrder = -1; d.visible = false; d.frustumCulled = false;
      o.parent.add(d); model.lensDepth.push(d);
    });
  }
  // le posizioni "base" dei componenti dentro i pivot compensano la posizione del pivot
  for (const p of Object.values(parts)) if (p) p.userData.base = p.position.clone();
  model.parts = parts;
  model.count = Object.values(parts).filter(Boolean).length;

  // ancora per la prova virtuale: centro del frontale della montatura (lato anteriore), in coordinate "holder"
  {
    const fb = new THREE.Box3();
    [...groups.frame, ...groups.lens.SX, ...groups.lens.DX].forEach(it => fb.union(it.b));
    const c = fb.getCenter(new THREE.Vector3());
    model.anchor.set(c.x, c.y, fb.min.z).sub(center).multiplyScalar(k);
  }
  // "testa invisibile" per l'occlusione delle aste: nasconde le stanghette dietro il viso (posa impostata ogni frame)
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), new THREE.MeshBasicMaterial({ colorWrite: false }));
  head.renderOrder = -1; head.visible = false; head.matrixAutoUpdate = false; head.frustumCulled = false;
  scene.add(head); model.head = head;

  // scritta "GMT" in rilievo sull'esterno di ogni stanghetta: punto e normale si trovano con un raggio sulla superficie
  const spots = {};
  for (const tag of ['SX', 'DX']) {
    const items = groups.arm[tag]; if (!items.length) continue;
    const ab = new THREE.Box3(); items.forEach(it => ab.union(it.b));
    const zt = ab.min.z + 0.42 * (ab.max.z - ab.min.z);
    const out = tag === 'SX' ? 1 : -1;
    const ray = new THREE.Raycaster();
    const meshes = items.map(it => it.mesh);
    for (const dy of [0, 0.15, -0.15, 0.3, -0.3]) {
      const y = (ab.min.y + ab.max.y) / 2 + dy * (ab.max.y - ab.min.y);
      ray.set(new THREE.Vector3(out > 0 ? ab.max.x + T(20) : ab.min.x - T(20), y, zt), new THREE.Vector3(-out, 0, 0));
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit || !hit.face) continue;
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      if (n.x * out < 0.2) continue;   // solo superfici rivolte verso l'esterno
      spots[tag] = { p: hit.point.clone(), n };
      break;
    }
  }
  {
    const W = 512, H = 192;
    const mk2 = (draw) => { const c = document.createElement('canvas'); c.width = W; c.height = H; draw(c.getContext('2d')); return c; };
    const font = '800 150px "Inter", "Helvetica Neue", Arial, sans-serif';
    const txt = (g, x, y, style) => { g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = style; g.fillText('GMT', x, y); };
    // colore: lettere argento con ombra scura sotto-destra e luce sopra-sinistra (effetto rilievo)
    const colorC = mk2(g => {
      txt(g, W / 2 + 3, H / 2 + 4, 'rgba(20,30,45,.85)');
      txt(g, W / 2 - 2, H / 2 - 2, 'rgba(255,255,255,.95)');
      const gr = g.createLinearGradient(0, 40, 0, 150); gr.addColorStop(0, '#f4f7fb'); gr.addColorStop(1, '#aab4c0');
      txt(g, W / 2, H / 2, gr);
    });
    // bump: lettere sfumate = bordi arrotondati che prendono la luce
    const bumpC = mk2(g => { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.filter = 'blur(5px)'; txt(g, W / 2, H / 2, '#fff'); });
    const mapT = new THREE.CanvasTexture(colorC); mapT.colorSpace = THREE.SRGBColorSpace; mapT.anisotropy = 8;
    const bumpT = new THREE.CanvasTexture(bumpC);
    const logoMat = new THREE.MeshStandardMaterial({
      map: mapT, bumpMap: bumpT, bumpScale: 6, transparent: true, alphaTest: 0.05, metalness: 0.7, roughness: 0.35,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false,
    });
    MATERIALS.logo = logoMat; logoMat.userData.baseOpacity = 1;
    for (const tag of ['SX', 'DX']) {
      const sp = spots[tag], g = tag === 'SX' ? parts.armSX : parts.armDX;
      if (!sp || !g) { console.warn('[gmt] punto per la scritta non trovato su', tag); continue; }
      const n = sp.n;
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize();
      const up = new THREE.Vector3().crossVectors(n, right).normalize();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(T(13), T(13) * H / W), logoMat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(right, up, n).setPosition(sp.p.clone().addScaledVector(n, T(0.12)));
      mesh.name = 'logo GMT'; mesh.renderOrder = 2;
      g.add(mesh);
    }
  }

  model.ready = true;
  holder.visible = true;
  if (DEBUG) console.log('[debug] colori: montatura blu, lenti rosa, naselli giallo, cerniere verde, aste viola, terminali arancio');
}

/* =====================================================================
   VIEW: ogni <div class="view"> è una finestra (scissor) sul canvas
   ===================================================================== */
const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const CFG = {
  'hero':      { fov: 26, dir: D(0, 0.07, -1),      ext: [1, 0.55], fill: 0.4,  fillP: 0.88 },
  'g-three':   { fov: 26, dir: D(-0.6, 0.36, -0.72), ext: [1, 0.78], fill: 0.5,  fillP: 0.7 },
  'g-front':   { fov: 26, dir: D(0, 0.0, -1),       ext: [1, 0.5],  fill: 0.66, fillP: 0.8 },
  'g-profile': { fov: 26, dir: D(1, 0.0, 0),        ext: [1, 0.55], fill: 0.74, fillP: 0.85 },
  'g-top':     { fov: 26, dir: D(0, 1, 0.0001), up: new THREE.Vector3(0, 0, 1), ext: [1, 1.02], fill: 0.76, fillP: 0.85 },
  'g-closed':  { fov: 26, dir: D(-0.6, 0.34, -0.72), ext: [1, 0.85], fill: 0.56, fillP: 0.7 },
  'open':      { fov: 26, dir: D(-0.1, 0.84, -0.54), ext: [1.04, 1.0], fill: 0.56, fillP: 0.8 },
  'explode':   { fov: 26, dir: D(-0.34, 0.3, -0.9), ext: [1.95, 1.2], fill: 0.78, fillP: 0.9 },
};
const newState = o => Object.assign({ rx: 0, ry: 0, rz: 0, x: 0, y: 0, z: 0, s: 1, cl: 0, cr: 0, ex: 0, cd: 1, sh: 1, idle: true, hx: 0, hy: 0 }, o);

// stati animati dallo scroll / dall'intro
const A = {
  hero: { intro: { ry: 0, rx: 0, s: 1, y: 0 }, scr: { ry: 0, rx: 0, s: 0, y: 0 } },
  open: { ry: 0, cl: 0, cr: 0 },
  explode: { ry: 0, ex: 0, cd: 0, labels: 0 },
};
const HERO_A = -0.72;   // posa a fine intro (3/4 sul fianco)
const HERO_B = 0.2;     // posa a fine scroll (frontale, leggermente 3/4)
const stateFns = {
  'hero': () => newState({
    ry: HERO_A + A.hero.intro.ry + (HERO_B - HERO_A) * A.hero.scr.ry,
    rx: 0.12 + A.hero.intro.rx - 0.1 * A.hero.scr.rx,
    s: A.hero.intro.s * (1 - 0.24 * A.hero.scr.s),
    y: A.hero.intro.y + 0.12 * A.hero.scr.y,
    sh: 0.9,
  }),
  'g-three': () => newState({}),
  'g-front': () => newState({}),
  'g-profile': () => newState({}),
  'g-top': () => newState({ sh: 0.5 }),
  'g-closed': () => newState({ cl: 1, cr: 1 }),
  'open': () => newState({ ry: 0.15 + A.open.ry, cl: A.open.cl, cr: A.open.cr, sh: 0.6, y: 0.2 * Math.min(A.open.cl, A.open.cr), z: -0.05 * Math.min(A.open.cl, A.open.cr) }),
  'explode': () => newState({ ry: 0.2 + A.explode.ry, ex: A.explode.ex, cd: 1 + 0.38 * A.explode.cd, y: -0.02 * A.explode.ex, sh: 0.9 * (1 - A.explode.ex) }),
};

const views = {};
$$('.view').forEach((el, i) => {
  const name = el.dataset.view;
  views[name] = { name, el, i, visible: false, cam: new THREE.PerspectiveCamera(26, 1, 0.05, 30), cfg: CFG[name], tx: 0, ty: 0, hx: 0, hy: 0, fade: (name === 'hero' || name.startsWith('g-')) ? 0 : 1 };
});
const io = new IntersectionObserver(es => es.forEach(e => { const v = Object.values(views).find(v => v.el === e.target); if (v) v.visible = e.isIntersecting; }), { rootMargin: '120px' });
Object.values(views).forEach(v => io.observe(v.el));

// parallasse col mouse sulle card della galleria (±5°)
const MAXROT = THREE.MathUtils.degToRad(5);
$$('.card').forEach(card => {
  const v = views[card.querySelector('.view').dataset.view];
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    v.tx = ((e.clientX - r.left) / r.width - 0.5) * 2 * MAXROT;
    v.ty = ((e.clientY - r.top) / r.height - 0.5) * 2 * MAXROT;
  });
  card.addEventListener('pointerleave', () => { v.tx = 0; v.ty = 0; });
});

/* ---- applicazione dello stato al modello ---- */
const IDLE_AMP = 0.01, IDLE_PERIOD = 4;
const easeIO = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function applyState(st, t, phase) {
  const bob = REDUCED || !st.idle ? 0 : Math.sin((t / IDLE_PERIOD) * Math.PI * 2 + phase) * IDLE_AMP;
  holder.quaternion.identity();
  holder.rotation.set(st.rx + st.hy, st.ry + st.hx, st.rz, 'YXZ');
  holder.position.set(st.x, st.y + bob, st.z);
  holder.scale.setScalar(st.s);
  const { pivotSX, pivotDX, hinge, k, parts } = model;
  pivotSX.rotation.y = -CLOSE_ANGLE * st.cl;
  pivotDX.rotation.y = CLOSE_ANGLE * st.cr;
  pivotSX.position.copy(hinge.SX);
  pivotDX.position.copy(hinge.DX); pivotDX.position.y += CLOSE_Y_OFFSET * st.cr;
  pivotDX.position.z += CLOSE_Z_OFFSET * THREE.MathUtils.smoothstep(st.cr, 0.35, 1);
  for (const p of Object.values(parts)) {
    if (!p) continue;
    const u = p.userData;
    p.position.copy(u.base).addScaledVector(u.dir, (st.ex * u.dist) / k);
  }
  // ombra di contatto: sotto gli occhiali, non ruota
  shadow.position.set(holder.position.x, holder.position.y - 0.36 * st.s, holder.position.z);
  shadow.scale.set(st.s * 1.15, st.s, st.s * 0.7);
  shadow.material.opacity = SHADOW_BASE * st.sh;
  shadow.visible = st.sh > 0.01;
  holder.updateMatrixWorld(true);
}

function placeCamera(v, w, h, st) {
  const cfg = v.cfg, cam = v.cam;
  cam.aspect = w / h; cam.fov = cfg.fov; cam.updateProjectionMatrix();
  const tan = Math.tan(THREE.MathUtils.degToRad(cfg.fov / 2));
  const fill = w < h ? cfg.fillP : cfg.fill;
  const d = Math.max(cfg.ext[0] / (fill * 2 * tan * cam.aspect), cfg.ext[1] / (fill * 2 * tan)) * st.cd;
  cam.up.copy(cfg.up || UP);
  cam.position.copy(cfg.dir).multiplyScalar(d);
  cam.lookAt(0, 0, 0);
}

/* =====================================================================
   ETICHETTE ESPLOSO
   ===================================================================== */
const LABELS = [
  { name: 'Montatura', part: 'frame',  off: [0, -105] },
  { name: 'Lente',     part: 'lensSX', off: [-120, -70] },
  { name: 'Asta',      part: 'armSX',  off: [-120, -95] },
  { name: 'Cerniera',  part: 'hingeSX', off: [-130, 80] },
  { name: 'Nasello',   part: 'pads',   off: [0, 80] },
  { name: 'Terminale', part: 'termSX', off: [-110, 90] },
];
const svg = $('#leaders');
LABELS.forEach(l => {
  l.el = document.createElement('div'); l.el.className = 'label'; l.el.textContent = l.name; $('#labels').appendChild(l.el);
  l.line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l.line.style.opacity = 0; svg.appendChild(l.line);
});
const _b = new THREE.Box3(), _v = new THREE.Vector3();
function updateLabels(v, rect) {
  const on = A.explode.labels;
  for (const l of LABELS) {
    const p = model.parts[l.part];
    if (!p || on < 0.01) { l.el.style.opacity = 0; l.line.style.opacity = 0; continue; }
    _b.setFromObject(p); _b.getCenter(_v).project(v.cam);
    const px = rect.left + (_v.x * 0.5 + 0.5) * rect.width;
    const py = rect.top + (-_v.y * 0.5 + 0.5) * rect.height;
    const s = Math.min(1, rect.width / 1100);
    const lw = l.el.offsetWidth, lh = l.el.offsetHeight;
    const lx = Math.min(innerWidth - lw / 2 - 8, Math.max(lw / 2 + 8, px + l.off[0] * Math.max(0.6, s))), ly = py + l.off[1] * Math.max(0.6, s);
    l.el.style.transform = `translate(${lx - lw / 2}px, ${ly - lh / 2}px)`;
    l.el.style.opacity = on;
    // linea dal pezzo al bordo più vicino della pillola
    const ex = Math.min(Math.max(px, lx - lw / 2), lx + lw / 2), ey = ly > py ? ly - lh / 2 : ly + lh / 2;
    l.line.setAttribute('x1', px); l.line.setAttribute('y1', py); l.line.setAttribute('x2', ex); l.line.setAttribute('y2', ey);
    l.line.style.opacity = on;
  }
}
function hideLabels() { for (const l of LABELS) { l.el.style.opacity = 0; l.line.style.opacity = 0; } }

/* =====================================================================
   PROVA VIRTUALE (MediaPipe FaceLandmarker)
   ===================================================================== */
const face = {
  active: false, landmarker: null, alpha: 0, found: false, lastVideoTime: -1,
  pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 0.5, init: false,
  cam: new THREE.OrthographicCamera(0, 1, 0, -1, -3, 3), capture: null,
  naso: new THREE.Vector3(), larg: 1, eyeAng: 0, headPos: new THREE.Vector3(), headQuat: new THREE.Quaternion(),
};
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const video = $('#cam');
let cameraStream = null;

function coverMap(vw, vh, cw, ch) {
  const sc = Math.max(cw / vw, ch / vh);
  return { sc, ox: (vw * sc - cw) / 2, oy: (vh * sc - ch) / 2 };
}
/* Tracciamento: stesso metodo del sito "gianmarcotito". Si lavora nello spazio del video NON specchiato
   (unità = larghezza del video, y su, z verso chi guarda); la posa viene specchiata solo al momento del disegno. */
const pt = (l, i, vw, vh) => new THREE.Vector3(l[i].x, -l[i].y * vh / vw, -l[i].z);
const votes = { yaw: [0, 0], pitch: [0, 0] };
function vote(v, ok) { v[ok ? 0 : 1]++; if (v[0] + v[1] > 300) { v[0] = Math.round(v[0] / 2); v[1] = Math.round(v[1] / 2); } }
function measureFace(l, mtx, vw, vh) {
  const P = i => pt(l, i, vw, vh);
  const eyeR = P(33), eyeL = P(263);
  const eyeDist = eyeL.distanceTo(eyeR);
  const faceW = P(454).distanceTo(P(234));
  const axX = P(454).sub(P(234)).add(eyeL.clone().sub(eyeR)).normalize();
  const upL = P(10).sub(P(152)).normalize();
  const axZ = new THREE.Vector3().crossVectors(axX, upL).normalize();
  const axY = new THREE.Vector3().crossVectors(axZ, axX).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(axX, axY, axZ));
  const aY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const aZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const nose = P(168);
  // il frontale sta poco sotto la radice del naso e poco davanti alla pelle: occhiali "attaccati" al viso
  const pos = nose.clone().addScaledVector(aY, -0.1 * eyeDist).addScaledVector(aZ, -0.3 * eyeDist);
  // inclinazione della linea degli occhi come appare sullo schermo specchiato
  const eyeAng = Math.atan2(-(eyeL.y - eyeR.y), eyeL.x - eyeR.x);
  return { quat, pos, nose, faceW, eyeAng };
}
const mirrorP = v => new THREE.Vector3(1 - v.x, v.y, v.z);
const mirrorQ = q => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
function updateFace() {
  const lm = face.landmarker;
  if (lm && video.readyState >= 2 && video.currentTime !== face.lastVideoTime) {
    face.lastVideoTime = video.currentTime;
    let res = null;
    try { res = lm.detectForVideo(video, performance.now()); } catch (e) { /* frame scartato */ }
    const l = res && res.faceLandmarks && res.faceLandmarks[0];
    if (l) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const v = measureFace(l, res.facialTransformationMatrixes && res.facialTransformationMatrixes[0], vw, vh);
      if (!face.init) { face.pos.copy(v.pos); face.quat.copy(v.quat); face.scale = v.faceW; face.larg = v.faceW; face.naso.copy(v.nose); face.eyeAng = v.eyeAng; face.init = true; }
      else {
        face.pos.lerp(v.pos, 0.75); face.quat.slerp(v.quat, 0.7);
        face.scale += (v.faceW - face.scale) * 0.5; face.larg += (v.faceW - face.larg) * 0.5; face.naso.lerp(v.nose, 0.75); face.eyeAng += (v.eyeAng - face.eyeAng) * 0.7;
      }
      face.found = true;
    } else face.found = false;
  }
  face.alpha += ((face.found ? 1 : 0) - face.alpha) * 0.15;
}
// posa finale (specchiata) di occhiali e testa invisibile
function poseFace() {
  const qm = mirrorQ(face.quat);
  // livella: la linea delle lenti deve essere parallela alla linea degli occhi (corregge qualsiasi inclinazione residua)
  const xs = new THREE.Vector3(1, 0, 0).applyQuaternion(qm);
  const dRoll = face.eyeAng - Math.atan2(xs.y, xs.x);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dRoll).multiply(qm).multiply(Q_FLIP);   // Q_FLIP: il frontale del modello guarda verso -z   // il frontale del modello guarda verso -z: lo giro verso chi guarda
  const s = face.scale * 1.1;   // la montatura è un po' più larga del viso, come nella realtà
  const front = mirrorP(face.pos);
  holder.quaternion.copy(q);
  holder.scale.setScalar(s);
  holder.position.copy(front).sub(model.anchor.clone().multiplyScalar(s).applyQuaternion(q));
  const qs = face.quat, L = face.larg;
  const aY = new THREE.Vector3(0, 1, 0).applyQuaternion(qs), aZ = new THREE.Vector3(0, 0, 1).applyQuaternion(qs);
  const rx = 0.46 * L, ry = 0.72 * L, rz = 0.62 * L;
  const c = face.naso.clone().addScaledVector(aZ, -rz - 0.2 * L).addScaledVector(aY, -0.3 * L);
  model.head.matrix.compose(mirrorP(c), mirrorQ(qs), new THREE.Vector3(rx, ry, rz));
  model.head.matrixWorldNeedsUpdate = true;
}
const TRYON_OPACITY = { frame: 1, lens: 0.55, rubber: 1, hinge: 1, logo: 1 };
function setFade(a, tryon = false) {
  for (const [k, m] of Object.entries(MATERIALS)) {
    const base = tryon ? TRYON_OPACITY[k] : m.userData.baseOpacity;
    m.opacity = base * a;
    m.transparent = a < 0.999 || base < 1;
  }
}

/* =====================================================================
   LOOP DI RENDER
   ===================================================================== */
/* qualità adattiva: se il frame supera il budget, scende la risoluzione; se c'è margine, risale */
const PR_MAX = Math.min(devicePixelRatio, 2);
let pr = PR_MAX, emaDt = 16, lastT = performance.now(), slow = 0, fast = 0;
function adaptQuality(now) {
  const dt = Math.min(now - lastT, 100); lastT = now;
  emaDt = emaDt * 0.95 + dt * 0.05;
  if (emaDt > 24 && pr > 1) { if (++slow > 40) { pr = Math.max(1, pr - 0.25); renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false); slow = 0; emaDt = 16; } } else slow = 0;
  if (emaDt < 14 && pr < PR_MAX) { if (++fast > 300) { pr = Math.min(PR_MAX, pr + 0.25); renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false); fast = 0; } } else fast = 0;
}
const coverEl = $('#progetto');
function renderFrame() {
  if (!model.ready || document.hidden) return;
  const now = performance.now();
  adaptQuality(now);
  const W = innerWidth, H = innerHeight, t = now / 1000;
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  let labelsDone = false;

  for (const v of Object.values(views)) {
    const isFace = v.name === 'face';
    if (!v.visible || (isFace && !face.active) || v.fade <= 0.001) continue;
    const r = v.el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;

    // l'hero resta sotto il foglio "Il progetto": non si disegna ciò che è coperto
    let clipBottom = r.bottom;
    if (v.name === 'hero') { clipBottom = Math.min(r.bottom, coverEl.getBoundingClientRect().top); if (clipBottom <= r.top + 1) continue; }

    renderer.setViewport(r.left, H - r.bottom, r.width, r.height);
    renderer.setScissor(r.left, H - clipBottom, r.width, clipBottom - r.top);

    if (isFace) {
      updateFace();
      if (face.alpha < 0.01) { if (face.capture) face.capture = face.capture(r, false); continue; }
      {
        // camera ortogonale: unità = larghezza del video, con lo stesso "cover" del <video> (specchiato)
        const vw = video.videoWidth, vh = video.videoHeight;
        const { sc, ox, oy } = coverMap(vw, vh, r.width, r.height);
        const u = sc * vw;
        face.cam.left = ox / u; face.cam.right = (ox + r.width) / u;
        face.cam.top = -oy / u; face.cam.bottom = -(oy + r.height) / u;
        face.cam.near = -3; face.cam.far = 3; face.cam.position.set(0, 0, 0);
        face.cam.updateProjectionMatrix(); face.cam.updateMatrixWorld(true);
      }
      applyState(newState({ idle: false, sh: 0 }), t, 0);
      poseFace();
      holder.updateMatrixWorld(true);
      model.head.updateMatrixWorld(true);
      model.head.visible = true;
      model.lensDepth.forEach(d => (d.visible = true));
      setFade(face.alpha, true);
      const fm = MATERIALS.frame, lm = MATERIALS.lens, tr0 = fm.transmission;
      fm.transmission = 0.08; fm.attenuationDistance = 1e3;   // sul viso la montatura deve essere piena, non vetro
      const cc0 = fm.clearcoat, ei0 = scene.environmentIntensity, hm = MATERIALS.hinge, hr0 = hm.roughness;
      fm.clearcoat = 0.25; scene.environmentIntensity = 0.5; hm.roughness = 0.6;   // meno riflessi bianchi: sul viso il vetro non deve "bruciare"
      renderer.render(scene, face.cam);
      fm.clearcoat = cc0; scene.environmentIntensity = ei0; hm.roughness = hr0;
      fm.transmission = tr0; fm.attenuationDistance = 0.1;
      setFade(1);
      model.head.visible = false;
      model.lensDepth.forEach(d => (d.visible = false));
      if (face.capture) face.capture = face.capture(r, true);
      continue;
    }

    const st = stateFns[v.name]();
    if (v.name.startsWith('g-')) {
      v.hx = lerp(v.hx, v.tx, 0.08); v.hy = lerp(v.hy, v.ty, 0.08);
      st.hx = v.hx; st.hy = v.hy;
    }
    applyState(st, t, v.i * 1.3);
    placeCamera(v, r.width, r.height, st);
    if (v.fade < 0.999) { setFade(v.fade); shadow.material.opacity *= v.fade; }
    renderer.render(scene, v.cam);
    if (v.fade < 0.999) setFade(1);
    if (v.name === 'explode') { updateLabels(v, r); labelsDone = true; }
  }
  if (!labelsDone) hideLabels();
}
gsap.ticker.add(renderFrame);

/* =====================================================================
   ANIMAZIONI (GSAP: SplitText, ScrollTrigger, scrub)
   ===================================================================== */
function setupScroll() {
  const E = REDUCED ? 0 : 1;

  /* --- barra di avanzamento --- */
  gsap.to('#progress', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: true } });

  /* --- titoli: reveal a righe con maschera (SplitText) --- */
  if (E) {
    $$('[data-split]').forEach(h => {
      SplitText.create(h, {
        type: 'lines', mask: 'lines', autoSplit: true,
        onSplit: self => gsap.from(self.lines, { yPercent: 115, duration: 1.1, ease: 'expo.out', stagger: 0.09, scrollTrigger: { trigger: h, start: 'top 88%', once: true } }),
      });
    });
    $$('[data-fade]').forEach(el => gsap.from(el, { opacity: 0, y: 26, duration: 1, ease: 'expo.out', scrollTrigger: { trigger: el, start: 'top 92%', once: true } }));
  }

  /* --- HERO --- */
  const heroCopy = $('.hero-copy');
  const chars = SplitText.create('.hero-copy h1', { type: 'chars' }).chars;
  const hs = A.hero.scr;
  const tl = gsap.timeline({ scrollTrigger: { trigger: '#vista', start: 'top top', end: '+=100%', scrub: true } });
  tl.to(hs, { ry: 1, ease: 'power2.inOut', duration: 1 }, 0)
    .to(hs, { rx: 1, s: 1, y: 1, ease: 'none', duration: 1 }, 0)
    .from('.hero-copy .eyebrow', { opacity: 0, y: 24, duration: 0.25, ease: 'power2.out' }, 0.42)
    .from(chars, { yPercent: 60, opacity: 0, duration: 0.45, stagger: 0.035, ease: 'power3.out' }, 0.45)
    .from('.hero-copy .sub', { opacity: 0, y: 24, duration: 0.25, ease: 'power2.out' }, 0.7);
  gsap.to('.hint', { opacity: 0, ease: 'none', scrollTrigger: { trigger: '#vista', start: 'top top', end: '+=12%', scrub: true } });
  gsap.to('.b1', { x: 120, y: -140, ease: 'none', scrollTrigger: { trigger: '#vista', start: 'top top', end: 'bottom bottom', scrub: true } });
  gsap.to('.b2', { x: -140, y: 120, ease: 'none', scrollTrigger: { trigger: '#vista', start: 'top top', end: 'bottom bottom', scrub: true } });
  // uscita: il foglio "Il progetto" copre l'hero, il titolo sfuma
  gsap.to(heroCopy, { opacity: 0, y: -30, ease: 'none', scrollTrigger: { trigger: '#progetto', start: 'top 95%', end: 'top 35%', scrub: true } });

  /* --- marquee guidata dallo scroll --- */
  gsap.fromTo('.mq-track', { xPercent: 0 }, { xPercent: -45, ease: 'none', scrollTrigger: { trigger: '.marquee', start: 'top bottom', end: 'bottom top', scrub: true } });

  /* --- GALLERIA: card in sequenza + il modello "si accende" --- */
  const cards = $$('.bento .card');
  if (E) gsap.set(cards, { opacity: 0, y: 70, scale: 0.94 });
  else Object.values(views).forEach(v => { if (v.name.startsWith('g-')) v.fade = 1; });
  if (E) ScrollTrigger.batch(cards, {
    start: 'top 92%', once: true,
    onEnter: batch => {
      gsap.to(batch, { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: 'expo.out', stagger: 0.1 });
      batch.forEach((c, i) => gsap.to(views[c.querySelector('.view').dataset.view], { fade: 1, duration: 1.1, delay: 0.25 + i * 0.1, ease: 'power2.out' }));
    },
  });

  /* --- SI APRE / SI CHIUDE --- */
  gsap.fromTo('#apertura .bigcard', { scale: 0.9, borderRadius: 40, y: 60 }, { scale: 1, borderRadius: 28, y: 0, ease: 'none', scrollTrigger: { trigger: '#apertura', start: 'top bottom', end: 'top top', scrub: true } });
  const o = A.open;
  gsap.set('#apertura .t-b', { opacity: 0 });
  gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '#apertura', start: 'top top', end: 'bottom bottom', scrub: true } })
    .to(o, { ry: 0.7, duration: 1 }, 0)
    .to(o, { cl: 1, ease: 'power2.inOut', duration: 0.65 }, 0.15)
    .to(o, { cr: 1, ease: 'power2.inOut', duration: 0.6 }, 0.25)
    .to('#apertura .t-a', { opacity: 0, yPercent: -40, filter: 'blur(8px)', duration: 0.12 }, 0.43)
    .fromTo('#apertura .t-b', { opacity: 0, yPercent: 40, filter: 'blur(8px)' }, { opacity: 1, yPercent: 0, filter: 'blur(0px)', duration: 0.12, immediateRender: false }, 0.5);

  /* --- ESPLOSO --- */
  gsap.fromTo('#esploso .bigcard', { scale: 0.9, borderRadius: 40, y: 60 }, { scale: 1, borderRadius: 28, y: 0, ease: 'none', scrollTrigger: { trigger: '#esploso', start: 'top bottom', end: 'top top', scrub: true } });
  const e = A.explode;
  gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '#esploso', start: 'top top', end: 'bottom bottom', scrub: true } })
    .to(e, { ry: 0.35, duration: 1 }, 0)
    .to(e, { ex: 1, cd: 1, ease: 'power2.inOut', duration: 0.5 }, 0.25)
    .to(e, { labels: 1, duration: 0.08 }, 0.77);

  /* --- MISURE: schede in sequenza + count-up --- */
  const stats = $$('.stat');
  if (E) gsap.set(stats, { opacity: 0, y: 40 });
  if (E) ScrollTrigger.batch(stats, { start: 'top 92%', once: true, onEnter: b => gsap.to(b, { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.08 }) });
  $$('[data-count]').forEach(el => {
    const target = { w: model.dims.w, h: model.dims.h, d: model.dims.d, n: model.count }[el.dataset.count];
    const obj = { v: 0 };
    el.textContent = E ? '0' : target;
    if (!E) return;
    ScrollTrigger.create({ trigger: el, start: 'top 92%', once: true, onEnter: () => gsap.to(obj, { v: target, duration: 1.4, delay: 0.15, ease: 'power3.out', onUpdate: () => (el.textContent = Math.round(obj.v)) }) });
  });

  /* --- Indossali: pannello colori --- */
  if (E) {
    gsap.from('#panel .group, #panel .btn-outline', { opacity: 0, y: 30, duration: 0.9, ease: 'expo.out', stagger: 0.1, scrollTrigger: { trigger: '#panel', start: 'top 88%', once: true } });
    gsap.from('#tryon-card', { opacity: 0, y: 60, scale: 0.96, duration: 1.2, ease: 'expo.out', scrollTrigger: { trigger: '#tryon-card', start: 'top 90%', once: true } });
  }
}

/* bottoni "magnetici" */
function setupMagnetic() {
  if (REDUCED) return;
  $$('.magnetic').forEach(el => {
    const qx = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' }), qy = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' });
    el.addEventListener('pointermove', e => { const r = el.getBoundingClientRect(); qx((e.clientX - (r.left + r.width / 2)) * 0.3); qy((e.clientY - (r.top + r.height / 2)) * 0.4); });
    el.addEventListener('pointerleave', () => { qx(0); qy(0); });
  });
}

function heroIntro() {
  const v = views.hero, i = A.hero.intro;
  if (REDUCED) { v.fade = 1; return; }
  i.ry = 2.6; i.rx = 0.45; i.s = 1.4; i.y = 0.05;
  gsap.to(i, { ry: 0, rx: 0, s: 1, y: 0, duration: 1.8, ease: 'power3.out' });
  gsap.to(v, { fade: 1, duration: 1.1, ease: 'power2.out' });
}

/* =====================================================================
   PROVA VIRTUALE: UI colori + camera + foto
   ===================================================================== */
const tweenColor = (mat, key, hex, d) => { const c = new THREE.Color(hex); gsap.to(mat[key], { r: c.r, g: c.g, b: c.b, duration: d, ease: 'power1.out', overwrite: 'auto' }); };
const DUR = REDUCED ? 0 : 0.4;
const tweenOpacity = (m, op) => gsap.to(m.userData, { baseOpacity: op, duration: DUR, overwrite: 'auto', onUpdate: () => (m.opacity = m.userData.baseOpacity) });
// montatura: colore + tinta interna + quanto e' trasparente
const frameLook = (c, att, tr, op = 0.9) => {
  const m = MATERIALS.frame;
  tweenColor(m, 'color', c, DUR); tweenColor(m, 'attenuationColor', att, DUR);
  gsap.to(m, { transmission: tr, duration: DUR, overwrite: 'auto' }); tweenOpacity(m, op);
};
const lensLook = (c, op) => { tweenColor(MATERIALS.lens, 'color', c, DUR); tweenOpacity(MATERIALS.lens, op); };
const SWATCHES = [
  { key: 'frame', title: 'Montatura', def: 0, opts: [['Azzurro', '#a9d6fa'], ['Cristallo', '#ffffff'], ['Fumo', '#6b5a55'], ['Tabacco', '#8c6b5a'], ['Moka', '#5a463f'], ['Rosso', '#c0392b']],
    apply: c => {
      if (c === '#a9d6fa') frameLook('#a9d6fa', '#5fb4f0', 0.6);
      else if (c === '#ffffff') frameLook('#ffffff', '#f2f2f2', 1, 0.95);
      else frameLook(c, c, 0.6);   // colorata ma trasparente
    } },
  { key: 'lens', title: 'Lenti', def: 0, opts: [['Azzurro', '#8ec6f2'], ['Trasparenti', '#e9eff4'], ['Fumé', '#6b5a55'], ['Ambra', '#8c6b5a'], ['Grigio', '#4a4040'], ['Blu', '#2f6fdc']],
    apply: c => lensLook(c, c === '#8ec6f2' ? 0.5 : c === '#e9eff4' ? 0.3 : 0.7) },
];
function buildPanel() {
  const panel = $('#panel');
  SWATCHES.forEach(g => {
    const wrap = document.createElement('div'); wrap.className = 'group';
    const h = document.createElement('h3'); const name = document.createElement('span'); h.append(g.title + ' ', name);
    const row = document.createElement('div'); row.className = 'swatches';
    g.opts.forEach(([label, hex], i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.title = label; b.setAttribute('aria-label', `${g.title}: ${label}`);
      b.style.setProperty('--c', hex || '#ffffff'); if (!hex) b.dataset.clear = '1';
      b.addEventListener('click', () => select(i));
      row.appendChild(b);
    });
    function select(i, first) {
      [...row.children].forEach((c, j) => c.classList.toggle('is-on', j === i));
      name.textContent = g.opts[i][0];
      if (!first) g.apply(g.opts[i][1]);
    }
    select(g.def, true);
    wrap.append(h, row); panel.appendChild(wrap);
  });
}
buildPanel();

async function startCamera() {
  const msg = $('#cam-msg'), btn = $('#btn-cam');
  msg.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = 'Questo browser non permette l’accesso alla telecamera (serve https o localhost).'; return; }
  btn.disabled = true; btn.textContent = 'Attivo la telecamera…';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Attiva la telecamera';
    msg.textContent = 'Nessun problema: senza il permesso della telecamera non posso mostrarti gli occhiali addosso. Puoi riprovare quando vuoi, dalle impostazioni del browser.';
    return;
  }
  video.srcObject = cameraStream;
  try { await video.play(); } catch (e) { /* autoplay */ }
  try {
    btn.textContent = 'Carico il riconoscimento del volto…';
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    const make = delegate => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true,
    });
    if (!face.landmarker) { try { face.landmarker = await make('GPU'); } catch (e) { face.landmarker = await make('CPU'); } }
  } catch (err) {
    console.error(err);
    cameraStream.getTracks().forEach(t => t.stop());
    btn.disabled = false; btn.textContent = 'Attiva la telecamera';
    msg.textContent = 'Non sono riuscito a caricare il riconoscimento del volto. Controlla la connessione e riprova.';
    return;
  }
  face.active = true; face.init = false; face.found = false; face.alpha = 0; face.lastVideoTime = -1;
  $('#tryon-card').classList.add('live');
}
$('#btn-cam').addEventListener('click', startCamera);

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  video.pause(); video.srcObject = null;
  face.active = false; face.found = false; face.alpha = 0; face.capture = null;
  $('#tryon-card').classList.remove('live');
  const btn = $('#btn-cam'); btn.disabled = false; btn.textContent = 'Attiva la telecamera';
  $('#cam-msg').textContent = '';
}
$('#btn-stop').addEventListener('click', stopCamera);
$('#btn-shot').addEventListener('click', takePhoto);

function takePhoto() {
  if (!face.active) return;
  const flash = $('#flash');
  gsap.fromTo(flash, { opacity: 0.85 }, { opacity: 0, duration: 0.45, ease: 'power2.out' });
  // la composizione avviene nel frame di render successivo, subito dopo il disegno 3D
  face.capture = (r, drawn) => {
    const pr = renderer.getPixelRatio();
    const out = document.createElement('canvas'); out.width = Math.round(r.width * pr); out.height = Math.round(r.height * pr);
    const g = out.getContext('2d');
    const vw = video.videoWidth, vh = video.videoHeight;
    const { sc, ox, oy } = coverMap(vw, vh, out.width, out.height);
    g.save(); g.translate(out.width, 0); g.scale(-1, 1);                       // specchiato come a schermo
    g.drawImage(video, 0, 0, vw, vh, -ox + 0, -oy + 0, vw * sc, vh * sc);
    g.restore();
    if (drawn) g.drawImage(renderer.domElement, r.left * pr, r.top * pr, r.width * pr, r.height * pr, 0, 0, out.width, out.height);
    out.toBlob(blob => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'gmt-studio-foto.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
    return null;
  };
}

/* =====================================================================
   AVVIO
   ===================================================================== */
const loaderEl = $('#loader'), pctEl = $('#loader .pct'), barEl = $('#loader .bar i');
const SEEN = (() => { try { return sessionStorage.getItem('gmt-loaded') === '1'; } catch (e) { return false; } })();
if (SEEN) { loaderEl.remove(); document.body.classList.remove('loading'); }
const prog = { v: 0 };
const setProg = p => !SEEN && gsap.to(prog, { v: p, duration: 0.4, overwrite: true, onUpdate: () => { pctEl.textContent = Math.round(prog.v * 100) + '%'; barEl.style.transform = `scaleX(${prog.v})`; } });
new GLTFLoader().load(
  GLB_URL,
  gltf => {
    prepareModel(gltf);
    $('#explode-copy').textContent = `${model.count} componenti: montatura, lenti, aste, cerniere, naselli e terminali.`;
    setupScroll();
    setupMagnetic();
    ScrollTrigger.refresh();
    setProg(1);
    try { sessionStorage.setItem('gmt-loaded', '1'); } catch (e) { /* ok */ }
    gsap.delayedCall(SEEN ? 0 : 0.45, () => {
      document.body.classList.remove('loading');
      if (!SEEN) gsap.to(loaderEl, { yPercent: -100, duration: REDUCED ? 0 : 1, ease: 'expo.inOut', onComplete: () => loaderEl.remove() });
      gsap.delayedCall(REDUCED || SEEN ? 0 : 0.35, heroIntro);
    });
  },
  xhr => { if (xhr.total) setProg(xhr.loaded / xhr.total); },
  err => {
    console.error(err);
    pctEl.textContent = location.protocol === 'file:' ? 'Apri la pagina con un server locale (Live Server)' : 'Impossibile caricare il modello 3D';
  }
);
if (DEBUG) window.__tito = { model, views, A, MATERIALS, holder, scene, renderer, gsap, ScrollTrigger, CFG, THREE, stateFns, newState };
