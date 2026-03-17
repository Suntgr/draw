/**
 * canvas.js
 * ─────────────────────────────────────────────────────────────
 * Canvas 管理：双层 Canvas、viewport、鼠标交互
 *   - 绘制 / 停顿识别 / 美化
 *   - 选中 → 包围框内任意位置可拖动
 *   - 四角控制点可拖动缩放
 *   - 文字输入框
 * ─────────────────────────────────────────────────────────────
 */

const CanvasManager = (() => {

  // ── DOM ─────────────────────────────────────────────────────
  let staticCanvas, staticCtx, dynamicCanvas, dynamicCtx;
  let canvasArea, floatTextInput;

  // ── viewport ────────────────────────────────────────────────
  const vp = { scale: 1, tx: 0, ty: 0 };

  // ── 绘制状态 ─────────────────────────────────────────────────
  let isDrawing   = false;
  let isPanning   = false;
  let panStartX   = 0, panStartY = 0;
  let panStartTx  = 0, panStartTy = 0;

  let currentPoints     = [];
  let pauseTimer        = null;
  let beautifiedPreview = null;

  const PAUSE_DELAY    = 500;
  const MOVE_THRESHOLD = 4;

  // ── 拖拽移动状态 ─────────────────────────────────────────────
  let selectedId         = null;
  let dragging           = false;
  let dragStartImgX      = 0, dragStartImgY = 0;
  let dragAnnSnapshot    = null;
  let isDragMoved        = false;  // true 表示拖拽距离超过阈值
  let wasAlreadySelected = false;  // true 表示 mousedown 时该批注已经处于选中状态

  // ── 缩放（控制点拖拽）状态 ────────────────────────────────────
  let resizing         = false;
  let resizeHandleIdx  = -1;   // 0=TL 1=TR 2=BL 3=BR
  let resizeAnchor     = null; // 固定角（底图坐标，不含 pad）
  let resizeOrigCorner = null; // 拖拽角原始位置
  let resizeOrigAnn    = null; // 缩放开始时的批注快照

  // ── 文字宽度拖拽状态 ──────────────────────────────────────────
  let textWidthResizing  = false; // 'left' | 'right' | false
  let textWidthOrigW     = 0;     // 拖拽开始时的 ann.width
  let textWidthOrigX     = 0;     // 拖拽开始时的 ann.x（左侧手柄需要）
  let textWidthStartImgX = 0;     // 拖拽开始时的图像坐标 X

  // ── 文字模式 ─────────────────────────────────────────────────
  let textMode      = false;
  let editingTextId = null;

  // ── 空格平移标志 ─────────────────────────────────────────────
  let spaceDown = false;

  // ── 触摸 / 捏合缩放状态 ───────────────────────────────────────
  let isTouchInteraction = false; // 当前 mousedown 是否由 touch 触发
  let pinching        = false;
  let pinchStartDist  = 0;
  let pinchStartScale = 1;
  let pinchStartTx    = 0, pinchStartTy = 0;
  let pinchStartMidX  = 0, pinchStartMidY = 0;

  // ═══════════════════════════════════════════════════════════
  //  坐标转换
  // ═══════════════════════════════════════════════════════════

  function screenToImage(sx, sy) {
    return { x: (sx - vp.tx) / vp.scale, y: (sy - vp.ty) / vp.scale };
  }
  function imageToScreen(ix, iy) {
    return { x: ix * vp.scale + vp.tx, y: iy * vp.scale + vp.ty };
  }
  function evToImage(e) {
    const rect = dynamicCanvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    return screenToImage((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  }
  function evToScreen(e) {
    const rect = dynamicCanvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
  }

  // ═══════════════════════════════════════════════════════════
  //  Canvas 尺寸适配（HiDPI）
  // ═══════════════════════════════════════════════════════════

  function resizeCanvases() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvasArea.getBoundingClientRect();
    const w = rect.width * dpr, h = rect.height * dpr;
    [staticCanvas, dynamicCanvas].forEach(c => {
      c.width = w; c.height = h;
      c.style.width = rect.width + 'px'; c.style.height = rect.height + 'px';
    });
    redrawStatic();
  }

  // ═══════════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════════

  function applyViewport(ctx) {
    ctx.setTransform(vp.scale, 0, 0, vp.scale, vp.tx, vp.ty);
  }

  function redrawStatic() {
    const ctx = staticCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);
    applyViewport(ctx);
    if (App.bgCanvas) ctx.drawImage(App.bgCanvas, 0, 0);
    for (const ann of App.annotations) {
      if (ann.id !== selectedId) drawAnnotation(ctx, ann);
    }
    if (selectedId) {
      const sel = App.annotations.find(a => a.id === selectedId);
      if (sel) drawAnnotation(ctx, sel);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function redrawDynamic() {
    const ctx = dynamicCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
    applyViewport(ctx);

    // 当前笔迹 / 停顿预览
    if (isDrawing) {
      if (beautifiedPreview) {
        drawAnnotation(ctx, { ...beautifiedPreview, color: App.color, lineWidth: App.lineWidth });
      } else if (currentPoints.length >= 2) {
        drawAnnotation(ctx, { type: 'freehand', color: App.color, lineWidth: App.lineWidth, points: currentPoints });
      }
    }

    // 正在编辑的文字批注：画虚线框（无控制点）作为输入边界提示
    if (editingTextId) {
      const editAnn = App.annotations.find(a => a.id === editingTextId);
      if (editAnn) drawEditingOutline(ctx, editAnn);
    }

    // 选中控制框 + 控制点
    if (selectedId && selectedId !== editingTextId) {
      const sel = App.annotations.find(a => a.id === selectedId);
      if (sel) drawSelectionOverlay(ctx, sel);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * 绘制选中框：虚线矩形 + 控制点
   * - 文字批注：仅右侧中央一个宽度拖拽手柄（横向调整宽度）
   * - 其他批注：四角控制点（等比缩放）
   */
  function drawSelectionOverlay(ctx, ann) {
    const bb  = getBoundingBox(ann);
    const pad = SEL_PAD();

    const x = bb.x - pad, y = bb.y - pad;
    const w = bb.w + pad * 2, h = bb.h + pad * 2;

    ctx.save();
    // 虚线矩形
    ctx.strokeStyle = '#89b4fa';
    ctx.lineWidth   = 1.5 / vp.scale;
    ctx.setLineDash([6 / vp.scale, 4 / vp.scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    const r = HANDLE_R();

    if (ann.type === 'text') {
      // 文字：右侧中央手柄（横向拉伸宽度用）
      const hx = x + w;
      const hy = y + h / 2;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, 2 * Math.PI);
      ctx.fillStyle   = '#89b4fa';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5 / vp.scale;
      ctx.stroke();
      // 左侧中央手柄（对称）
      ctx.beginPath();
      ctx.arc(x, hy, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    } else {
      // 非文字：四角控制点
      const corners = selCorners(bb);
      for (const c of corners) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, 2 * Math.PI);
        ctx.fillStyle   = '#89b4fa';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 1.5 / vp.scale;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * 编辑中的文字批注：只画虚线框，不画控制点
   * 框的大小动态跟随文字实际包围盒
   */
  function drawEditingOutline(ctx, ann) {
    const bb  = getBoundingBox(ann);
    const pad = SEL_PAD();
    ctx.save();
    ctx.strokeStyle = '#f38ba8';
    ctx.lineWidth   = 1.5 / vp.scale;
    ctx.setLineDash([5 / vp.scale, 4 / vp.scale]);
    ctx.strokeRect(bb.x - pad, bb.y - pad, bb.w + pad * 2, bb.h + pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── 控制点尺寸 / 位置辅助 ─────────────────────────────────────

  /** 选中框 padding（图像坐标） */
  function SEL_PAD() { return 6 / vp.scale; }

  /** 控制点半径（图像坐标） */
  function HANDLE_R() { return 6 / vp.scale; }

  /** 控制点命中半径（图像坐标，略大于视觉半径，方便点击） */
  function HANDLE_HIT_R() { return 12 / vp.scale; }

  /**
   * 四角控制点位置（图像坐标，位于选中框角上）
   * 顺序：0=TL 1=TR 2=BL 3=BR
   */
  function selCorners(bb) {
    const pad = SEL_PAD();
    return [
      { x: bb.x - pad,         y: bb.y - pad         }, // TL
      { x: bb.x + bb.w + pad,  y: bb.y - pad         }, // TR
      { x: bb.x - pad,         y: bb.y + bb.h + pad  }, // BL
      { x: bb.x + bb.w + pad,  y: bb.y + bb.h + pad  }, // BR
    ];
  }

  // ═══════════════════════════════════════════════════════════
  //  控制点命中检测
  // ═══════════════════════════════════════════════════════════

  /**
   * 检查 (x, y) 是否命中某个控制点
   * @returns {number} 0-3 对应角索引，-1 表示未命中
   */
  function findControlPointHit(ann, x, y) {
    const bb      = getBoundingBox(ann);
    const corners = selCorners(bb);
    const hitR    = HANDLE_HIT_R();
    for (let i = 0; i < corners.length; i++) {
      if (Math.hypot(x - corners[i].x, y - corners[i].y) < hitR) return i;
    }
    return -1;
  }

  /**
   * 检查 (x, y) 是否命中文字批注的宽度拖拽手柄
   * 手柄位于选中框右侧中央和左侧中央
   * 返回 'right' / 'left' / null
   */
  function findTextWidthHandleHit(ann, x, y) {
    const bb  = getBoundingBox(ann);
    const pad = SEL_PAD();
    const rx  = bb.x + bb.w + pad;
    const lx  = bb.x - pad;
    const hy  = bb.y + bb.h / 2;
    const hitR = HANDLE_HIT_R();
    if (Math.hypot(x - rx, y - hy) < hitR) return 'right';
    if (Math.hypot(x - lx, y - hy) < hitR) return 'left';
    return null;
  }

  /**
   * 判断 (x, y) 是否在批注的选中框内（含 pad）
   */
  function insideBBox(ann, x, y) {
    const bb  = getBoundingBox(ann);
    const pad = SEL_PAD();
    return x >= bb.x - pad && x <= bb.x + bb.w + pad &&
           y >= bb.y - pad && y <= bb.y + bb.h + pad;
  }

  // ═══════════════════════════════════════════════════════════
  //  缩放：启动 / 执行
  // ═══════════════════════════════════════════════════════════

  /**
   * 开始缩放操作
   * 使用不含 pad 的真实包围盒角作为缩放锚点，确保数值准确
   */
  function startResize(ann, handleIdx) {
    resizing        = true;
    resizeHandleIdx = handleIdx;
    resizeOrigAnn   = JSON.parse(JSON.stringify(ann));

    const bb = getBoundingBox(ann);
    // 真实角（不含 pad）
    const corners = [
      { x: bb.x,        y: bb.y        }, // TL
      { x: bb.x + bb.w, y: bb.y        }, // TR
      { x: bb.x,        y: bb.y + bb.h }, // BL
      { x: bb.x + bb.w, y: bb.y + bb.h }, // BR
    ];
    const oppositeIdx = [3, 2, 1, 0]; // TL↔BR, TR↔BL
    resizeOrigCorner = { ...corners[handleIdx] };
    resizeAnchor     = { ...corners[oppositeIdx[handleIdx]] };
  }

  /**
   * 执行缩放：将批注的所有坐标按锚点 → 当前鼠标位置做仿射缩放
   * 变换公式：new = anchor + (orig - anchor) * scale
   * @param {boolean} proportional  true = Shift 等比缩放
   */
  function doResize(ann, imgPt, proportional) {
    const snap  = resizeOrigAnn;
    const ax    = resizeAnchor.x, ay = resizeAnchor.y;
    const origDx = resizeOrigCorner.x - ax;
    const origDy = resizeOrigCorner.y - ay;

    let scaleX, scaleY;
    if (proportional) {
      // 把鼠标位移投影到"锚点→原始角点"对角线方向，得到统一缩放比例
      // scale = (mouseVec · diagVec) / |diagVec|²
      const denom = origDx * origDx + origDy * origDy;
      const uniformScale = denom > 0.25
        ? ((imgPt.x - ax) * origDx + (imgPt.y - ay) * origDy) / denom
        : 1;
      scaleX = Math.abs(origDx) > 0.5 ? uniformScale : 1;
      scaleY = Math.abs(origDy) > 0.5 ? uniformScale : 1;
    } else {
      // 避免除以零（包围盒退化为一个点时不做缩放）
      scaleX = Math.abs(origDx) > 0.5 ? (imgPt.x - ax) / origDx : 1;
      scaleY = Math.abs(origDy) > 0.5 ? (imgPt.y - ay) / origDy : 1;
    }

    /** 变换单个点 */
    const sp = p => ({
      x: ax + (p.x - ax) * scaleX,
      y: ay + (p.y - ay) * scaleY
    });

    switch (ann.type) {
      case 'freehand':
        ann.points = snap.points.map(sp);
        break;
      case 'rect':
        ann.corners = snap.corners.map(sp);
        break;

      case 'line': {
        const p1 = sp({ x: snap.x1, y: snap.y1 });
        const p2 = sp({ x: snap.x2, y: snap.y2 });
        ann.x1 = p1.x; ann.y1 = p1.y;
        ann.x2 = p2.x; ann.y2 = p2.y;
        break;
      }

      case 'circle': {
        const c = sp({ x: snap.cx, y: snap.cy });
        ann.cx = c.x; ann.cy = c.y;
        // 半径随对应轴缩放（取绝对值，允许翻转）
        ann.rx = Math.max(2, Math.abs(snap.rx * scaleX));
        ann.ry = Math.max(2, Math.abs(snap.ry * scaleY));
        break;
      }

      case 'check':
        ann.start  = sp(snap.start);
        ann.valley = sp(snap.valley);
        ann.end    = sp(snap.end);
        break;

      case 'cross': {
        const l1s = sp({ x: snap.line1.x1, y: snap.line1.y1 });
        const l1e = sp({ x: snap.line1.x2, y: snap.line1.y2 });
        const l2s = sp({ x: snap.line2.x1, y: snap.line2.y1 });
        const l2e = sp({ x: snap.line2.x2, y: snap.line2.y2 });
        ann.line1 = { x1: l1s.x, y1: l1s.y, x2: l1e.x, y2: l1e.y };
        ann.line2 = { x1: l2s.x, y1: l2s.y, x2: l2e.x, y2: l2e.y };
        break;
      }

      case 'text': {
        const newPos = sp({ x: snap.x, y: snap.y });
        ann.x      = newPos.x;
        ann.y      = newPos.y;
        ann.width  = Math.max(40, Math.abs(snap.width * scaleX));
        // 字号跟随较大缩放轴变化
        const fontScale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
        ann.fontSize = Math.max(8, snap.fontSize * fontScale);
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  停顿检测 + 形状识别
  // ═══════════════════════════════════════════════════════════

  function clearPauseTimer() {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    beautifiedPreview = null;
  }

  function resetPauseTimer() {
    clearPauseTimer();
    if (!App.autoBeautify) return;
    pauseTimer = setTimeout(() => {
      const result = recognizeStroke(currentPoints);
      if (result) { beautifiedPreview = result; redrawDynamic(); }
    }, PAUSE_DELAY);
  }

  // ═══════════════════════════════════════════════════════════
  //  提交笔迹
  // ═══════════════════════════════════════════════════════════

  function commitStroke() {
    if (currentPoints.length < 1) { currentPoints = []; return; }
    // 单点 tap：复制一份，让 lineCap=round 渲染为圆点
    if (currentPoints.length === 1) currentPoints.push({ ...currentPoints[0] });

    App.saveUndo();

    let ann;
    if (App.autoBeautify) {
      const result = beautifiedPreview || recognizeStroke(currentPoints);
      if (result) {
        ann = { id: App.newId(), color: App.color, lineWidth: App.lineWidth, ...result };
      }
    }
    if (!ann) {
      ann = { id: App.newId(), type: 'freehand', color: App.color, lineWidth: App.lineWidth, points: [...currentPoints] };
    }

    App.annotations.push(ann);

    // 叉号双笔检测
    if (App.autoBeautify && App.annotations.length >= 2) {
      const prev  = App.annotations[App.annotations.length - 2];
      const curr  = App.annotations[App.annotations.length - 1];
      const cross = recognizeCrossFromTwo(prev, curr);
      if (cross) {
        App.annotations.splice(-2, 2);
        App.annotations.push({ id: App.newId(), color: curr.color, lineWidth: curr.lineWidth, ...cross });
      }
    }

    currentPoints = [];
    clearPauseTimer();
    redrawStatic();
    redrawDynamic();
  }

  // ═══════════════════════════════════════════════════════════
  //  命中检测（线条精确命中，用于初次点选）
  // ═══════════════════════════════════════════════════════════

  function findHit(x, y) {
    const threshold = 10 / vp.scale;
    for (let i = App.annotations.length - 1; i >= 0; i--) {
      if (hitTest(App.annotations[i], x, y, threshold)) return App.annotations[i];
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  光标更新
  // ═══════════════════════════════════════════════════════════

  const RESIZE_CURSORS = ['nw-resize', 'ne-resize', 'sw-resize', 'se-resize'];

  function updateCursor(imgPt) {
    if (isDrawing || isPanning || dragging || resizing || textWidthResizing) return;
    if (spaceDown) { dynamicCanvas.style.cursor = 'grab'; return; }

    if (selectedId) {
      const sel = App.annotations.find(a => a.id === selectedId);
      if (sel) {
        if (sel.type === 'text') {
          if (findTextWidthHandleHit(sel, imgPt.x, imgPt.y)) {
            dynamicCanvas.style.cursor = 'ew-resize';
            return;
          }
        } else {
          const hi = findControlPointHit(sel, imgPt.x, imgPt.y);
          if (hi >= 0) {
            dynamicCanvas.style.cursor = RESIZE_CURSORS[hi];
            return;
          }
        }
        if (insideBBox(sel, imgPt.x, imgPt.y)) {
          dynamicCanvas.style.cursor = 'move';
          return;
        }
      }
    }
    dynamicCanvas.style.cursor = 'crosshair';
  }

  // ═══════════════════════════════════════════════════════════
  //  鼠标事件
  // ═══════════════════════════════════════════════════════════

  function onMouseDown(e) {
    // 中键 / 空格+左键 → 平移
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      isPanning  = true;
      const sc   = evToScreen(e);
      panStartX  = sc.x; panStartY  = sc.y;
      panStartTx = vp.tx; panStartTy = vp.ty;
      canvasArea.classList.add('panning');
      dynamicCanvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    // 若有正在编辑的文字，先提交（取消 blur 延迟里的重复提交也无妨）
    if (editingTextId) commitTextInput();

    const imgPt = evToImage(e);
    isDragMoved        = false;
    wasAlreadySelected = false;

    // ── 已有选中批注：优先处理控制点和包围框 ──────────────────
    if (selectedId) {
      const sel = App.annotations.find(a => a.id === selectedId);
      // 移动端触摸：非文字批注不可选中/操作，直接清除选中
      if (sel && isTouchInteraction && sel.type !== 'text') {
        selectedId = null;
        redrawStatic(); redrawDynamic();
      } else if (sel) {
        if (sel.type === 'text') {
          // 1a. 文字：宽度拖拽手柄
          const wh = findTextWidthHandleHit(sel, imgPt.x, imgPt.y);
          if (wh) {
            textWidthResizing  = wh;  // 'left' or 'right'
            textWidthOrigW     = sel.width;
            textWidthOrigX     = sel.x;
            textWidthStartImgX = imgPt.x;
            App.saveUndo();
            return;
          }
        } else {
          // 1b. 非文字：四角控制点
          const hi = findControlPointHit(sel, imgPt.x, imgPt.y);
          if (hi >= 0) {
            startResize(sel, hi);
            return;
          }
        }
        // 2. 包围框内 → 记录"已选中"标志并开始拖拽（文字和非文字统一处理）
        if (insideBBox(sel, imgPt.x, imgPt.y)) {
          wasAlreadySelected = true;
          dragging        = true;
          dragStartImgX   = imgPt.x;
          dragStartImgY   = imgPt.y;
          dragAnnSnapshot = JSON.parse(JSON.stringify(sel));
          return;
        }
      }
      if (selectedId) {
        // 框外点击 → 取消选中，继续往下判断
        selectedId = null;
        redrawStatic();
        redrawDynamic();
      }
    }

    // ── 线条精确命中 → 选中，统一准备拖拽（文字首次点击仅选中，不入编辑）
    // 移动端触摸：只允许选中文字批注
    const hitAnn = findHit(imgPt.x, imgPt.y);
    if (hitAnn && !(isTouchInteraction && hitAnn.type !== 'text')) {
      selectedId      = hitAnn.id;
      dragging        = true;
      dragStartImgX   = imgPt.x;
      dragStartImgY   = imgPt.y;
      dragAnnSnapshot = JSON.parse(JSON.stringify(hitAnn));
      redrawDynamic();
      return;
    }

    // ── 无命中 → 根据当前工具决定行为 ──────────────────────────
    if (textMode) {
      createTextAnnotation(imgPt.x, imgPt.y);
    } else {
      isDrawing     = true;
      currentPoints = [{ x: imgPt.x, y: imgPt.y }];
      resetPauseTimer();
    }
  }

  function onMouseMove(e) {
    const imgPt = evToImage(e);

    // 平移
    if (isPanning) {
      const sc = evToScreen(e);
      vp.tx = panStartTx + (sc.x - panStartX);
      vp.ty = panStartTy + (sc.y - panStartY);
      redrawStatic(); redrawDynamic();
      return;
    }

    // 控制点缩放（Shift = 等比）
    if (resizing && selectedId) {
      const ann = App.annotations.find(a => a.id === selectedId);
      if (ann) { doResize(ann, imgPt, e.shiftKey); redrawStatic(); redrawDynamic(); }
      return;
    }

    // 文字宽度拖拽
    if (textWidthResizing && selectedId) {
      const ann = App.annotations.find(a => a.id === selectedId);
      if (ann) {
        const dxImg = imgPt.x - textWidthStartImgX;
        const minW  = 40 / vp.scale;
        if (textWidthResizing === 'right') {
          ann.width = Math.max(minW, textWidthOrigW + dxImg);
        } else {
          // 左侧手柄：右边界固定（= textWidthOrigX + textWidthOrigW），向左拉宽
          const newW = Math.max(minW, textWidthOrigW - dxImg);
          ann.x     = textWidthOrigX + textWidthOrigW - newW;
          ann.width = newW;
        }
        redrawStatic(); redrawDynamic();
      }
      return;
    }

    // 拖拽移动
    if (dragging && selectedId) {
      const dx   = imgPt.x - dragStartImgX;
      const dy   = imgPt.y - dragStartImgY;
      const dist = Math.hypot(dx, dy);
      // 超过阈值才认为是真正的拖拽（避免手抖误移）
      if (!isDragMoved && dist > 3 / vp.scale) isDragMoved = true;
      if (isDragMoved) {
        moveAnnotation(selectedId, dx, dy, dragAnnSnapshot);
        redrawStatic(); redrawDynamic();
      }
      return;
    }

    // 绘制中
    if (isDrawing) {
      const last = currentPoints[currentPoints.length - 1];
      const dist = Math.hypot(imgPt.x - last.x, imgPt.y - last.y);
      if (dist < 1) return;
      currentPoints.push({ x: imgPt.x, y: imgPt.y });
      if (dist > MOVE_THRESHOLD / vp.scale) {
        beautifiedPreview = null;
        resetPauseTimer();
      }
      redrawDynamic();
      return;
    }

    // 悬停：更新光标
    updateCursor(imgPt);
  }

  function onMouseUp(e) {
    if (isPanning) {
      isPanning = false;
      canvasArea.classList.remove('panning');
      // 松开鼠标后：若 Space 仍按着则保持 grab，否则还原 crosshair
      dynamicCanvas.style.cursor = spaceDown ? 'grab' : 'crosshair';
      return;
    }
    if (resizing) {
      resizing        = false;
      resizeHandleIdx = -1;
      resizeOrigAnn   = null;
      App.saveUndo();
      redrawStatic(); redrawDynamic();
      return;
    }
    if (textWidthResizing) {
      textWidthResizing = false;
      redrawStatic(); redrawDynamic();
      return;
    }
    if (dragging) {
      dragging = false;
      if (isDragMoved) {
        // 真正移动了 → 保存撤销快照
        dragAnnSnapshot = null;
        App.saveUndo();
        redrawStatic(); redrawDynamic();
      } else if (wasAlreadySelected) {
        // 在已选中批注上点击（无移动）→ 若是文字则进入编辑模式
        const sel = App.annotations.find(a => a.id === selectedId);
        dragAnnSnapshot = null;
        if (sel && sel.type === 'text') enterEditMode(sel);
      } else {
        // 首次选中（无移动）→ 保持选中，刷新显示选中框
        dragAnnSnapshot = null;
        const selAnn = App.annotations.find(a => a.id === selectedId);
        if (selAnn && selAnn.type === 'text') syncTextToolbar(selAnn);
        redrawDynamic();
      }
      return;
    }
    if (isDrawing) {
      isDrawing = false;
      commitStroke();
    }
  }

  function onMouseLeave() {
    if (isDrawing) { isDrawing = false; commitStroke(); }
    if (isPanning) {
      isPanning = false;
      canvasArea.classList.remove('panning');
      dynamicCanvas.style.cursor = spaceDown ? 'grab' : 'crosshair';
    }
  }

  // ── 滚轮缩放 ─────────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    const sc       = evToScreen(e);
    const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.1, Math.min(8, vp.scale * factor));
    vp.tx    = sc.x - (sc.x - vp.tx) * (newScale / vp.scale);
    vp.ty    = sc.y - (sc.y - vp.ty) * (newScale / vp.scale);
    vp.scale = newScale;
    redrawStatic(); redrawDynamic();
  }

  // ── 键盘 ─────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (e.code === 'Space' && !e.repeat) {
      spaceDown = true;
      dynamicCanvas.style.cursor = 'grab'; // dynamicCanvas 在最上层，直接设它才可见
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault(); App.undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
      e.preventDefault(); App.redo();
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && selectedId && !editingTextId) {
      e.preventDefault();
      App.saveUndo();
      App.annotations = App.annotations.filter(a => a.id !== selectedId);
      selectedId = null;
      redrawStatic(); redrawDynamic();
    }
    if (e.code === 'Escape') {
      if (editingTextId) commitTextInput();
      selectedId = null;
      redrawStatic(); redrawDynamic();
    }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceDown = false;
      // 恢复光标（panning 中松开 Space 比较少见，直接重置为 crosshair，
      // 下一次 mousemove 会由 updateCursor 精确修正）
      if (!isPanning) dynamicCanvas.style.cursor = 'crosshair';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  触摸事件（移动端）
  // ═══════════════════════════════════════════════════════════

  /** 将 Touch 对象转为鼠标事件的最小兼容形式 */
  function touchSynth(touch) {
    return { clientX: touch.clientX, clientY: touch.clientY, button: 0, buttons: 1, shiftKey: false };
  }

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1 && !pinching) {
      isTouchInteraction = true;
      onMouseDown(touchSynth(e.touches[0]));
      isTouchInteraction = false;
    } else if (e.touches.length === 2) {
      // 进入捏合模式：取消正在进行的绘制/拖拽
      pinching = true;
      if (isDrawing) { isDrawing = false; currentPoints = []; clearPauseTimer(); redrawDynamic(); }
      if (dragging)  { dragging = false; }

      const t1 = e.touches[0], t2 = e.touches[1];
      const rect = dynamicCanvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      pinchStartDist  = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchStartScale = vp.scale;
      pinchStartTx    = vp.tx;
      pinchStartTy    = vp.ty;
      pinchStartMidX  = ((t1.clientX + t2.clientX) / 2 - rect.left) * dpr;
      pinchStartMidY  = ((t1.clientY + t2.clientY) / 2 - rect.top)  * dpr;
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (pinching && e.touches.length >= 2) {
      const t1   = e.touches[0], t2 = e.touches[1];
      const rect = dynamicCanvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const mx   = ((t1.clientX + t2.clientX) / 2 - rect.left) * dpr;
      const my   = ((t1.clientY + t2.clientY) / 2 - rect.top)  * dpr;

      const newScale = Math.max(0.2, Math.min(10, pinchStartScale * dist / (pinchStartDist || 1)));
      // 保持捏合起始中点下的图像坐标不变，同时跟随手指平移
      const imgX = (pinchStartMidX - pinchStartTx) / pinchStartScale;
      const imgY = (pinchStartMidY - pinchStartTy) / pinchStartScale;
      vp.scale = newScale;
      vp.tx    = mx - imgX * newScale;
      vp.ty    = my - imgY * newScale;
      redrawStatic(); redrawDynamic();
    } else if (!pinching && e.touches.length === 1) {
      onMouseMove(touchSynth(e.touches[0]));
    }
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (pinching) {
      if (e.touches.length < 2) pinching = false;
      return;
    }
    if (e.changedTouches.length) onMouseUp(touchSynth(e.changedTouches[0]));
  }

  // ═══════════════════════════════════════════════════════════
  //  批注移动
  // ═══════════════════════════════════════════════════════════

  function moveAnnotation(id, dx, dy, snap) {
    const ann = App.annotations.find(a => a.id === id);
    if (!ann || !snap) return;
    switch (ann.type) {
      case 'freehand':
        ann.points = snap.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        break;
      case 'rect':
        ann.corners = snap.corners.map(p => ({ x: p.x + dx, y: p.y + dy }));
        break;
      case 'line':
        ann.x1 = snap.x1 + dx; ann.y1 = snap.y1 + dy;
        ann.x2 = snap.x2 + dx; ann.y2 = snap.y2 + dy;
        break;
      case 'circle':
        ann.cx = snap.cx + dx; ann.cy = snap.cy + dy;
        break;
      case 'check':
        ann.start  = { x: snap.start.x  + dx, y: snap.start.y  + dy };
        ann.valley = { x: snap.valley.x + dx, y: snap.valley.y + dy };
        ann.end    = { x: snap.end.x    + dx, y: snap.end.y    + dy };
        break;
      case 'cross':
        ann.line1 = { x1: snap.line1.x1 + dx, y1: snap.line1.y1 + dy,
                      x2: snap.line1.x2 + dx, y2: snap.line1.y2 + dy };
        ann.line2 = { x1: snap.line2.x1 + dx, y1: snap.line2.y1 + dy,
                      x2: snap.line2.x2 + dx, y2: snap.line2.y2 + dy };
        break;
      case 'text':
        ann.x = snap.x + dx; ann.y = snap.y + dy;
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  文字批注
  // ═══════════════════════════════════════════════════════════

  /** 进入文字编辑模式（新建或二次编辑均走此函数） */
  function enterEditMode(ann) {
    editingTextId = ann.id;
    selectedId    = ann.id;
    syncTextToolbar(ann);
    showTextInput(ann);
    redrawDynamic();
  }

  function createTextAnnotation(x, y) {
    // 先提交上一个正在编辑的文字（如果有）
    commitTextInput();

    // fontSize / width 存储在「图像坐标系」中：
    //   渲染时：图像px × vp.scale = 物理px；物理px / dpr = CSS px
    //   目标：让文字在屏幕上显示为约 18 CSS px，与输入框完全一致
    const dpr      = window.devicePixelRatio || 1;
    const fontSize = (App.fontSize || 18) * dpr / vp.scale;  // → CSS px at current zoom
    const width    = 2 * (App.fontSize || 18) * dpr / vp.scale;  // 默认宽度 = 2个字符宽

    const ann = {
      id: App.newId(), type: 'text',
      color: App.color, lineWidth: App.lineWidth,
      fontSize, fontFamily: App.fontFamily, x, y, width,
      text: '文字'   // 预填默认内容
    };
    App.saveUndo();
    App.annotations.push(ann);
    redrawStatic();          // 先画出"文字"两字（同时初始化 _renderedLines）
    enterEditMode(ann);      // 显示输入框、选中框
  }

  /**
   * 在当前视口中央插入文字批注（点击「T 文字」按钮时调用）
   */
  function insertTextAtCenter() {
    const cx = (staticCanvas.width  / 2 - vp.tx) / vp.scale;
    const cy = (staticCanvas.height / 2 - vp.ty) / vp.scale;
    createTextAnnotation(cx, cy);
  }

  function showTextInput(ann) {
    const sc  = imageToScreen(ann.x, ann.y);
    const dpr = window.devicePixelRatio || 1;

    // ── 位置：物理像素 → CSS px ────────────────────────────────
    floatTextInput.style.left = (sc.x / dpr) + 'px';
    floatTextInput.style.top  = (sc.y / dpr) + 'px';

    // ── 宽高：与 canvas 中批注包围盒对齐 ───────────────────────
    floatTextInput.style.width  = (ann.width * vp.scale / dpr) + 'px';
    // 高度 = 实际行数 × 行高（多留 1 行空间供光标停留）
    const cssLineH = ann.fontSize * vp.scale / dpr * 1.5;
    const syncHeight = () => {
      const nLines = ann._renderedLines || 1;
      floatTextInput.style.height = ((nLines + 1) * cssLineH) + 'px';
    };
    syncHeight();

    // ── 字体：与 _drawText 一致，保证光标位置准确 ─────────────
    // textarea 文字是透明的（CSS color: transparent），
    // 用户看到的文字由 canvas 实时渲染，字号对齐让光标落在正确位置
    floatTextInput.style.fontSize   = (ann.fontSize * vp.scale / dpr) + 'px';
    floatTextInput.style.lineHeight = '1.5';
    floatTextInput.style.fontFamily = ann.fontFamily || '"Microsoft YaHei","PingFang SC",sans-serif';

    // 光标颜色跟随批注颜色
    floatTextInput.style.caretColor = ann.color || '#e53935';
    floatTextInput.style.display    = 'block';
    floatTextInput.value            = ann.text || '';

    floatTextInput.focus();
    floatTextInput.select(); // 全选，方便直接覆盖

    // oninput：实时更新批注数据并重绘 canvas（用户看 canvas 里的文字）
    floatTextInput.oninput = () => {
      const a = App.annotations.find(a => a.id === editingTextId);
      if (a) {
        a.text = floatTextInput.value;
        redrawStatic();   // 触发 _drawText → 更新 _renderedLines / _idealWidth

        // 自动撑开宽度：以"段落不换行自然宽度 + 半字余量"为目标，
        // 最小 2 字宽，最大不超过底图宽度的 90%
        const dpr_    = window.devicePixelRatio || 1;
        const minW    = 2 * a.fontSize;
        const maxW    = (App.bgWidth  || 794) * 0.9;
        const pad     = a.fontSize * 0.6;
        const needed  = Math.min(maxW, Math.max(minW, (a._idealWidth || 0) + pad));
        if (Math.abs(needed - a.width) > 0.5) {
          a.width = needed;
          floatTextInput.style.width = (a.width * vp.scale / dpr_) + 'px';
          redrawStatic(); // 用新宽度重绘（换行点可能改变）
        }

        redrawDynamic();  // 更新选中框
        syncHeight();     // 同步 textarea 高度（光标定位）
      }
    };
  }

  /**
   * 当工具栏字号/字体改变时，同步更新当前选中或正在编辑的文字批注
   */
  function updateSelectedTextStyle({ fontSize, fontFamily }) {
    if (!selectedId) return;
    const ann = App.annotations.find(a => a.id === selectedId);
    if (!ann || ann.type !== 'text') return;
    const dpr = window.devicePixelRatio || 1;
    if (fontSize  !== undefined) ann.fontSize   = fontSize * dpr / vp.scale;
    if (fontFamily !== undefined) ann.fontFamily = fontFamily;
    redrawStatic();
    redrawDynamic();
    if (editingTextId === ann.id) showTextInput(ann); // 同步输入框字体
  }

  /**
   * 将选中文字批注的样式同步回工具栏控件
   */
  function syncTextToolbar(ann) {
    const dpr    = window.devicePixelRatio || 1;
    const cssPx  = Math.round(ann.fontSize * vp.scale / dpr);
    const fsEl   = document.getElementById('textFontSize');
    const ffEl   = document.getElementById('textFontFamily');
    if (fsEl) {
      // 找最接近的选项
      let closest = null, closestDiff = Infinity;
      for (const opt of fsEl.options) {
        const diff = Math.abs(parseInt(opt.value) - cssPx);
        if (diff < closestDiff) { closestDiff = diff; closest = opt; }
      }
      if (closest) { fsEl.value = closest.value; App.fontSize = parseInt(closest.value); }
    }
    if (ffEl && ann.fontFamily) {
      ffEl.value = ann.fontFamily;
      App.fontFamily = ann.fontFamily;
    }
  }

  function commitTextInput(resetTool = false) {
    if (!editingTextId) return;
    const ann = App.annotations.find(a => a.id === editingTextId);
    if (ann) {
      ann.text = floatTextInput.value;
      if (!ann.text.trim()) App.annotations = App.annotations.filter(a => a.id !== editingTextId);
    }
    floatTextInput.style.display = 'none';
    floatTextInput.value = '';
    editingTextId = null;
    // 提交后自动切回画笔模式
    textMode = false;
    if (App.onTextModeEnd) App.onTextModeEnd();
    redrawStatic();
  }

  // ═══════════════════════════════════════════════════════════
  //  初始化
  // ═══════════════════════════════════════════════════════════

  function init() {
    staticCanvas   = document.getElementById('staticCanvas');
    dynamicCanvas  = document.getElementById('dynamicCanvas');
    staticCtx      = staticCanvas.getContext('2d');
    dynamicCtx     = dynamicCanvas.getContext('2d');
    canvasArea     = document.getElementById('canvasArea');
    floatTextInput = document.getElementById('floatTextInput');

    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    dynamicCanvas.addEventListener('mousedown',  onMouseDown);
    dynamicCanvas.addEventListener('mousemove',  onMouseMove);
    dynamicCanvas.addEventListener('mouseup',    onMouseUp);
    dynamicCanvas.addEventListener('mouseleave', onMouseLeave);
    dynamicCanvas.addEventListener('wheel',      onWheel, { passive: false });

    // 触摸事件（移动端）
    dynamicCanvas.addEventListener('touchstart',  onTouchStart,  { passive: false });
    dynamicCanvas.addEventListener('touchmove',   onTouchMove,   { passive: false });
    dynamicCanvas.addEventListener('touchend',    onTouchEnd,    { passive: false });
    dynamicCanvas.addEventListener('touchcancel', onTouchEnd,    { passive: false });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);

    floatTextInput.addEventListener('blur', () => setTimeout(commitTextInput, 100));
    floatTextInput.addEventListener('keydown', e => { if (e.key === 'Escape') commitTextInput(); });
  }

  // ═══════════════════════════════════════════════════════════
  //  公开接口
  // ═══════════════════════════════════════════════════════════

  return {
    init,
    redrawStatic,
    redrawDynamic,
    fitBackground() {
      if (!App.bgCanvas) return;
      const cw = staticCanvas.width, ch = staticCanvas.height;
      const bw = App.bgCanvas.width, bh = App.bgCanvas.height;
      const sc = Math.min(cw / bw, ch / bh) * 0.92;
      vp.scale = sc;
      vp.tx = (cw - bw * sc) / 2;
      vp.ty = (ch - bh * sc) / 2;
      redrawStatic(); redrawDynamic();
    },
    enterTextMode() { textMode = true; },
    setTextMode(val) { textMode = val; },
    insertTextAtCenter,
    commitTextInput,
    updateSelectedTextStyle,
    refresh() { redrawStatic(); redrawDynamic(); },
    getSelectedId() { return selectedId; },
    clearSelection() { selectedId = null; redrawStatic(); redrawDynamic(); }
  };
})();
