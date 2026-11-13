'use strict';
/**
 * 托盘图标：用代码画成 PNG，不往仓库里塞二进制资源。
 *
 * 为什么不用现成的 .ico 文件：
 * - 二进制资源进版本库后没法 diff、没法 review，改个颜色就是一次「二进制变更」；
 * - 而且图标只有 16/32 两种尺寸，自己画反而比找一个合适的现成图标更可控。
 *
 * PNG 的结构不复杂：签名 + IHDR（宽高/位深/颜色类型）+ IDAT（zlib 压缩后的像素）+ IEND，
 * 每块前面带长度、后面带 CRC32。整个编码器不到 60 行，比引入一个图形库划算。
 */
const zlib = require('node:zlib');

/** CRC32 查表法：PNG 的每个数据块都要带校验和 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 把 RGBA 像素缓冲编码成 PNG */
function encodePng(size, rgba) {
  const stride = size * 4;
  // 每行前面加一个字节的「过滤器类型」，这里一律用 0（不压缩）
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深 8 位
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画一个尺寸为 size 的托盘图标：蓝色圆角方块 + 两条白色横线（文档列表的意象）。
 *
 * 不做抗锯齿：16 像素的托盘图标上，半透明的边缘反而会糊成一团脏边。
 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [47, 111, 235]; // 品牌蓝
  const fg = [255, 255, 255];
  const radius = size * 0.22;
  const inset = size * 0.05;
  // 两条横线的位置（按比例，换尺寸自动缩放）
  const bars = [
    { top: 0.33, bottom: 0.42, left: 0.26, right: 0.74 },
    { top: 0.53, bottom: 0.62, left: 0.26, right: 0.74 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const off = (y * size + x) * 4;

      // 圆角矩形：先算到最近内切矩形的距离，超过半径就在外面
      const cx = Math.min(Math.max(px, inset + radius), size - inset - radius);
      const cy = Math.min(Math.max(py, inset + radius), size - inset - radius);
      if (Math.hypot(px - cx, py - cy) > radius) continue; // 透明

      let color = bg;
      for (const bar of bars) {
        const inBar =
          py >= bar.top * size &&
          py < bar.bottom * size &&
          px >= bar.left * size &&
          px < bar.right * size;
        if (inBar) color = fg;
      }
      rgba[off] = color[0];
      rgba[off + 1] = color[1];
      rgba[off + 2] = color[2];
      rgba[off + 3] = 255;
    }
  }
  return rgba;
}

/**
 * 生成托盘图标。
 *
 * 同时给 16 与 32 两个尺寸：Windows 在 125%/150% 缩放下托盘图标是 20/24 像素，
 * Electron 会把 16 像素的图硬拉大，糊成一团。按缩放因子挑一个最接近的即可。
 */
function makeTrayImages() {
  return {
    small: encodePng(16, drawIcon(16)),
    large: encodePng(32, drawIcon(32)),
  };
}

/**
 * 生成 exe 的图标（.ico）。
 *
 * 结构和托盘图标一样，只是换成 ICO 容器：ICO 允许直接内嵌 PNG（Vista 以后都认），
 * 所以只要一个 256×256 的条目，Windows 会按需缩放。
 *
 * 不装图标的话，安装包和桌面快捷方式都是 Electron 的默认图标——
 * 使用者一眼就看出「这是个 Electron 壳子」，而不是自己的产品。
 */
function makeIconIco() {
  const size = 256;
  const png = encodePng(size, drawIcon(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留字段
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(1, 4); // 条目数
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 宽（0 表示 256）
  entry[1] = 0; // 高（0 表示 256）
  entry[2] = 0; // 调色板颜色数
  entry[3] = 0; // 保留字段
  entry.writeUInt16LE(1, 4); // 颜色平面数
  entry.writeUInt16LE(32, 6); // 每像素位数
  entry.writeUInt32LE(png.length, 8); // 图像数据长度
  entry.writeUInt32LE(header.length + entry.length, 12); // 图像数据偏移
  return Buffer.concat([header, entry, png]);
}

/**
 * 安装器用的品牌位图。
 *
 * MUI2 默认拿 NSIS 自带的 win.bmp（欢迎页大图）和 nsis.bmp（顶部横幅），
 * 那是「一眼就知道是 NSIS 打的」那种素材。这里换成自己的：同一套蓝圆角方块 + 白横线，
 * 跟托盘图标、exe 图标是同一套视觉语言。
 *
 * 仍然用代码画，不往仓库里塞二进制：改一次颜色就是一次 diff。
 */
const BRAND_BLUE = [47, 111, 235];
const BRAND_DEEP = [29, 78, 216];
const BRAND_VIOLET = [79, 70, 229];
const BRAND_GREEN = [5, 150, 105];
const BRAND_GREEN_DEEP = [4, 120, 87];
const WHITE = [255, 255, 255];

/** 建一张 RGB 画布（不含 alpha：BMP 24 位没有透明通道） */
function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 3) };
}

function setPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const off = (y * canvas.width + x) * 3;
  canvas.data[off] = color[0];
  canvas.data[off + 1] = color[1];
  canvas.data[off + 2] = color[2];
}

/** 对角线性渐变铺底 */
function fillGradient(canvas, from, to) {
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const t = Math.min(1, (x / canvas.width) * 0.72 + (y / canvas.height) * 0.28);
      setPixel(canvas, x, y, [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
      ]);
    }
  }
}

/** 圆角矩形填充（跟 drawIcon 里的判定方式一致：算到最近内切矩形的距离） */
function fillRoundRect(canvas, x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = Math.min(Math.max(px, x0 + radius), x0 + w - radius);
      const cy = Math.min(Math.max(py, y0 + radius), y0 + h - radius);
      if (Math.hypot(px - cx, py - cy) > radius) continue;
      setPixel(canvas, x, y, color);
    }
  }
}

/** 直线（Bresenham），用来画对勾 */
function drawLine(canvas, x0, y0, x1, y1, width, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    for (let dy = 0; dy < width; dy += 1) {
      for (let dx = 0; dx < width; dx += 1) {
        setPixel(canvas, x + dx, y + dy, color);
      }
    }
  }
}

/**
 * 5×7 点阵字模，只够拼出产品名。
 *
 * 不引字体渲染库：安装器里的字只有 "WorkHub" 七个字母，
 * 为它拖进一套字体解析不划算。
 */
const GLYPHS = {
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '01010'],
  o: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  r: ['11110', '10001', '10001', '11110', '10100', '10010', '10010'],
  k: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  u: ['00000', '00000', '10001', '10001', '10001', '10001', '01110'],
  b: ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
};

function drawText(canvas, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      glyph.forEach((row, ry) => {
        [...row].forEach((bit, rx) => {
          if (bit !== '1') return;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              setPixel(canvas, cursor + rx * scale + dx, y + ry * scale + dy, color);
            }
          }
        });
      });
    }
    cursor += 6 * scale;
  }
}

/** 蓝底白横线的方块：跟托盘图标同构 */
function drawBrandMark(canvas, x, y, size, markColor, barColor) {
  fillRoundRect(canvas, x, y, size, size, Math.round(size * 0.22), markColor);
  const bars = [
    { top: 0.33, bottom: 0.42, left: 0.26, right: 0.74 },
    { top: 0.53, bottom: 0.62, left: 0.26, right: 0.74 },
  ];
  for (const bar of bars) {
    fillRoundRect(
      canvas,
      x + Math.round(bar.left * size),
      y + Math.round(bar.top * size),
      Math.round((bar.right - bar.left) * size),
      Math.max(2, Math.round((bar.bottom - bar.top) * size)),
      1,
      barColor,
    );
  }
}

/** 24 位 BMP：文件头 14 字节 + DIB 头 40 字节 + 像素（自下而上，行按 4 字节对齐） */
function encodeBmp(canvas) {
  const { width, height } = canvas;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixelSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixelSize, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  const pixels = Buffer.alloc(pixelSize);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const src = (srcRow * width + x) * 3;
      const dst = y * rowSize + x * 3;
      pixels[dst] = canvas.data[src + 2];
      pixels[dst + 1] = canvas.data[src + 1];
      pixels[dst + 2] = canvas.data[src];
    }
  }
  return Buffer.concat([header, pixels]);
}

/**
 * 生成安装器要用的三张位图。
 *
 * header  150×57   顶部横幅（所有页面都有）
 * welcome 164×314  欢迎页左侧大图
 * finish  164×314  完成页左侧大图
 */
function makeBrandBitmaps() {
  const header = createCanvas(150, 57);
  fillGradient(header, BRAND_BLUE, BRAND_DEEP);
  drawBrandMark(header, 10, 11, 35, WHITE, BRAND_BLUE);
  drawText(header, 'WorkHub', 55, 21, 2, WHITE);

  const welcome = createCanvas(164, 314);
  fillGradient(welcome, BRAND_BLUE, BRAND_VIOLET);
  drawBrandMark(welcome, 34, 88, 96, WHITE, BRAND_BLUE);
  drawText(welcome, 'WorkHub', 19, 212, 3, WHITE);

  const finish = createCanvas(164, 314);
  fillGradient(finish, BRAND_GREEN, BRAND_GREEN_DEEP);
  drawLine(finish, 50, 158, 76, 186, 6, WHITE);
  drawLine(finish, 76, 186, 116, 128, 6, WHITE);
  drawText(finish, 'WorkHub', 19, 212, 3, WHITE);

  return {
    header: encodeBmp(header),
    welcome: encodeBmp(welcome),
    finish: encodeBmp(finish),
  };
}

module.exports = { makeTrayImages, makeIconIco, makeBrandBitmaps };
