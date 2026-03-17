/**
 * app.js
 * ─────────────────────────────────────────────────────────────
 * 全局状态管理、初始化、工具栏事件绑定
 * ─────────────────────────────────────────────────────────────
 */

// ══════════════════════════════════════════════════════════════
//  全局状态对象（供所有模块共享）
// ══════════════════════════════════════════════════════════════
const App = {
  annotations: [],   // 所有已完成的批注
  undoStack:   [],   // 快照栈（每项是 annotations 的深拷贝）
  redoStack:   [],

  bgCanvas: null,    // 底图离屏 Canvas
  bgWidth:  794,     // 底图逻辑宽高（生成时设定）
  bgHeight: 1123,

  autoBeautify: true,
  color:        '#e53935',
  lineWidth:    2,
  fontSize:     18,   // CSS px，创建文字批注时换算为图像坐标
  fontFamily:   '"Ma Shan Zheng",cursive',

  _idCounter: 1,

  newId() { return 'ann_' + (this._idCounter++); },

  /** 保存当前状态到撤销栈 */
  saveUndo() {
    this.undoStack.push(JSON.stringify(this.annotations));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  },

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.annotations));
    this.annotations = JSON.parse(this.undoStack.pop());
    CanvasManager.clearSelection();
    CanvasManager.refresh();
  },

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.annotations));
    this.annotations = JSON.parse(this.redoStack.pop());
    CanvasManager.clearSelection();
    CanvasManager.refresh();
  },

  tool: 'pen',   // 'pen' | 'text'

  onTextModeEnd: null
};

// ══════════════════════════════════════════════════════════════
//  生成底图（程序化作业纸）
// ══════════════════════════════════════════════════════════════
function createHomeworkBackground() {
  const W = App.bgWidth, H = App.bgHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // 纸张底色
  ctx.fillStyle = '#fffef5';
  ctx.fillRect(0, 0, W, H);

  // 页面边框
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // 左侧红线（页边）
  ctx.strokeStyle = '#f5c6c6';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(72, 30); ctx.lineTo(72, H - 30);
  ctx.stroke();

  // 横线
  ctx.strokeStyle = '#dce0e8';
  ctx.lineWidth = 0.8;
  const lineSpacing = 52;
  for (let y = 100; y < H - 40; y += lineSpacing) {
    ctx.beginPath();
    ctx.moveTo(50, y); ctx.lineTo(W - 50, y);
    ctx.stroke();
  }

  // 标题
  ctx.fillStyle = '#2d3250';
  ctx.font = 'bold 32px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText('数学练习题', 90, 60);

  ctx.fillStyle = '#888';
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillText('班级：______  姓名：______  得分：______', 90, 82);

  // 题目内容
  ctx.fillStyle = '#222';
  ctx.font = '19px "Microsoft YaHei", "PingFang SC", sans-serif';
  const problems = [
    '一、计算下列各题',
    '1.  25 × 4 = ______',
    '2.  136 + 287 = ______',
    '3.  500 − 163 = ______',
    '4.  72 ÷ 8 = ______',
    '5.  (18 + 6) × 5 = ______',
    '6.  96 ÷ 12 + 35 = ______',
    '',
    '二、解决问题',
    '7. 小明有 32 颗糖，平均分给 4 个小朋友，',
    '   每人得几颗？',
    '',
    '   答：___________________________',
    '',
    '8. 一本书共 240 页，小红 3 天看完，',
    '   平均每天看几页？',
    '',
    '   答：___________________________',
    '',
    '9. 学校买来 5 盒彩笔，每盒 12 支，',
    '   共多少支？用了 18 支后还剩多少支？',
    '',
    '   答：___________________________',
  ];

  let y = 118;
  for (const line of problems) {
    if (line.startsWith('一、') || line.startsWith('二、')) {
      ctx.font = 'bold 19px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#1a1a2e';
    } else {
      ctx.font = '19px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#222';
    }
    ctx.fillText(line, 90, y);
    y += lineSpacing;
  }

  // 底部评语区域
  ctx.strokeStyle = '#dce0e8';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(50, H - 120, W - 100, 90);
  ctx.fillStyle = '#888';
  ctx.font = '13px "Microsoft YaHei", sans-serif';
  ctx.fillText('教师评语：', 62, H - 104);

  return c;
}

// ══════════════════════════════════════════════════════════════
//  工具栏绑定
// ══════════════════════════════════════════════════════════════
function bindToolbar() {
  // 自动美化开关
  const cbBeautify = document.getElementById('autoBeautify');
  cbBeautify.addEventListener('change', () => {
    App.autoBeautify = cbBeautify.checked;
  });

  // 颜色
  const colorPicker = document.getElementById('colorPicker');
  colorPicker.addEventListener('input', () => {
    App.color = colorPicker.value;
  });

  // 线宽
  const lwInput = document.getElementById('lineWidth');
  const lwVal   = document.getElementById('lineWidthVal');
  lwInput.addEventListener('input', () => {
    App.lineWidth = parseInt(lwInput.value, 10);
    lwVal.textContent = lwInput.value;
  });

  // 字号
  const fsSelect = document.getElementById('textFontSize');
  fsSelect.addEventListener('change', () => {
    App.fontSize = parseInt(fsSelect.value, 10);
    CanvasManager.updateSelectedTextStyle({ fontSize: App.fontSize });
  });

  // 字体
  const ffSelect = document.getElementById('textFontFamily');
  ffSelect.addEventListener('change', () => {
    App.fontFamily = ffSelect.value;
    CanvasManager.updateSelectedTextStyle({ fontFamily: App.fontFamily });
  });

  // 工具按钮：画笔 / 文字
  const btnToolPen  = document.getElementById('btnToolPen');
  const btnToolText = document.getElementById('btnToolText');

  function selectTool(tool) {
    App.tool = tool;
    const isText = tool === 'text';
    CanvasManager.setTextMode(isText);
    btnToolPen .classList.toggle('btn-tool-active', !isText);
    btnToolText.classList.toggle('btn-tool-active',  isText);
  }

  btnToolPen .addEventListener('click', () => selectTool('pen'));
  btnToolText.addEventListener('click', () => selectTool('text'));

  // 文字提交后自动切回画笔（canvas.js 内部调用）
  App.onTextModeEnd = () => selectTool('pen');

  // 撤销 / 重做
  document.getElementById('btnUndo').addEventListener('click', () => App.undo());
  document.getElementById('btnRedo').addEventListener('click', () => App.redo());

  // 清除批注
  document.getElementById('btnClear').addEventListener('click', () => {
    if (!App.annotations.length) return;
    if (!confirm('确认清除所有批注吗？')) return;
    App.saveUndo();
    App.annotations = [];
    CanvasManager.clearSelection();
    CanvasManager.refresh();
  });

  // 导出
  document.getElementById('btnExport').addEventListener('click', () => {
    CanvasManager.commitTextInput(); // 先提交正在编辑的文字
    exportToImage(App.bgCanvas, App.annotations);
  });

}

// ══════════════════════════════════════════════════════════════
//  入口
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // 1. 生成底图
  App.bgCanvas = createHomeworkBackground();

  // 2. 初始化 Canvas 管理器
  CanvasManager.init();

  // 3. 居中适配底图
  CanvasManager.fitBackground();

  // 4. 绑定工具栏
  bindToolbar();

  // 5. 提示
  console.log(
    '%c作业批注工具已就绪\n' +
    '%c• 自由绘制后停顿 0.5s 自动美化\n' +
    '• 连续两笔交叉自动识别为叉号\n' +
    '• 滚轮缩放，空格+拖拽平移\n' +
    '• 单击批注选中，拖拽移动，Delete 删除\n' +
    '• Ctrl+Z 撤销，Ctrl+Y 重做',
    'color:#89b4fa;font-weight:bold;font-size:14px',
    'color:#a6adc8;font-size:12px'
  );
});
