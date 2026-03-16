/**
 * annotations.js
 * ─────────────────────────────────────────────────────────────
 * 批注的渲染与命中检测。所有坐标均在「底图坐标系」下。
 *
 * 对外接口：
 *   drawAnnotation(ctx, ann)         在 ctx 上绘制一条批注
 *   drawAnnotations(ctx, list)       批量绘制
 *   hitTest(ann, x, y, threshold)   命中检测（返回 bool）
 *   getBoundingBox(ann)              获取批注的包围盒 {x,y,w,h}
 * ─────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════════
//  各类型渲染函数
// ═══════════════════════════════════════════════════════════════

function _drawFreehand(ctx, ann) {
  const pts = ann.points;
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    // 二次贝塞尔平滑：用相邻两点的中点作控制点
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  ctx.stroke();
}

function _drawRect(ctx, ann) {
  const c = ann.corners;
  ctx.beginPath();
  ctx.moveTo(c[0].x, c[0].y);
  ctx.lineTo(c[1].x, c[1].y);
  ctx.lineTo(c[2].x, c[2].y);
  ctx.lineTo(c[3].x, c[3].y);
  ctx.closePath();
  ctx.stroke();
}

function _drawLine(ctx, ann) {
  ctx.beginPath();
  ctx.moveTo(ann.x1, ann.y1);
  ctx.lineTo(ann.x2, ann.y2);
  ctx.stroke();
}

function _drawCircle(ctx, ann) {
  ctx.beginPath();
  ctx.ellipse(ann.cx, ann.cy, ann.rx, ann.ry, 0, 0, 2 * Math.PI);
  ctx.stroke();
}

/**
 * 对号：两段折线 start→valley→end
 * 美化策略：用二次贝塞尔在转折处稍作圆滑，保留用户的角度与比例
 */
function _drawCheck(ctx, ann) {
  const { start, valley, end } = ann;
  // valley 处用小圆角过渡
  const r = 0.18; // 圆角比例（相对于短臂长度）
  const len1 = Math.hypot(valley.x - start.x, valley.y - start.y);
  const len2 = Math.hypot(end.x - valley.x, end.y - valley.y);
  const blend = Math.min(len1, len2) * r;

  // 在 valley 前后各取一个过渡点
  const t1 = blend / (len1 || 1);
  const t2 = blend / (len2 || 1);
  const p1 = {
    x: valley.x - (valley.x - start.x)  * t1,
    y: valley.y - (valley.y - start.y)  * t1
  };
  const p2 = {
    x: valley.x + (end.x - valley.x) * t2,
    y: valley.y + (end.y - valley.y) * t2
  };

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.quadraticCurveTo(valley.x, valley.y, p2.x, p2.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

/**
 * 叉号：两段直线
 * 每段从各自的原始端点绘制，保留用户倾斜角度与大小
 */
function _drawCross(ctx, ann) {
  const { line1, line2 } = ann;
  ctx.beginPath();
  ctx.moveTo(line1.x1, line1.y1);
  ctx.lineTo(line1.x2, line1.y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(line2.x1, line2.y1);
  ctx.lineTo(line2.x2, line2.y2);
  ctx.stroke();
}

/**
 * 文字批注
 * 支持自动换行（根据 ann.width 换行）
 */
function _drawText(ctx, ann) {
  const fontSize   = ann.fontSize   || 18;
  const fontFamily = ann.fontFamily || '"Microsoft YaHei","PingFang SC",sans-serif';
  ctx.font         = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle    = ann.color || '#e53935';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'center';

  const text    = ann.text  || '';
  const maxW    = ann.width || 200;
  const lineH   = fontSize * 1.5;   // line-height: 1.5，与输入框一致
  const centerX = ann.x + maxW / 2; // 文字水平居中锚点

  // 先按 \n 分段，再对每段做字符级自动换行
  const paragraphs = text.split('\n');
  const lines = [];

  for (const para of paragraphs) {
    if (para === '') {
      lines.push('');   // 保留空行（回车产生的空行）
    } else {
      let cur = '';
      for (const ch of para) {
        const test = cur + ch;
        if (ctx.measureText(test).width > maxW && cur.length > 0) {
          lines.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
    }
  }
  if (lines.length === 0) lines.push('');

  // 缓存实际行数，供 getBoundingBox 使用（避免重复测量）
  ann._renderedLines = lines.length;

  // 缓存每段落不换行时的最大宽度，供 canvas.js 自动撑开文字框使用
  let maxParaW = 0;
  for (const para of paragraphs) {
    const w = ctx.measureText(para).width;
    if (w > maxParaW) maxParaW = w;
  }
  ann._idealWidth = maxParaW;

  lines.forEach((line, i) => {
    ctx.fillText(line, centerX, ann.y + i * lineH);
  });
}

// ═══════════════════════════════════════════════════════════════
//  公开渲染接口
// ═══════════════════════════════════════════════════════════════

/**
 * 在给定 ctx 上绘制单条批注
 */
function drawAnnotation(ctx, ann) {
  ctx.save();
  ctx.strokeStyle = ann.color     || '#e53935';
  ctx.lineWidth   = ann.lineWidth || 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  switch (ann.type) {
    case 'freehand': _drawFreehand(ctx, ann); break;
    case 'rect':     _drawRect(ctx, ann);     break;
    case 'line':     _drawLine(ctx, ann);     break;
    case 'circle':   _drawCircle(ctx, ann);   break;
    case 'check':    _drawCheck(ctx, ann);    break;
    case 'cross':    _drawCross(ctx, ann);    break;
    case 'text':     _drawText(ctx, ann);     break;
  }
  ctx.restore();
}

/**
 * 批量绘制所有批注
 */
function drawAnnotations(ctx, list) {
  for (const ann of list) drawAnnotation(ctx, ann);
}

// ═══════════════════════════════════════════════════════════════
//  包围盒
// ═══════════════════════════════════════════════════════════════

/**
 * 返回批注的包围盒 { x, y, w, h }（底图坐标）
 * 用于选中框显示、命中检测等
 */
function getBoundingBox(ann) {
  let minX, maxX, minY, maxY;

  switch (ann.type) {
    case 'freehand': {
      const pts = ann.points;
      minX = Math.min(...pts.map(p => p.x));
      maxX = Math.max(...pts.map(p => p.x));
      minY = Math.min(...pts.map(p => p.y));
      maxY = Math.max(...pts.map(p => p.y));
      break;
    }
    case 'rect': {
      minX = Math.min(...ann.corners.map(p => p.x));
      maxX = Math.max(...ann.corners.map(p => p.x));
      minY = Math.min(...ann.corners.map(p => p.y));
      maxY = Math.max(...ann.corners.map(p => p.y));
      break;
    }
    case 'line':
      minX = Math.min(ann.x1, ann.x2); maxX = Math.max(ann.x1, ann.x2);
      minY = Math.min(ann.y1, ann.y2); maxY = Math.max(ann.y1, ann.y2);
      break;
    case 'circle':
      minX = ann.cx - ann.rx; maxX = ann.cx + ann.rx;
      minY = ann.cy - ann.ry; maxY = ann.cy + ann.ry;
      break;
    case 'check': {
      const xs = [ann.start.x, ann.valley.x, ann.end.x];
      const ys = [ann.start.y, ann.valley.y, ann.end.y];
      minX = Math.min(...xs); maxX = Math.max(...xs);
      minY = Math.min(...ys); maxY = Math.max(...ys);
      break;
    }
    case 'cross': {
      const xs = [ann.line1.x1, ann.line1.x2, ann.line2.x1, ann.line2.x2];
      const ys = [ann.line1.y1, ann.line1.y2, ann.line2.y1, ann.line2.y2];
      minX = Math.min(...xs); maxX = Math.max(...xs);
      minY = Math.min(...ys); maxY = Math.max(...ys);
      break;
    }
    case 'text': {
      // 行数优先用 _drawText 缓存的真实值，默认 1 行（单行起始高度）
      const nLines = ann._renderedLines || 1;
      const lineH  = (ann.fontSize || 18) * 1.5;
      minX = ann.x; maxX = ann.x + (ann.width || 200);
      minY = ann.y; maxY = ann.y + nLines * lineH;
      break;
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }

  // 加一点 padding（线宽的一半）
  const pad = (ann.lineWidth || 2) / 2;
  return {
    x: minX - pad, y: minY - pad,
    w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2
  };
}

// ═══════════════════════════════════════════════════════════════
//  命中检测
// ═══════════════════════════════════════════════════════════════

/** 点到线段的距离（不超出端点） */
function _ptToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 点 (x, y) 是否命中批注 ann
 * @param {number} threshold  命中容差（底图坐标，建议 8～12）
 */
function hitTest(ann, x, y, threshold = 10) {
  const t = threshold;
  switch (ann.type) {
    case 'freehand': {
      // 检查是否靠近任一线段
      const pts = ann.points;
      for (let i = 1; i < pts.length; i++) {
        if (_ptToSegDist(x, y, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y) < t)
          return true;
      }
      return false;
    }
    case 'rect': {
      const c = ann.corners;
      for (let i = 0; i < 4; i++) {
        const a = c[i], b = c[(i + 1) % 4];
        if (_ptToSegDist(x, y, a.x, a.y, b.x, b.y) < t) return true;
      }
      return false;
    }
    case 'line':
      return _ptToSegDist(x, y, ann.x1, ann.y1, ann.x2, ann.y2) < t;

    case 'circle': {
      // 到椭圆边界的距离近似
      const angle = Math.atan2(y - ann.cy, x - ann.cx);
      const ex = ann.cx + ann.rx * Math.cos(angle);
      const ey = ann.cy + ann.ry * Math.sin(angle);
      return Math.hypot(x - ex, y - ey) < t;
    }
    case 'check':
      return (
        _ptToSegDist(x, y, ann.start.x, ann.start.y, ann.valley.x, ann.valley.y) < t ||
        _ptToSegDist(x, y, ann.valley.x, ann.valley.y, ann.end.x, ann.end.y) < t
      );
    case 'cross':
      return (
        _ptToSegDist(x, y, ann.line1.x1, ann.line1.y1, ann.line1.x2, ann.line1.y2) < t ||
        _ptToSegDist(x, y, ann.line2.x1, ann.line2.y1, ann.line2.x2, ann.line2.y2) < t
      );
    case 'text': {
      const bb = getBoundingBox(ann);
      return x >= bb.x && x <= bb.x + bb.w && y >= bb.y && y <= bb.y + bb.h;
    }
    default:
      return false;
  }
}
