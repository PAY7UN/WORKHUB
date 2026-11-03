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

module.exports = { makeTrayImages, makeIconIco };
