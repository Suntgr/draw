/**
 * exportImage.js
 * ─────────────────────────────────────────────────────────────
 * 将底图 + 全部批注合成为一张 PNG 并触发浏览器下载。
 *
 * 对外接口：
 *   exportToImage(bgCanvas, annotations, filename)
 *
 * 合成策略：
 *   - 离屏 Canvas 尺寸 = 底图原始尺寸（bgCanvas.width × bgCanvas.height）
 *   - 先绘制底图，再按顺序绘制所有批注
 *   - 批注坐标均为底图坐标系，直接绘制无需缩放
 * ─────────────────────────────────────────────────────────────
 */

/**
 * @param {HTMLCanvasElement} bgCanvas     底图离屏 Canvas（App.bgCanvas）
 * @param {Array}             annotations  批注列表（底图坐标系）
 * @param {string}            [filename]   下载文件名
 */
function exportToImage(bgCanvas, annotations, filename = 'homework-annotated.png') {
  // 创建离屏 Canvas
  const offscreen = document.createElement('canvas');
  offscreen.width  = bgCanvas.width;
  offscreen.height = bgCanvas.height;
  const ctx = offscreen.getContext('2d');

  // 1. 绘制底图
  ctx.drawImage(bgCanvas, 0, 0);

  // 2. 绘制全部批注（复用 annotations.js 的 drawAnnotations）
  drawAnnotations(ctx, annotations);

  // 3. 导出为 PNG 并触发下载
  offscreen.toBlob(blob => {
    if (!blob) { alert('导出失败，请检查图片跨域设置'); return; }
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}
