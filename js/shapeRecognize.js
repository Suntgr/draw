/**
 * shapeRecognize.js
 * ─────────────────────────────────────────────────────────────
 * 核心形状识别模块（纯函数，无副作用）
 *
 * 对外接口：
 *   recognizeStroke(rawPoints)             → 单笔识别 (circle/line/check/null)
 *   recognizeCrossFromTwo(ann1, ann2)       → 双笔叉号识别 (cross/null)
 *
 * 识别优先级：矩形 > 圆 > 直线 > 对号
 * 叉号由外部在每笔结束后调用 recognizeCrossFromTwo 检测。
 * ─────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════════
//  基础几何工具
// ═══════════════════════════════════════════════════════════════

function ptDist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 点到有向线段（a→b）的垂直距离
 */
function ptToLineDist(p, a, b) {
  const len = ptDist(a, b);
  if (len < 1e-6) return ptDist(p, a);
  // 有符号面积 / 底
  return Math.abs(
    (b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x
  ) / len;
}

/**
 * 点在线段上的投影参数 t（0=a，1=b）
 */
function projT(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/**
 * 折线总长度
 */
function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += ptDist(pts[i - 1], pts[i]);
  return len;
}

/**
 * 点列包围盒
 */
function bbox(pts) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * 两条无限直线的交点（参数式）
 * 返回 { x, y, t1, t2 } 或 null（平行）
 */
function lineSegmentIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-8) return null; // 平行
  const dx = p3.x - p1.x, dy = p3.y - p1.y;
  const t1 = (dx * d2y - dy * d2x) / cross;
  const t2 = (dx * d1y - dy * d1x) / cross;
  if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) return null;
  return {
    x: p1.x + t1 * d1x,
    y: p1.y + t1 * d1y,
    t1, t2
  };
}

/**
 * 均匀降采样到 maxPts 个点（保留首尾）
 */
function downsample(pts, maxPts = 64) {
  if (pts.length <= maxPts) return pts;
  const result = [pts[0]];
  const step = (pts.length - 1) / (maxPts - 1);
  for (let i = 1; i < maxPts - 1; i++) {
    result.push(pts[Math.round(i * step)]);
  }
  result.push(pts[pts.length - 1]);
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  识别器 A：圆 / 椭圆
// ═══════════════════════════════════════════════════════════════
/**
 * 判定逻辑：
 *  1. 笔迹须"闭合"：首尾距离 < 包围盒对角线 × 30%
 *  2. 用包围盒中心作为椭圆中心，rx/ry = 半宽/半高
 *  3. 每个点到对应角度椭圆边界点的距离偏差须足够小（平均相对偏差 < 25%）
 *  4. 笔迹弧长须覆盖椭圆近似周长的 70% 以上（防止识别一段小弧）
 */
function tryCircle(pts) {
  if (pts.length < 8) return null;

  const p0 = pts[0], pn = pts[pts.length - 1];
  const bb = bbox(pts);
  if (bb.w < 20 || bb.h < 20) return null;

  // 1. 闭合检测
  const diagLen = Math.hypot(bb.w, bb.h);
  if (ptDist(p0, pn) > diagLen * 0.30) return null;

  // 2. 椭圆参数
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const rx = bb.w / 2;
  const ry = bb.h / 2;

  // 3. 点到椭圆边界的偏差
  let totalRelDev = 0;
  for (const p of pts) {
    const angle = Math.atan2(p.y - cy, p.x - cx);
    // 椭圆上同角度的点
    const ex = cx + rx * Math.cos(angle);
    const ey = cy + ry * Math.sin(angle);
    const dev = ptDist(p, { x: ex, y: ey });
    // 归一化：除以该点到中心的椭圆半径期望值
    const expectedR = Math.hypot(ex - cx, ey - cy) || 1;
    totalRelDev += dev / expectedR;
  }
  const avgRelDev = totalRelDev / pts.length;
  if (avgRelDev > 0.25) return null;

  // 4. 覆盖度：路径长度 ≥ 椭圆近似周长 × 70%
  // 椭圆周长近似（Ramanujan）: π × [3(a+b) - √((3a+b)(a+3b))]
  const a = rx, b = ry;
  const approxCirc = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const pLen = pathLength(pts);
  if (pLen < approxCirc * 0.70) return null;

  // 5. 无尖角：最大局部方向变化 < 50°（矩形等有棱角的形状在此被拒）
  const WC  = Math.max(2, Math.floor(pts.length / 16));
  const nC  = pts.length;
  const dirC = pts.map((_, i) => {
    const ia = (i - WC + nC) % nC, ib = (i + WC) % nC;
    return Math.atan2(pts[ib].y - pts[ia].y, pts[ib].x - pts[ia].x);
  });
  for (let i = 0; i < nC; i++) {
    let da = dirC[(i + WC) % nC] - dirC[(i - WC + nC) % nC];
    while (da >  Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) > Math.PI * 50 / 180) return null;
  }

  return { type: 'circle', cx, cy, rx, ry };
}

// ═══════════════════════════════════════════════════════════════
//  识别器 B：直线
// ═══════════════════════════════════════════════════════════════
/**
 * 判定逻辑：
 *  1. 首尾直线距离须 ≥ 20px（太短不识别）
 *  2. 所有点到首尾连线的最大垂直偏差 < 直线长度 × 8%
 *  3. 折线实际弧长 < 直线长度 × 1.35（排除蛇形/锯齿）
 */
function tryLine(pts) {
  if (pts.length < 3) return null;

  const p0 = pts[0], pn = pts[pts.length - 1];
  const straightLen = ptDist(p0, pn);
  if (straightLen < 20) return null;

  // 最大垂直偏差
  let maxDev = 0;
  for (const p of pts) {
    const d = ptToLineDist(p, p0, pn);
    if (d > maxDev) maxDev = d;
  }

  // 路径蜿蜒度
  const pLen = pathLength(pts);

  if (maxDev / straightLen < 0.08 && pLen / straightLen < 1.35) {
    return { type: 'line', x1: p0.x, y1: p0.y, x2: pn.x, y2: pn.y };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  识别器 C：对号 ✓
// ═══════════════════════════════════════════════════════════════
/**
 * 对号的几何特征（Canvas 坐标系 Y 向下）：
 *
 *   start（左上方）
 *      \  ← 第一臂：向右下方倾斜（dy > 0）
 *       valley（最低点，笔迹最大 Y）
 *        \__________ ← 第二臂：向右上方（dy < 0, dx > 0），且比第一臂长
 *                  end（右上方）
 *
 * 判定条件：
 *  1. valley（最低点索引）在笔迹前 10%～55% 之间
 *  2. start.y < valley.y（第一臂确实往下走）
 *  3. end.y < valley.y  且 end.x > valley.x（第二臂往上往右）
 *  4. 第二臂长 ≥ 第一臂长 × 0.6
 *  5. valley 偏离 start-end 连线的距离 ≥ (len1+len2) × 12%（排除近似直线）
 *  6. 两臂夹角在 25°～155° 之间（排除近似同向的情况）
 */
function tryCheck(pts) {
  if (pts.length < 6) return null;

  const n = pts.length;
  const p0 = pts[0];
  const pn = pts[n - 1];

  // 1. 找最低点（最大 Y）
  let valleyIdx = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].y > pts[valleyIdx].y) valleyIdx = i;
  }
  const ratio = valleyIdx / n;
  if (ratio < 0.10 || ratio > 0.55) return null;

  const valley = pts[valleyIdx];

  // 2. 第一臂：start → valley，必须向下
  if (valley.y - p0.y < 8) return null;

  // 3. 第二臂：valley → end，必须向上且向右
  if (pn.y >= valley.y - 4) return null; // end 必须明显高于 valley
  if (pn.x <= valley.x)     return null; // end 必须在 valley 右侧

  // 4. 臂长比较：第二臂至少是第一臂的 60%
  const len1 = ptDist(p0, valley);
  const len2 = ptDist(valley, pn);
  if (len1 < 8 || len2 < 12)    return null;
  if (len2 < len1 * 0.60)       return null;

  // 5. valley 偏离 start-end 直线（非直线检测）
  const valleyDev = ptToLineDist(valley, p0, pn);
  if (valleyDev / (len1 + len2) < 0.12) return null;

  // 6. 两臂夹角（在 valley 处）：25°～155°
  //    arm1 方向向量：valley - p0
  //    arm2 方向向量：pn - valley
  const ax1 = valley.x - p0.x, ay1 = valley.y - p0.y;
  const ax2 = pn.x - valley.x, ay2 = pn.y - valley.y;
  const cosAngle = (ax1 * ax2 + ay1 * ay2) /
    (Math.hypot(ax1, ay1) * Math.hypot(ax2, ay2) + 1e-10);
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;
  if (angleDeg < 25 || angleDeg > 155) return null;

  return {
    type: 'check',
    start:  { x: p0.x,     y: p0.y     },
    valley: { x: valley.x, y: valley.y },
    end:    { x: pn.x,     y: pn.y     }
  };
}

// ═══════════════════════════════════════════════════════════════
//  识别器 D：矩形 □
// ═══════════════════════════════════════════════════════════════

/**
 * 将 4 个粗略角点"吸附"为标准矩形
 * cpts: 沿路径顺序的 4 个角点（顺/逆时针均可）
 */
function snapToRect(cpts) {
  const cx = (cpts[0].x + cpts[1].x + cpts[2].x + cpts[3].x) / 4;
  const cy = (cpts[0].y + cpts[1].y + cpts[2].y + cpts[3].y) / 4;

  // 用两组对边的平均方向确定矩形旋转角
  let ang1 = Math.atan2(cpts[1].y - cpts[0].y, cpts[1].x - cpts[0].x);
  let ang2 = Math.atan2(cpts[2].y - cpts[3].y, cpts[2].x - cpts[3].x);
  // 对边方向差 π（反向），归一化到 [-π/2, π/2]
  let d = ang2 - ang1;
  while (d >  Math.PI / 2) d -= Math.PI;
  while (d < -Math.PI / 2) d += Math.PI;
  const ang = ang1 + d / 2;

  const cosA = Math.cos(ang), sinA = Math.sin(ang);

  // 投影到矩形本地坐标系
  const us = cpts.map(p =>  (p.x - cx) * cosA + (p.y - cy) * sinA);
  const vs = cpts.map(p => -(p.x - cx) * sinA + (p.y - cy) * cosA);

  const minU = Math.min(...us), maxU = Math.max(...us);
  const minV = Math.min(...vs), maxV = Math.max(...vs);

  // 重建 4 个完美角点并旋转回世界坐标
  return [
    { u: minU, v: minV },
    { u: maxU, v: minV },
    { u: maxU, v: maxV },
    { u: minU, v: maxV }
  ].map(p => ({
    x: p.u * cosA - p.v * sinA + cx,
    y: p.u * sinA + p.v * cosA + cy
  }));
}

/**
 * 矩形识别
 *
 * 判定条件：
 *  1. 笔迹须闭合（首尾距离 < 包围盒对角线 35%）
 *  2. 包围盒非极扁（短边/长边 > 8%，否则是直线）
 *  3. 存在 4 个间距足够、方向变化量 > 45° 的角点
 *  4. 4 条边各自近似直线（最大横向偏差 < 边长 20%）
 *  5. 4 个角约为直角（55°–125°）
 */
function tryRect(pts) {
  if (pts.length < 10) return null;

  const p0 = pts[0], pn = pts[pts.length - 1];
  const bb = bbox(pts);
  if (bb.w < 20 || bb.h < 20) return null;
  if (Math.min(bb.w, bb.h) / Math.max(bb.w, bb.h) < 0.08) return null;

  // 1. 闭合检测
  const diagLen = Math.hypot(bb.w, bb.h);
  if (ptDist(p0, pn) > diagLen * 0.35) return null;

  // 2. 每点的切线方向（用前后各 WIN 个点的差向量近似）
  const n = pts.length;
  const WIN = Math.max(3, Math.floor(n / 12));

  // 自适应最小角点间距：按最短边占周长的比例估算。
  // 例：宽高 4:1 的矩形，短边占周长 1/10，80 点路径里短边约 8 点 → MIN_SEP ≈ 6
  // 这样宽矩形两个短边角点（间距仅 ~8 点）才不会因 MIN_SEP 太大被漏掉。
  const perimEst = 2 * (bb.w + bb.h);
  // 除以 2 给角点间距留充裕容差（正方形时原公式值≈19/80，太接近理论极限）
  const MIN_SEP = Math.max(3, Math.floor(n * Math.min(bb.w, bb.h) / perimEst / 2));

  // 用环形索引计算切线方向，避免路径首尾的角点被截断漏检
  const dirs = pts.map((_, i) => {
    const a = (i - WIN + n) % n, b = (i + WIN) % n;
    return Math.atan2(pts[b].y - pts[a].y, pts[b].x - pts[a].x);
  });

  // 方向变化量（环形索引）
  const turns = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let da = dirs[(i + WIN) % n] - dirs[(i - WIN + n) % n];
    while (da >  Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    turns[i] = Math.abs(da);
  }

  // 找局部极大值峰（变化量 > π/4 ≈ 45°），全范围含首尾
  const peaks = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    if (turns[i] > Math.PI / 4 &&
        turns[i] > turns[prev] &&
        turns[i] >= turns[next]) {
      peaks.push({ idx: i, val: turns[i] });
    }
  }

  // 按幅度排序，挑出 4 个环形间距 >= MIN_SEP 的峰
  peaks.sort((a, b) => b.val - a.val);
  const cornerIdxs = [];
  for (const p of peaks) {
    if (cornerIdxs.every(ci => {
      const d = Math.abs(ci - p.idx);
      return Math.min(d, n - d) >= MIN_SEP; // 环形距离
    })) {
      cornerIdxs.push(p.idx);
      if (cornerIdxs.length === 4) break;
    }
  }
  if (cornerIdxs.length < 4) return null;
  cornerIdxs.sort((a, b) => a - b);

  const [ci0, ci1, ci2, ci3] = cornerIdxs;

  // 3. 检查 4 条边各自近似直线
  function isSegStraight(seg) {
    if (seg.length < 2) return true;
    const a = seg[0], b = seg[seg.length - 1];
    const len = ptDist(a, b);
    if (len < 8) return true;
    for (const p of seg) {
      if (ptToLineDist(p, a, b) / len > 0.20) return false;
    }
    return true;
  }

  const segments = [
    pts.slice(ci0, ci1 + 1),
    pts.slice(ci1, ci2 + 1),
    pts.slice(ci2, ci3 + 1),
    [...pts.slice(ci3), ...pts.slice(0, ci0 + 1)] // 环绕边（首尾相连）
  ];
  if (!segments.every(isSegStraight)) return null;

  // 4. 检查 4 个角约为直角（55°–125°）
  const cpts = cornerIdxs.map(i => pts[i]);
  for (let i = 0; i < 4; i++) {
    const A = cpts[(i + 3) % 4];
    const B = cpts[i];
    const C = cpts[(i + 1) % 4];
    const ax = A.x - B.x, ay = A.y - B.y;
    const bx = C.x - B.x, by = C.y - B.y;
    const cosAng = (ax * bx + ay * by) /
      (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-10);
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180 / Math.PI;
    if (angleDeg < 55 || angleDeg > 125) return null;
  }

  // 5. 吸附为标准矩形
  return { type: 'rect', corners: snapToRect(cpts) };
}

// ═══════════════════════════════════════════════════════════════
//  识别器 E：叉号 ✗（双笔）
// ═══════════════════════════════════════════════════════════════
/**
 * 从两条批注（上一笔 + 当前笔）识别叉号。
 *
 * 判定逻辑：
 *  1. 两笔都必须"类直线"：各自首尾连线与所有点的最大偏差 < 笔迹长度 × 28%
 *  2. 两笔的首尾线段在参数 0.10～0.90 范围内相交
 *  3. 两笔之间的夹角（锐角）≥ 35°（排除近平行的两笔）
 *
 * ann1 / ann2 接受 type='freehand' 或 type='line' 的批注对象
 */
function recognizeCrossFromTwo(ann1, ann2) {
  // 获取批注的首尾端点及原始点列
  function endpoints(ann) {
    if (ann.type === 'line') {
      return {
        start: { x: ann.x1, y: ann.y1 },
        end:   { x: ann.x2, y: ann.y2 },
        pts:   [{ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }]
      };
    }
    if (ann.type === 'freehand' && ann.points && ann.points.length >= 2) {
      return {
        start: ann.points[0],
        end:   ann.points[ann.points.length - 1],
        pts:   ann.points
      };
    }
    return null;
  }

  const ep1 = endpoints(ann1);
  const ep2 = endpoints(ann2);
  if (!ep1 || !ep2) return null;

  // 1. 两笔都须"类直线"
  function isLinelike(ep) {
    const len = ptDist(ep.start, ep.end);
    if (len < 15) return false;
    for (const p of ep.pts) {
      if (ptToLineDist(p, ep.start, ep.end) / len > 0.28) return false;
    }
    return true;
  }
  if (!isLinelike(ep1) || !isLinelike(ep2)) return null;

  // 2. 线段相交（参数范围 10%～90%）
  const inter = lineSegmentIntersect(ep1.start, ep1.end, ep2.start, ep2.end);
  if (!inter) return null;
  if (inter.t1 < 0.10 || inter.t1 > 0.90) return null;
  if (inter.t2 < 0.10 || inter.t2 > 0.90) return null;

  // 3. 夹角检测
  //    用方向向量的点积求夹角（取锐角）
  const d1x = ep1.end.x - ep1.start.x, d1y = ep1.end.y - ep1.start.y;
  const d2x = ep2.end.x - ep2.start.x, d2y = ep2.end.y - ep2.start.y;
  const len1 = Math.hypot(d1x, d1y), len2 = Math.hypot(d2x, d2y);
  let cosA = (d1x * d2x + d1y * d2y) / (len1 * len2 + 1e-10);
  cosA = Math.max(-1, Math.min(1, cosA));
  let angleDeg = Math.acos(cosA) * 180 / Math.PI;
  // 取锐角
  if (angleDeg > 90) angleDeg = 180 - angleDeg;
  if (angleDeg < 35) return null;

  return {
    type:  'cross',
    // 保留原始端点，导出时也能精确还原
    line1: { x1: ep1.start.x, y1: ep1.start.y, x2: ep1.end.x, y2: ep1.end.y },
    line2: { x1: ep2.start.x, y1: ep2.start.y, x2: ep2.end.x, y2: ep2.end.y }
  };
}

// ═══════════════════════════════════════════════════════════════
//  主入口：单笔识别
// ═══════════════════════════════════════════════════════════════
/**
 * @param  {Array<{x,y}>} rawPoints  原始点列（底图坐标系）
 * @returns {{ type, ...data } | null}   识别结果，null 表示保留 freehand
 */
function recognizeStroke(rawPoints) {
  if (!rawPoints || rawPoints.length < 3) return null;
  const pts = downsample(rawPoints, 80);

  // 优先级：矩形 > 圆 > 直线 > 对号
  return tryRect(pts) || tryCircle(pts) || tryLine(pts) || tryCheck(pts);
}
