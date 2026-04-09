/**
 * perlynx.js
 * ──────────────
 * Standalone Perlynx tile-generation library.
 * No UI, no DOM dependencies beyond an off-screen <canvas>.
 * Works in any modern browser (<script src> or ES module).
 *
 * API
 * ───
 *   generateTiles(tiles, imageKey?, thumbnailKey?)  →  Promise<Array>
 *
 * @param {Array}   tiles          Array of tile objects. Each may contain a
 *                                 `perlynx` property with generation settings.
 *                                 Missing settings fall back to defaults.
 *                                 If `perlynx` is absent entirely the tile is
 *                                 rendered with all defaults.
 * @param {string}  [imageKey='texture']     Property name for the full-res PNG.
 * @param {string}  [thumbnailKey='thumbnail'] Property name for the 48×48 PNG.
 *                                 Pass null to skip that output.
 * @returns {Promise<Array>}  Same array with image properties added to each tile.
 *
 * Examples
 * ────────
 *   // Minimal — render everything with defaults
 *   const tiles = await generateTiles(myTiles);
 *
 *   // From a Perlynx export JSON
 *   const res  = await fetch('perlynx-export.json');
 *   const data = await res.json();
 *   const tiles = await generateTiles(data.tiles);
 *
 *   // Custom key names
 *   const tiles = await generateTiles(myTiles, 'diffuse', 'icon');
 *
 *   // Full image only, no thumbnail
 *   const tiles = await generateTiles(myTiles, 'texture', null);
 */

// ─── Noise ────────────────────────────────────────────────────────────────────
// NOTE: SimpleNoise, generateCustomOutline, drawMineralOutline, getMineralFacets,
// and generateMineralPositions are mirrored in index.html. Keep logic in sync.

class SimpleNoise {
    constructor(seed) {
        this.p = new Uint8Array(512);
        const v = new Uint8Array(256);
        for (let i = 0; i < 256; i++) v[i] = i;
        let m = seed;
        for (let i = 255; i > 0; i--) {
            m = (m * 1103515245 + 12345) & 0x7fffffff;
            const j = m % (i + 1);
            [v[i], v[j]] = [v[j], v[i]];
        }
        for (let i = 0; i < 512; i++) this.p[i] = v[i & 255];
    }
    fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    lerp(t, a, b) { return a + t * (b - a); }
    grad(hash, x, y) {
        const h = hash & 15;
        const gx = 1 + (h & 7), gy = 1 + (h >> 3);
        return ((h & 8) ? -gx : gx) * x + ((h & 4) ? -gy : gy) * y;
    }
    get(x, y) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x); y -= Math.floor(y);
        const u = this.fade(x), v = this.fade(y), p = this.p;
        const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
        const ba = p[p[X+1] + Y], bb = p[p[X+1] + Y + 1];
        return this.lerp(v,
            this.lerp(u, this.grad(aa, x, y),   this.grad(ba, x-1, y)),
            this.lerp(u, this.grad(ab, x, y-1), this.grad(bb, x-1, y-1))
        );
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
    const m = hex.match(/[0-9a-f]{2}/gi);
    return m ? m.slice(0, 3).map(x => parseInt(x, 16)) : [0, 0, 0];
}

function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

// ─── Overlay shape helpers ────────────────────────────────────────────────────

function generateCustomOutline(half, edges01, rngFn) {
    const numPts = Math.round(8 + edges01 * 16);
    const radiusVar = 0.1 + edges01 * 0.4;
    const ctrl = [];
    for (let i = 0; i < numPts; i++) {
        const a = (i / numPts) * Math.PI * 2;
        const r = half * (1 - radiusVar + rngFn() * radiusVar * 2);
        ctrl.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    const subdivs = Math.max(1, Math.round(10 * (1 - edges01)));
    if (subdivs <= 1) return ctrl;
    const result = [];
    for (let i = 0; i < numPts; i++) {
        const p0 = ctrl[(i - 1 + numPts) % numPts], p1 = ctrl[i];
        const p2 = ctrl[(i + 1) % numPts],           p3 = ctrl[(i + 2) % numPts];
        for (let j = 0; j < subdivs; j++) {
            const t = j / subdivs, t2 = t*t, t3 = t2*t;
            result.push({
                x: 0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
                y: 0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
            });
        }
    }
    return result;
}

function drawMineralOutline(ctx, type, half, outlinePoints) {
    ctx.beginPath();
    if (outlinePoints && outlinePoints.length > 0) {
        ctx.moveTo(outlinePoints[0].x, outlinePoints[0].y);
        for (let k = 1; k < outlinePoints.length; k++) ctx.lineTo(outlinePoints[k].x, outlinePoints[k].y);
    } else if (type === 'diamond') {
        ctx.moveTo(0,-half); ctx.lineTo(half,0); ctx.lineTo(0,half); ctx.lineTo(-half,0);
    } else if (type === 'square') {
        ctx.rect(-half,-half,half*2,half*2);
    } else if (type === 'circle') {
        ctx.arc(0,0,half,0,Math.PI*2);
    } else if (type === 'star') {
        for (let j = 0; j < 10; j++) {
            const r = j%2===0 ? half : half*0.4, a = j*Math.PI/5 - Math.PI/2;
            j===0 ? ctx.moveTo(r*Math.cos(a),r*Math.sin(a)) : ctx.lineTo(r*Math.cos(a),r*Math.sin(a));
        }
    }
    ctx.closePath();
}

function getMineralFacets(type, half, numFacets, rng, depth) {
    const facets = [];
    if (type === 'diamond') {
        const outerPts = [[0,-half],[half,0],[0,half],[-half,0]];
        const innerOff = half * 0.1 * depth;
        for (let f = 0; f < 4; f++) {
            const a = outerPts[f], b = outerPts[(f+1)%4];
            const subCount = Math.max(1, Math.floor(numFacets/4));
            for (let s = 0; s < subCount; s++) {
                const t0=s/subCount, t1=(s+1)/subCount;
                const p0=[a[0]+(b[0]-a[0])*t0, a[1]+(b[1]-a[1])*t0];
                const p1=[a[0]+(b[0]-a[0])*t1, a[1]+(b[1]-a[1])*t1];
                const jitter=(rng()-0.5)*innerOff, ctr=[jitter,jitter];
                const dx=(p0[0]+p1[0])/2, dy=(p0[1]+p1[1])/2;
                const nx=dy*0.01, ny=-dx*0.01, nz=1, nl=Math.sqrt(nx*nx+ny*ny+nz*nz);
                facets.push({pts:[ctr,p0,p1],cx:dx,cy:dy,nx:nx/nl,ny:ny/nl,nz:nz/nl});
            }
        }
    } else if (type === 'square') {
        const inset = half*(0.3+depth*0.2);
        facets.push({pts:[[-inset,-inset],[inset,-inset],[inset,inset],[-inset,inset]],cx:0,cy:0,nx:0,ny:0,nz:1});
        const outer=[[-half,-half],[half,-half],[half,half],[-half,half]];
        const inner=[[-inset,-inset],[inset,-inset],[inset,inset],[-inset,inset]];
        const sideNormals=[[0,-1,0.5],[1,0,0.5],[0,1,0.5],[-1,0,0.5]];
        for (let f=0;f<4;f++) {
            const a=outer[f],b=outer[(f+1)%4],c=inner[(f+1)%4],d=inner[f],sn=sideNormals[f];
            const nl=Math.sqrt(sn[0]*sn[0]+sn[1]*sn[1]+sn[2]*sn[2]);
            facets.push({pts:[a,b,c,d],cx:(a[0]+c[0])/2,cy:(a[1]+c[1])/2,nx:sn[0]/nl,ny:sn[1]/nl,nz:sn[2]/nl});
        }
    } else if (type === 'circle') {
        const rings=Math.max(2,Math.floor(numFacets/2)), segs=Math.max(6,numFacets);
        for (let ring=0;ring<rings;ring++) {
            const r0=half*ring/rings, r1=half*(ring+1)/rings;
            const elevInner=Math.sqrt(1-(r0/half)*(r0/half)), elevOuter=Math.sqrt(1-(r1/half)*(r1/half));
            for (let s=0;s<segs;s++) {
                const a0=s/segs*Math.PI*2, a1=(s+1)/segs*Math.PI*2;
                const pts=[[Math.cos(a0)*r0,Math.sin(a0)*r0],[Math.cos(a0)*r1,Math.sin(a0)*r1],[Math.cos(a1)*r1,Math.sin(a1)*r1],[Math.cos(a1)*r0,Math.sin(a1)*r0]];
                const mA=(a0+a1)/2, mR=(r0+r1)/2;
                const nx=Math.cos(mA)*mR/half, ny=Math.sin(mA)*mR/half, nz=(elevInner+elevOuter)/2;
                const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
                facets.push({pts,cx:Math.cos(mA)*mR,cy:Math.sin(mA)*mR,nx:nx/nl,ny:ny/nl,nz:nz/nl});
            }
        }
    } else if (type === 'star') {
        const pts10=[];
        for (let j=0;j<10;j++){const r=j%2===0?half:half*0.4,a=j*Math.PI/5-Math.PI/2;pts10.push([r*Math.cos(a),r*Math.sin(a)]);}
        for (let j=0;j<10;j++){
            const a=pts10[j],b=pts10[(j+1)%10],mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;
            const nz=1+depth*0.5,nl=Math.sqrt(mx*mx*0.0001+my*my*0.0001+nz*nz);
            facets.push({pts:[[0,0],a,b],cx:mx/2,cy:my/2,nx:mx*0.01/nl,ny:my*0.01/nl,nz:nz/nl});
        }
    }
    return facets;
}

function generateMineralPositions(p, resX, resY) {
    // p = parsed inputs object
    // Returns mineralsArray from saved state if provided, else generates fresh ones
    if (p.mineralsArray && p.mineralsArray.length > 0) return p.mineralsArray.map(m => Object.assign({}, m));
    const shapeCount = parseInt(p.inputs.shapeCount) || 5;
    const shapeArea = (parseInt(p.inputs.shapeArea) || 70) / 100;
    const shapeSize = parseInt(p.inputs.shapeSize) || 30;
    const shapeSeed = 9999 + (p.mineralScatterSeed || 0);
    let rng = shapeSeed;
    const nextRand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const result = [];
    const maxTries = 50;
    for (let i = 0; i < shapeCount; i++) {
        let placed = false, tries = 0, mineral = null;
        while (!placed && tries < maxTries) {
            const rx=nextRand(), ry=nextRand();
            const sizeMult=0.3+nextRand()*1.7, hueShift=(nextRand()-0.5)*30, rotJitter=(nextRand()-0.5)*0.3;
            const cx=resX/2+(rx-0.5)*resX*shapeArea, cy=resY/2+(ry-0.5)*resY*shapeArea;
            let overlap=false;
            for (const m of result) {
                const minDist=(shapeSize*sizeMult+shapeSize*m.sizeMult)*0.52;
                if (Math.hypot(m.cx-cx,m.cy-cy)<minDist){overlap=true;break;}
            }
            if (!overlap){mineral={cx,cy,sizeMult,hueShift,rotJitter,facetSeed:rng};placed=true;}
            tries++;
        }
        if (!mineral) {
            const sizeMult=0.3+nextRand()*1.7;
            mineral={cx:resX/2+(nextRand()-0.5)*resX*shapeArea,cy:resY/2+(nextRand()-0.5)*resY*shapeArea,
                sizeMult,hueShift:(nextRand()-0.5)*30,rotJitter:(nextRand()-0.5)*0.3,facetSeed:rng};
        }
        result.push(mineral);
    }
    return result;
}

// ─── Core renderer ────────────────────────────────────────────────────────────

/**
 * renderTile(params) → Promise<{ canvas, thumbnailDataURL }>
 * params shape mirrors the `perlynx` object in exported JSON.
 */
async function renderTile(params) {
    const def = getDefaults();
    const inp = Object.assign({}, def.inputs, params.inputs || {});
    const colors   = (params.colors   && params.colors.length   >= 2) ? params.colors   : def.colors;
    const cmColors = (params.cmColors && params.cmColors.length >= 2) ? params.cmColors : def.cmColors;

    const resX       = parseInt(inp.resX)       || 256;
    const resY       = parseInt(inp.resY)       || 256;
    const scaleInput = parseFloat(inp.scale)    || 40;
    const octaves    = parseInt(inp.octaves)    || 6;
    const persist    = parseFloat(inp.persistence) || 0.8;
    const power      = parseFloat(inp.power)    || 1;
    const seed       = parseInt(inp.seed)       || 12345;
    const invert     = !!inp.invert;
    const blurAmt    = parseFloat(inp.blur)     || 0;
    const pixelation = Math.max(1, parseInt(inp.pixelation) || 1);

    // Main canvas
    const canvas = makeCanvas(resX, resY);
    const ctx = canvas.getContext('2d');

    // ── Perlin base ──────────────────────────────────────────────────────────
    const noise = new SimpleNoise(seed);
    const rgbColors = colors.map(hexToRgb);
    const imgData = ctx.createImageData(resX, resY);
    for (let y = 0; y < resY; y++) {
        for (let x = 0; x < resX; x++) {
            let nv = 0, amp = 1, freq = 1/scaleInput, maxAmp = 0;
            for (let o = 0; o < octaves; o++) {
                nv += noise.get(x*freq, y*freq) * amp;
                maxAmp += amp; freq *= 2; amp *= persist;
            }
            let t = Math.max(0, Math.min(1, (nv/maxAmp)*0.5+0.5));
            t = Math.pow(t, power);
            if (invert) t = 1 - t;
            const numSeg = rgbColors.length - 1;
            const seg = Math.min(Math.floor(t*numSeg), numSeg-1);
            const lt = t*numSeg - seg;
            const idx = (x + y*resX)*4;
            imgData.data[idx]   = (1-lt)*rgbColors[seg][0] + lt*rgbColors[seg+1][0];
            imgData.data[idx+1] = (1-lt)*rgbColors[seg][1] + lt*rgbColors[seg+1][1];
            imgData.data[idx+2] = (1-lt)*rgbColors[seg][2] + lt*rgbColors[seg+1][2];
            imgData.data[idx+3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // ── Blur ─────────────────────────────────────────────────────────────────
    if (blurAmt > 0) {
        const pad = Math.ceil(blurAmt * 3);
        const padW = resX + pad*2, padH = resY + pad*2;
        const srcC = makeCanvas(padW, padH);
        const srcCtx = srcC.getContext('2d');
        srcCtx.drawImage(canvas, pad, pad);
        srcCtx.drawImage(canvas, 0, 0, resX, 1, pad, 0, resX, pad);
        srcCtx.drawImage(canvas, 0, resY-1, resX, 1, pad, pad+resY, resX, pad);
        srcCtx.drawImage(canvas, 0, 0, 1, resY, 0, pad, pad, resY);
        srcCtx.drawImage(canvas, resX-1, 0, 1, resY, pad+resX, pad, pad, resY);
        srcCtx.drawImage(canvas, 0, 0, 1, 1, 0, 0, pad, pad);
        srcCtx.drawImage(canvas, resX-1, 0, 1, 1, pad+resX, 0, pad, pad);
        srcCtx.drawImage(canvas, 0, resY-1, 1, 1, 0, pad+resY, pad, pad);
        srcCtx.drawImage(canvas, resX-1, resY-1, 1, 1, pad+resX, pad+resY, pad, pad);
        const dstC = makeCanvas(padW, padH);
        const dstCtx = dstC.getContext('2d');
        dstCtx.filter = `blur(${blurAmt}px)`;
        dstCtx.drawImage(srcC, 0, 0);
        dstCtx.filter = 'none';
        ctx.clearRect(0, 0, resX, resY);
        ctx.drawImage(dstC, pad, pad, resX, resY, 0, 0, resX, resY);
    }

    // ── Pixelation ───────────────────────────────────────────────────────────
    if (pixelation > 1) {
        const smallW = Math.max(1, Math.floor(resX/pixelation));
        const smallH = Math.max(1, Math.floor(resY/pixelation));
        const small = makeCanvas(smallW, smallH);
        small.getContext('2d').drawImage(canvas, 0, 0, smallW, smallH);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, resX, resY);
        ctx.imageSmoothingEnabled = true;
    }

    // ── Overlays ─────────────────────────────────────────────────────────────
    const shapesEnabled = inp.shapesEnabled === true || inp.shapesEnabled === 'true';
    if (shapesEnabled) {
        const shapeType    = inp.shapeType    || 'diamond';
        const shapeSize    = parseInt(inp.shapeSize)    || 30;
        const shapeOpacity = (parseInt(inp.shapeOpacity) || 80) / 100;
        const shapeRot     = (parseInt(inp.shapeRotation) || 0) * Math.PI / 180;
        const shapeFacets  = parseInt(inp.shapeFacets)  || 6;
        const shapeDepth   = (parseInt(inp.shapeDepth)  || 50) / 100;
        const pixelateMins = inp.pixelateMinerals === true || inp.pixelateMinerals === 'true';
        const customEdges  = shapeType === 'custom' ? (parseInt(inp.customEdges) || 50) / 100 : 0;

        const cmPerlinEnabled = inp.cmPerlinEnabled === true || inp.cmPerlinEnabled === 'true';
        const rgbCmColors = cmColors.map(hexToRgb);

        let cmNoise = null, cmScale, cmOctaves, cmPersist, cmPower, cmBlur=0, cmPix=1;
        if (cmPerlinEnabled) {
            cmScale   = parseFloat(inp.cm_scale)       || 20;
            cmOctaves = parseInt(inp.cm_octaves)       || 4;
            cmPersist = parseFloat(inp.cm_persistence) || 0.5;
            cmPower   = parseFloat(inp.cm_power)       || 1;
            cmBlur    = parseFloat(inp.cm_blur)        || 0;
            cmPix     = Math.max(1, parseInt(inp.cm_pixelation) || 1);
            cmNoise   = new SimpleNoise(parseInt(inp.cm_seed) || 42);
        }

        const shouldPix = pixelateMins && pixelation > 1;
        let drawCtx = ctx, offCanvas = null;
        if (shouldPix) {
            offCanvas = makeCanvas(resX, resY);
            drawCtx = offCanvas.getContext('2d');
        }

        const minerals = generateMineralPositions({ inputs: inp, mineralsArray: params.mineralsArray, mineralScatterSeed: params.mineralScatterSeed }, resX, resY);
        const cmTexCanvas = makeCanvas(1, 1);
        const lightX=-0.5, lightY=-0.7, lightZ=0.5;
        const lightLen=Math.sqrt(lightX*lightX+lightY*lightY+lightZ*lightZ);
        const lx=lightX/lightLen, ly=lightY/lightLen, lz=lightZ/lightLen;

        for (let i = 0; i < minerals.length; i++) {
            const m = minerals[i];
            const half = shapeSize * m.sizeMult / 2;

            let customOutline = null;
            if (shapeType === 'custom') {
                let fr = m.facetSeed;
                const nr = () => { fr=(fr*1103515245+12345)&0x7fffffff; return fr/0x7fffffff; };
                customOutline = generateCustomOutline(half, customEdges, nr);
                m._customOutline = customOutline;
            }

            let maxExt = half;
            if (customOutline) { maxExt=0; for (const p of customOutline) maxExt=Math.max(maxExt,Math.abs(p.x),Math.abs(p.y)); }
            const texSize = Math.ceil(maxExt*2)+4;
            if (cmTexCanvas.width < texSize || cmTexCanvas.height < texSize) {
                cmTexCanvas.width = Math.max(cmTexCanvas.width, texSize);
                cmTexCanvas.height = Math.max(cmTexCanvas.height, texSize);
            }
            const texCtx = cmTexCanvas.getContext('2d');
            texCtx.clearRect(0, 0, texSize, texSize);
            const tcx=texSize/2, tcy=texSize/2;

            if (cmPerlinEnabled && cmNoise) {
                const texImg = texCtx.createImageData(texSize, texSize);
                const numSeg = rgbCmColors.length-1;
                for (let py=0;py<texSize;py++) for (let px=0;px<texSize;px++) {
                    const lx2=px-tcx, ly2=py-tcy;
                    const dist=Math.sqrt(lx2*lx2+ly2*ly2)/maxExt;
                    const wx=m.cx+lx2, wy=m.cy+ly2;
                    let nv=0,amp2=1,freq=1/cmScale,maxA=0;
                    for (let o=0;o<cmOctaves;o++){nv+=cmNoise.get(wx*freq,wy*freq)*amp2;maxA+=amp2;freq*=2;amp2*=cmPersist;}
                    let t=Math.max(0,Math.min(1,(nv/maxA)*0.5+0.5));
                    t=Math.pow(t,cmPower);
                    const seg=Math.min(Math.floor(t*numSeg),numSeg-1), lt=(t*numSeg)-seg;
                    let cr=(1-lt)*rgbCmColors[seg][0]+lt*rgbCmColors[seg+1][0];
                    let cg=(1-lt)*rgbCmColors[seg][1]+lt*rgbCmColors[seg+1][1];
                    let cb=(1-lt)*rgbCmColors[seg][2]+lt*rgbCmColors[seg+1][2];
                    const light=Math.max(0.3,1-dist*0.4);
                    cr*=light;cg*=light;cb*=light;
                    const idx2=(px+py*texSize)*4;
                    texImg.data[idx2]=cr;texImg.data[idx2+1]=cg;texImg.data[idx2+2]=cb;texImg.data[idx2+3]=255;
                }
                texCtx.putImageData(texImg, 0, 0);
                if (cmPix > 1) {
                    const sw=Math.max(1,Math.floor(texSize/cmPix));
                    const ps=makeCanvas(sw,sw);
                    ps.getContext('2d').drawImage(cmTexCanvas,0,0,texSize,texSize,0,0,sw,sw);
                    texCtx.clearRect(0,0,texSize,texSize);
                    texCtx.imageSmoothingEnabled=false;
                    texCtx.drawImage(ps,0,0,texSize,texSize);
                    texCtx.imageSmoothingEnabled=true;
                }
            } else {
                const grad=texCtx.createLinearGradient(0,0,texSize,texSize);
                for (let c=0;c<rgbCmColors.length;c++) {
                    const stop=rgbCmColors.length>1?c/(rgbCmColors.length-1):0;
                    grad.addColorStop(stop,`rgb(${rgbCmColors[c][0]},${rgbCmColors[c][1]},${rgbCmColors[c][2]})`);
                }
                texCtx.fillStyle=grad;
                texCtx.fillRect(0,0,texSize,texSize);
            }

            texCtx.globalCompositeOperation='destination-in';
            if (customOutline) {
                texCtx.beginPath();
                texCtx.moveTo(tcx+customOutline[0].x,tcy+customOutline[0].y);
                for (let j=1;j<customOutline.length;j++) texCtx.lineTo(tcx+customOutline[j].x,tcy+customOutline[j].y);
                texCtx.closePath();
            } else {
                texCtx.save(); texCtx.translate(tcx,tcy);
                drawMineralOutline(texCtx,shapeType,half);
                texCtx.restore();
            }
            texCtx.fill();
            texCtx.globalCompositeOperation='source-over';

            drawCtx.save();
            drawCtx.translate(m.cx,m.cy);
            drawCtx.rotate(shapeRot+m.rotJitter);
            const shadowOff=half*0.1;
            drawCtx.save();
            drawCtx.translate(shadowOff,shadowOff*1.5);
            drawCtx.globalAlpha=shapeOpacity*0.25;
            drawCtx.fillStyle='black';
            drawCtx.filter=`blur(${Math.max(1,half*0.12)}px)`;
            if (customOutline){
                drawCtx.beginPath();
                drawCtx.moveTo(customOutline[0].x,customOutline[0].y);
                for (let j=1;j<customOutline.length;j++) drawCtx.lineTo(customOutline[j].x,customOutline[j].y);
                drawCtx.closePath();
            } else { drawMineralOutline(drawCtx,shapeType,half); }
            drawCtx.fill();
            drawCtx.restore();
            drawCtx.filter='none';

            drawCtx.globalAlpha=shapeOpacity;
            if (cmBlur>0) drawCtx.filter=`blur(${cmBlur}px)`;
            drawCtx.drawImage(cmTexCanvas,0,0,texSize,texSize,-tcx,-tcy,texSize,texSize);
            drawCtx.filter='none';

            if (!customOutline) {
                let fr=m.facetSeed;
                const nrf=()=>{fr=(fr*1103515245+12345)&0x7fffffff;return fr/0x7fffffff;};
                const facets=getMineralFacets(shapeType,half,shapeFacets,nrf,shapeDepth);
                const tColor=minerals.length>1?i/(minerals.length-1):0;
                const numSeg=rgbCmColors.length-1;
                const cSeg=Math.min(Math.floor(tColor*numSeg),numSeg-1), cLt=(tColor*numSeg)-cSeg;
                const sR=(1-cLt)*rgbCmColors[cSeg][0]+cLt*rgbCmColors[cSeg+1][0];
                const sG=(1-cLt)*rgbCmColors[cSeg][1]+cLt*rgbCmColors[cSeg+1][1];
                const sB=(1-cLt)*rgbCmColors[cSeg][2]+cLt*rgbCmColors[cSeg+1][2];

                for (const facet of facets) {
                    const dot=Math.max(0,facet.nx*lx+facet.ny*ly+facet.nz*lz);
                    const ambient=0.25, diffuse=dot*0.55;
                    const hx=lx,hy=ly,hz=lz+1,hLen=Math.sqrt(hx*hx+hy*hy+hz*hz);
                    const specDot=Math.max(0,(facet.nx*hx+facet.ny*hy+facet.nz*hz)/hLen);
                    const specular=Math.pow(specDot,12)*0.7*shapeDepth;
                    const brightness=Math.min(1,ambient+diffuse);
                    const noiseVal=noise.get((m.cx+facet.cx)*0.05,(m.cy+facet.cy)*0.05);
                    const texMod=1+noiseVal*0.15*shapeDepth;
                    const fr2=Math.max(0,Math.min(255,(sR+m.hueShift)*brightness*texMod+specular*255));
                    const fg2=Math.max(0,Math.min(255,sG*brightness*texMod+specular*255));
                    const fb2=Math.max(0,Math.min(255,(sB-m.hueShift*0.5)*brightness*texMod+specular*255));
                    drawCtx.globalAlpha=shapeOpacity;
                    drawCtx.beginPath();
                    drawCtx.moveTo(facet.pts[0][0],facet.pts[0][1]);
                    for (let pp=1;pp<facet.pts.length;pp++) drawCtx.lineTo(facet.pts[pp][0],facet.pts[pp][1]);
                    drawCtx.closePath();
                    drawCtx.fillStyle=`rgb(${Math.round(fr2)},${Math.round(fg2)},${Math.round(fb2)})`;
                    drawCtx.fill();
                    drawCtx.strokeStyle=`rgba(0,0,0,${0.2*shapeDepth})`;
                    drawCtx.lineWidth=0.5;
                    drawCtx.stroke();
                }
                if (shapeDepth>0.1) {
                    const highlightR=half*0.3;
                    const grad2=drawCtx.createRadialGradient(-half*0.2,-half*0.3,0,-half*0.2,-half*0.3,highlightR);
                    grad2.addColorStop(0,`rgba(255,255,255,${0.5*shapeDepth*shapeOpacity})`);
                    grad2.addColorStop(1,'rgba(255,255,255,0)');
                    drawCtx.globalAlpha=1;
                    drawCtx.fillStyle=grad2;
                    drawCtx.beginPath();
                    drawCtx.arc(-half*0.2,-half*0.3,highlightR,0,Math.PI*2);
                    drawCtx.fill();
                }
            }
            drawCtx.restore();
        }
        drawCtx.globalAlpha=1;

        if (shouldPix && offCanvas) {
            const smallW=Math.max(1,Math.floor(resX/pixelation));
            const smallH=Math.max(1,Math.floor(resY/pixelation));
            const smallC=makeCanvas(smallW,smallH);
            smallC.getContext('2d').drawImage(offCanvas,0,0,smallW,smallH);
            ctx.imageSmoothingEnabled=false;
            ctx.drawImage(smallC,0,0,resX,resY);
            ctx.imageSmoothingEnabled=true;
        }
    }

    // ── SVG mask ─────────────────────────────────────────────────────────────
    const maskDataURLs = params.maskDataURLs || {};
    const maskName = inp.maskSelect || '';
    const maskURL = maskDataURLs[maskName];
    if (maskURL) {
        await new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(img, 0, 0, resX, resY);
                ctx.restore();
                resolve();
            };
            img.onerror = resolve;
            img.src = maskURL;
        });
    }

    // ── Thumbnail ─────────────────────────────────────────────────────────────
    const THUMB = 48;
    const thumb = makeCanvas(THUMB, THUMB);
    const tctx = thumb.getContext('2d');
    const srcSide = Math.min(resX, resY);
    const sx = Math.floor((resX - srcSide) / 2), sy = Math.floor((resY - srcSide) / 2);
    tctx.drawImage(canvas, sx, sy, srcSide, srcSide, 0, 0, THUMB, THUMB);

    return { canvas, thumbnailDataURL: thumb.toDataURL() };
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

function getDefaults() {
    return {
        inputs: {
            resX: '256', resY: '256',
            scale: '40', octaves: '6', persistence: '0.8', power: '1',
            blur: '0', pixelation: '1', seed: '12345', invert: false,
            shapesEnabled: false, pixelateMinerals: true,
            shapeType: 'diamond', shapeCount: '5', shapeSize: '30',
            shapeFacets: '6', customEdges: '50', shapeDepth: '50',
            shapeOpacity: '80', shapeRotation: '0', shapeArea: '70',
            cmPerlinEnabled: false,
            cm_scale: '20', cm_octaves: '4', cm_persistence: '0.5',
            cm_power: '1', cm_blur: '0', cm_pixelation: '1', cm_seed: '42'
        },
        colors:   ['#582b13', '#63321d'],
        cmColors: ['#888888', '#aaaaaa', '#cccccc', '#eeeeee'],
        mineralsArray: [],
        mineralScatterSeed: 0,
        maskDataURLs: {}
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function generateTiles(tiles, imageKey = 'texture', thumbnailKey = 'thumbnail') {
    if (!Array.isArray(tiles)) throw new Error('generateTiles: first argument must be an array');
    const def = getDefaults();
    const result = tiles.map(t => Object.assign({}, t));
    for (const tile of result) {
        const px = tile.perlynx || {};
        const params = {
            inputs:            Object.assign({}, def.inputs,  px.inputs  || {}),
            colors:            (px.colors   && px.colors.length   >= 2) ? px.colors   : def.colors,
            cmColors:          (px.cmColors && px.cmColors.length >= 2) ? px.cmColors : def.cmColors,
            mineralsArray:     px.mineralsArray     || [],
            mineralScatterSeed: px.mineralScatterSeed || 0,
            maskDataURLs:      px.maskDataURLs      || {}
        };
        try {
            const { canvas, thumbnailDataURL } = await renderTile(params);
            if (imageKey)     tile[imageKey]     = canvas.toDataURL();
            if (thumbnailKey) tile[thumbnailKey] = thumbnailDataURL;
        } catch (err) {
            console.error('generateTiles: failed to render tile', err);
        }
    }
    return result;
}
