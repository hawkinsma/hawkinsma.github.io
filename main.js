// ASCII-rendered 3D logo for the page background: three interlocking square-beam
// arms in the style of a Penrose triangle.
// Geometry is sampled once per resize as surface points + normals; each frame
// rotates them, projects into a character grid with a z-buffer, and shades
// each cell by a luminance ramp.
(() => {
    const canvas = document.getElementById('ascii-bg');
    const ctx = canvas.getContext('2d', { alpha: false });

    const RAMP = '.,-~:;=!*#$@';
    const LEVELS = RAMP.length;
    // Sparser ramp for the background wave field
    const WAVE_RAMP = '.:-=+';

    // Each of the logo's three bent bands is its own solid arm: a square beam with
    // two legs. Every leg runs along one of the x, y, z axes, and the view straight
    // down the (1, 1, 1) diagonal is the logo, so face-on the arms interlock into
    // the flat mark while turning shows they are separate pieces in 3D.
    // Logo SVG units (viewBox 0 0 1000 866.03); a model unit is 500 of them.
    const SVG_UNIT = 1 / 500;
    const LOGO_CENTER = [500, 536.34]; // centroid of the triangle, the spin axis
    const ARMS = [
        {
            path: [[305.10, 706.70], [937.16, 706.70], [550.09, 36.28]],
            band: [[284.15, 742.98], [1000, 742.98], [571.04, 0], [529.14, 72.56], [874.32, 670.42], [326.05, 670.42]],
        },
        {
            path: [[449.91, 282.37], [133.88, 829.75], [908.02, 829.75]],
            band: [[428.96, 246.08], [71.04, 866.03], [928.96, 866.03], [887.07, 793.46], [196.72, 793.46], [470.86, 318.65]],
        },
        {
            path: [[745.00, 619.94], [428.96, 72.57], [41.90, 742.98]],
            band: [[786.89, 619.94], [428.96, 0], [0, 742.98], [83.79, 742.98], [428.96, 145.13], [703.10, 619.94]],
        },
    ];
    const BAND_WIDTH = 72.56;
    // Small triangular ring floating in the middle, as in the logo
    const RING_OUTER = [[0, 167.21], [144.81, -83.6], [-144.81, -83.6]];
    const RING_INNER = [[0, 94.65], [81.97, -47.32], [-81.97, -47.32]];
    const RING_DEPTH = 60 * SVG_UNIT;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const colorScheme = window.matchMedia('(prefers-color-scheme: light)');

    let W = 0, H = 0, dpr = 1, fontSize = 10;
    let cellW = 0, cellH = 0, cols = 0, rows = 0;
    let centerX = 0, centerY = 0, scale = 0, bound = 1;
    let zbuf, levelBuf, waveBuf, haloBuf, fadeRadius = 0;
    let px, py, pz, nx, ny, nz, count = 0;
    let bg = '#000', levelColors = [], waveColors = [], ink = false;
    // Sprite sheet with one pre-rendered tile per (character, color): logo levels,
    // then wave levels. Copying tiles avoids per-frame text rendering, which makes
    // Safari's text caches grow until iOS kills the page.
    const atlas = document.createElement('canvas');
    const atlasCtx = atlas.getContext('2d');
    let tileW = 1, tileH = 1;

    // Orientation: yaw spins about the vertical axis, pitch tips toward the viewer.
    // It turns on its own, and the viewer can drag to orbit it like a CAD viewport.
    const view = { yaw: 0, pitch: 0, vYaw: 0, vPitch: 0, dragging: false, lastInput: -Infinity };
    const AUTO_SPIN = 0.4;        // rad/s at full speed
    const DRAG_SPEED = 0.01;      // rad per pixel dragged
    const RESUME_AFTER = 1200;    // ms after letting go before the auto spin returns

    // Screen basis for the logo view: toward the viewer along (1, 1, 1),
    // rotated in-plane so the triangle sits flat with its apex up
    const VIEW = [1, 1, 1].map((v) => v / Math.sqrt(3));
    const RIGHT = [1, 1, -2].map((v) => v / Math.sqrt(6));
    const UP = [1, -1, 0].map((v) => v / Math.sqrt(2));
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // Beam frame <-> model space (x right, y up, z away from the viewer)
    const toModel = (p) => [dot(p, RIGHT), dot(p, UP), -dot(p, VIEW)];
    const fromModel = ([x, y, z]) => [0, 1, 2].map((i) => x * RIGHT[i] + y * UP[i] - z * VIEW[i]);
    const svgToModel = ([x, y]) => [(x - LOGO_CENTER[0]) * SVG_UNIT, (LOGO_CENTER[1] - y) * SVG_UNIT];
    const modelToSvg = ([x, y]) => [LOGO_CENTER[0] + x / SVG_UNIT, LOGO_CENTER[1] - y / SVG_UNIT];

    // An axis-aligned beam seen down the diagonal is sqrt(2) times its side wide,
    // and its length shows foreshortened by sqrt(2/3)
    const BEAM_SIDE = (BAND_WIDTH / Math.SQRT2) * SVG_UNIT;
    const FORESHORTEN = Math.sqrt(2 / 3);
    // Legs meet in a shared cube at the bend, a clean 90 degree elbow, and run past
    // the free ends far enough to fill their slanted cuts
    const CORNER_EXTEND = BEAM_SIDE / 2;
    const END_EXTEND = (BAND_WIDTH / 2) / Math.sqrt(3) * SVG_UNIT / FORESHORTEN;

    // One box per leg, in the beam frame, tagged with its arm
    const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const BOXES = [];
    ARMS.forEach(({ path }, arm) => {
        const pts = path.map(svgToModel);
        // The bend sits at depth 0; each leg recedes or advances along its axis
        const bend = fromModel([pts[1][0], pts[1][1], 0]);
        [[pts[1], pts[0]], [pts[1], pts[2]]].forEach(([from, to]) => {
            const dx = to[0] - from[0], dy = to[1] - from[1];
            const len = Math.hypot(dx, dy);
            // The axis whose on-screen direction matches this leg
            let axis = AXES[0], best = -Infinity;
            for (const a of AXES) {
                const [ax, ay] = toModel(a);
                const d = (ax * dx + ay * dy) / (Math.hypot(ax, ay) * len);
                if (d > best) { best = d; axis = a; }
            }
            const k = axis.findIndex((v) => v !== 0), sign = axis[k];
            const far = bend.slice();
            far[k] += sign * (len / FORESHORTEN + END_EXTEND);
            const near = bend.slice();
            near[k] -= sign * CORNER_EXTEND;
            const lo = [0, 1, 2].map((i) => (i === k ? Math.min(near[i], far[i]) : bend[i] - BEAM_SIDE / 2));
            const hi = [0, 1, 2].map((i) => (i === k ? Math.max(near[i], far[i]) : bend[i] + BEAM_SIDE / 2));
            BOXES.push({ lo, hi, arm });
        });
    });

    function inArm(p, arm) {
        for (const { lo, hi, arm: a } of BOXES) {
            if (a === arm && p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2]) {
                return true;
            }
        }
        return false;
    }

    // A point on an arm's outer surface: solid just behind it, empty just in front
    const EPS = 1e-5;
    function onSurface(p, n, arm) {
        return inArm([p[0] - n[0] * EPS, p[1] - n[1] * EPS, p[2] - n[2] * EPS], arm) &&
            !inArm([p[0] + n[0] * EPS, p[1] + n[1] * EPS, p[2] + n[2] * EPS], arm);
    }

    // Even-odd point-in-polygon test across one or more polygons
    function inPolygons(polys, x, y) {
        let hit = false;
        for (const poly of polys) {
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const [xi, yi] = poly[i], [xj, yj] = poly[j];
                if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
            }
        }
        return hit;
    }
    const inRing = (x, y) => inPolygons([RING_OUTER, RING_INNER], x, y);

    function buildGeometry(spacing) {
        const pts = [];
        const push = ([x, y, z], [a, b, c]) => pts.push(x, y, z, a, b, c);

        // Arm surfaces, trimmed to the arm's band of the logo so the corners and
        // slanted ends stay sharp from the front
        for (const { lo, hi, arm } of BOXES) {
            for (const n of AXES) {
                const k = n.findIndex((v) => v !== 0);
                const u = (k + 1) % 3, v = (k + 2) % 3;
                const nu = Math.ceil((hi[u] - lo[u]) / spacing);
                const nv = Math.ceil((hi[v] - lo[v]) / spacing);
                const mn = toModel(n);
                for (let i = 0; i <= nu; i++) {
                    for (let j = 0; j <= nv; j++) {
                        const p = [0, 0, 0];
                        p[k] = n[k] > 0 ? hi[k] : lo[k];
                        p[u] = lo[u] + ((hi[u] - lo[u]) * i) / nu;
                        p[v] = lo[v] + ((hi[v] - lo[v]) * j) / nv;
                        if (!onSurface(p, n, arm)) continue;
                        const m = toModel(p);
                        const [sx, sy] = modelToSvg(m);
                        if (inPolygons([ARMS[arm].band], sx, sy)) push(m, mn);
                    }
                }
            }
        }

        // Center ring: a thin triangular frame facing the viewer
        const rd = RING_DEPTH / 2;
        for (let y = -170; y <= 170; y += spacing / SVG_UNIT) {
            for (let x = -150; x <= 150; x += spacing / SVG_UNIT) {
                if (!inRing(x, y)) continue;
                push([x * SVG_UNIT, y * SVG_UNIT, -rd], [0, 0, -1]);
                push([x * SVG_UNIT, y * SVG_UNIT, rd], [0, 0, 1]);
            }
        }
        for (const poly of [RING_OUTER, RING_INNER]) {
            for (let i = 0; i < poly.length; i++) {
                const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
                const len = Math.hypot(bx - ax, by - ay);
                let ox = (by - ay) / len, oy = -(bx - ax) / len;
                if (inRing((ax + bx) / 2 + ox, (ay + by) / 2 + oy)) { ox = -ox; oy = -oy; }
                const steps = Math.ceil((len * SVG_UNIT) / spacing);
                const depthSteps = Math.max(1, Math.ceil(RING_DEPTH / spacing));
                for (let s = 0; s <= steps; s++) {
                    const x = (ax + ((bx - ax) * s) / steps) * SVG_UNIT;
                    const y = (ay + ((by - ay) * s) / steps) * SVG_UNIT;
                    for (let d = 0; d <= depthSteps; d++) push([x, y, -rd + (RING_DEPTH * d) / depthSteps], [ox, oy, 0]);
                }
            }
        }

        count = pts.length / 6;
        px = new Float32Array(count); py = new Float32Array(count); pz = new Float32Array(count);
        nx = new Float32Array(count); ny = new Float32Array(count); nz = new Float32Array(count);
        bound = 0;
        for (let k = 0; k < count; k++) {
            px[k] = pts[k * 6]; py[k] = pts[k * 6 + 1]; pz[k] = pts[k * 6 + 2];
            nx[k] = pts[k * 6 + 3]; ny[k] = pts[k * 6 + 4]; nz[k] = pts[k * 6 + 5];
            bound = Math.max(bound, Math.hypot(px[k], py[k], pz[k]));
        }
    }

    function hexToRgb(hex) {
        const h = hex.trim().replace('#', '');
        const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // n colors stepping from one CSS color token to another
    function colorRamp(style, fromVar, toVar, n) {
        const lo = hexToRgb(style.getPropertyValue(fromVar));
        const hi = hexToRgb(style.getPropertyValue(toVar));
        const out = [];
        for (let i = 0; i < n; i++) {
            const t = Math.pow(i / (n - 1), 0.85);
            const r = Math.round(lo[0] + (hi[0] - lo[0]) * t);
            const g = Math.round(lo[1] + (hi[1] - lo[1]) * t);
            const bl = Math.round(lo[2] + (hi[2] - lo[2]) * t);
            out.push(`rgb(${r},${g},${bl})`);
        }
        return out;
    }

    function readColors() {
        const style = getComputedStyle(document.documentElement);
        bg = style.getPropertyValue('--bg').trim();
        levelColors = colorRamp(style, '--ascii-dim', '--ascii-bright', LEVELS);
        waveColors = colorRamp(style, '--wave-dim', '--wave-bright', WAVE_RAMP.length);
        ink = style.getPropertyValue('--ascii-ink').trim() === '1';
    }

    function resize() {
        W = window.innerWidth;
        H = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);

        fontSize = W < 700 ? 8 : 10;
        ctx.font = `${fontSize}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
        cellW = ctx.measureText('M').width;
        cellH = Math.round(fontSize * 1.2);
        cols = Math.ceil(W / cellW);
        rows = Math.ceil(H / cellH);
        zbuf = new Float32Array(cols * rows);
        levelBuf = new Uint8Array(cols * rows);
        waveBuf = new Uint8Array(cols * rows);
        haloBuf = new Uint8Array(cols * rows);

        // Centered; the radius covers the object side-on, where it is deepest
        const radiusPx = Math.min(W, H) * 0.46;
        centerX = W / 2 / cellW;
        centerY = H / 2 / cellH;
        fadeRadius = radiusPx;

        // Sample once at a rough density to find the extent, then at ~2 samples per cell
        buildGeometry(0.05);
        scale = radiusPx / bound;
        buildGeometry(cellW / scale / 2);
        buildAtlas();
    }

    // Lights the three face directions in distinct light / mid / dark tones
    const light = (() => {
        const l = [-0.6, 0.55, -0.6];
        const n = Math.hypot(...l);
        return l.map((v) => v / n);
    })();

    function render(time) {
        const t = time / 1000;
        const ry = view.yaw, rx = view.pitch;

        // R = Rx * Ry
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const m0 = cy, m1 = 0, m2 = sy;
        const m3 = sx * sy, m4 = cx, m5 = -sx * cy;
        const m6 = -cx * sy, m7 = sx, m8 = cx * cy;

        zbuf.fill(0);
        levelBuf.fill(0);

        // Orthographic projection: the illusion only lines up without perspective
        const fx = scale / cellW, fy = scale / cellH;
        const [lx, ly, lz] = light;
        // Blinn-Phong half vector for a viewer looking down +z
        const hn = Math.hypot(lx, ly, lz - 1);
        const hx = lx / hn, hy = ly / hn, hz = (lz - 1) / hn;

        for (let k = 0; k < count; k++) {
            const ax = nx[k], ay = ny[k], az = nz[k];
            const nrz = m6 * ax + m7 * ay + m8 * az;
            if (nrz > -0.02) continue; // facing away from the camera, or edge-on

            const x = px[k], y = py[k], z = pz[k];
            const col = (centerX + (m0 * x + m1 * y + m2 * z) * fx) | 0;
            const row = (centerY - (m3 * x + m4 * y + m5 * z) * fy) | 0;
            if (col < 0 || col >= cols || row < 0 || row >= rows) continue;

            const idx = row * cols + col;
            const depth = bound * 2 - (m6 * x + m7 * y + m8 * z); // larger is nearer
            if (depth <= zbuf[idx]) continue;
            zbuf[idx] = depth;

            const nrx = m0 * ax + m1 * ay + m2 * az;
            const nry = m3 * ax + m4 * ay + m5 * az;
            const diffuse = Math.max(0, nrx * lx + nry * ly + nrz * lz);
            const spec = Math.pow(Math.max(0, nrx * hx + nry * hy + nrz * hz), 24);

            let lum = Math.min(1, 0.2 + diffuse * 0.6 + spec * 0.25);
            // On a light background, shade like ink: shadowed faces darkest and densest
            if (ink) lum = 1.2 - lum;
            levelBuf[idx] = 1 + Math.min(LEVELS - 1, (lum * LEVELS) | 0);
        }

        // Keep a one-cell clear gap around the logo so it separates from the waves
        haloBuf.fill(0);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!levelBuf[r * cols + c]) continue;
                for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) {
                    for (let cc = Math.max(0, c - 1); cc <= Math.min(cols - 1, c + 1); cc++) haloBuf[rr * cols + cc] = 1;
                }
            }
        }

        // Background waves: drifting interference plus ripples rolling out from the
        // logo, all breathing in and out about every 6 seconds, and faded toward the
        // middle behind the logo
        const breath = 0.5 + 0.55 * (0.5 - 0.5 * Math.cos(t * 1.05));
        const waveLevels = WAVE_RAMP.length;
        const cxPx = centerX * cellW, cyPx = centerY * cellH;
        for (let r = 0; r < rows; r++) {
            const y = r * cellH;
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                if (haloBuf[idx]) { waveBuf[idx] = 0; continue; }
                const x = c * cellW;
                const dist = Math.hypot(x - cxPx, y - cyPx);
                const f = 0.5 * Math.sin(x * 0.012 + t * 0.7) * Math.cos(y * 0.018 - t * 0.5) +
                    0.35 * Math.sin((x * 0.6 + y) * 0.01 - t * 0.9) +
                    0.45 * Math.sin(dist * 0.025 - t * 1.4);
                const near = Math.min(1, Math.max(0, (dist - fadeRadius * 0.5) / (fadeRadius * 0.8)));
                // Stretch so troughs drop out to blank and crests reach the top of the ramp
                const v = Math.min(1, Math.max(0, ((f / 1.3) * 0.5 + 0.5 - 0.3) / 0.6));
                waveBuf[idx] = Math.min(waveLevels, (v * breath * (0.25 + 0.75 * near) * (waveLevels + 1)) | 0);
            }
        }

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawLayer(waveBuf, LEVELS);
        drawLayer(levelBuf, 0);
    }

    function buildAtlas() {
        const glyphs = [...RAMP].map((ch, i) => [ch, levelColors[i]])
            .concat([...WAVE_RAMP].map((ch, i) => [ch, waveColors[i]]));
        tileW = Math.ceil(cellW * dpr);
        tileH = Math.ceil(cellH * dpr);
        atlas.width = tileW * glyphs.length;
        atlas.height = tileH;
        atlasCtx.font = `${fontSize * dpr}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
        atlasCtx.textBaseline = 'top';
        glyphs.forEach(([ch, color], i) => {
            atlasCtx.fillStyle = color;
            atlasCtx.fillText(ch, i * tileW, 0);
        });
    }

    // Copies the tile for each occupied cell (levels 1..n, tiles from firstTile on),
    // in device pixels so tiles land 1:1 and stay crisp
    function drawLayer(buf, firstTile) {
        for (let r = 0; r < rows; r++) {
            const y = Math.round(r * cellH * dpr);
            const base = r * cols;
            for (let c = 0; c < cols; c++) {
                const lvl = buf[base + c];
                if (!lvl) continue;
                ctx.drawImage(atlas, (firstTile + lvl - 1) * tileW, 0, tileW, tileH,
                    Math.round(c * cellW * dpr), y, tileW, tileH);
            }
        }
    }

    const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

    // Advance the orientation by dt seconds: momentum from a drag, then once the
    // viewer lets go for a moment, the turntable spin fades back in
    function updateView(dt, now) {
        if (view.dragging) return;
        view.yaw += view.vYaw * dt;
        view.pitch += view.vPitch * dt;
        const decay = Math.exp(-dt * 4);
        view.vYaw *= decay;
        view.vPitch *= decay;

        const idle = now - view.lastInput - RESUME_AFTER;
        if (idle <= 0) return;
        const blend = Math.min(1, idle / 1000);
        // Eases through the two angles (front and back) where the loose ends line
        // up into the impossible triangle
        view.yaw += AUTO_SPIN * (1 - 0.9 * Math.cos(2 * view.yaw)) * blend * dt;
        // Settle back level so the illusion can line up again
        view.pitch = wrapAngle(view.pitch) * (1 - (1 - Math.exp(-dt * 1.5)) * blend);
    }

    // Phones render at 30 fps to keep CPU and battery use down
    let rafId = 0, lastFrame = -Infinity;
    function loop(time) {
        const interval = W < 700 ? 1000 / 30 - 2 : 0;
        if (time - lastFrame >= interval) {
            updateView(Math.min(0.1, (time - lastFrame) / 1000), time);
            lastFrame = time;
            render(time);
        }
        rafId = requestAnimationFrame(loop);
    }

    function start() {
        cancelAnimationFrame(rafId);
        if (reduceMotion.matches) {
            render(0);
        } else {
            rafId = requestAnimationFrame(loop);
        }
    }

    // Drag (mouse or finger) to orbit
    let dragX = 0, dragY = 0, dragTime = 0;
    canvas.addEventListener('pointerdown', (e) => {
        view.dragging = true;
        view.vYaw = view.vPitch = 0;
        dragX = e.clientX;
        dragY = e.clientY;
        dragTime = performance.now();
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!view.dragging) return;
        const now = performance.now();
        const dYaw = (e.clientX - dragX) * DRAG_SPEED;
        const dPitch = -(e.clientY - dragY) * DRAG_SPEED;
        view.yaw += dYaw;
        view.pitch += dPitch;
        // Smoothed angular velocity, carried as momentum on release
        const dt = Math.max(0.001, (now - dragTime) / 1000);
        view.vYaw = view.vYaw * 0.5 + (dYaw / dt) * 0.5;
        view.vPitch = view.vPitch * 0.5 + (dPitch / dt) * 0.5;
        dragX = e.clientX;
        dragY = e.clientY;
        dragTime = now;
        view.lastInput = now;
        if (reduceMotion.matches) render(0);
    });
    const endDrag = () => {
        if (!view.dragging) return;
        view.dragging = false;
        view.lastInput = performance.now();
        // A pause before letting go means no fling
        if (performance.now() - dragTime > 80 || reduceMotion.matches) view.vYaw = view.vPitch = 0;
        canvas.classList.remove('dragging');
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            // iOS fires resize as the toolbar slides; only rebuild when the size changed
            if (window.innerWidth === W && window.innerHeight === H) return;
            resize();
            if (reduceMotion.matches) render(0);
        }, 100);
    });

    colorScheme.addEventListener('change', () => {
        readColors();
        buildAtlas();
        if (reduceMotion.matches) render(0);
    });
    reduceMotion.addEventListener('change', start);

    // Wait for the web font so character metrics are measured correctly
    const fontsReady = document.fonts ? document.fonts.load('10px "JetBrains Mono"') : Promise.resolve();
    fontsReady.catch(() => {}).finally(() => {
        readColors();
        resize();
        start();
    });
})();
