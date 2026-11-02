/**
 * marked 的全局配置与扩展。
 *
 * 单独成模块是为了让渲染端与测试共用同一份实现——往返保真的测试
 * 必须跑在和浏览器完全相同的解析规则上，否则测出来的"保真"是假的。
 */
import { marked, type Tokens } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * 补 marked 缺失的上下标语法。
 *
 * marked 的 GFM 实现里两者都不成立，必须自己加扩展：
 * - `^x^` 没有任何内置规则匹配，会原样输出字面量
 * - `~x~` 会被 del（删除线）规则吃掉，实测 `~x~` 渲染成 <del>x</del>，
 *   所以「下标」按钮插入的内容在预览里会显示成删除线
 *
 * 扩展的 inline tokenizer 先于内置规则执行，故 `~x~` 归下标所有。
 * 删除线因此只剩 GFM 标准的双波浪 `~~x~~`，两条语义不再抢同一个字符。
 *
 * 代价：`$x^2$` 这类行内公式里的孤立 `^` 可能被误判成上标。本项目是文档
 * 排版场景、不渲染公式，这个取舍可以接受；真要上公式得引入 katex 扩展接管优先级。
 */
marked.use({
  extensions: [
    {
      name: 'superscript',
      level: 'inline',
      start(src: string) {
        return src.indexOf('^');
      },
      tokenizer(src: string) {
        // 首尾标记后必须紧跟非空白，且内容不得含标记本身与换行
        const m = /^\^([^\s^][^^]*?)\^/.exec(src);
        // tokens 必填：renderer 里不能把原始字符串丢回 parseInline，
        // 它会按字符遍历该字符串并把每个字符当 token，直接抛 undefined type。
        // this.lexer 由 marked 在调用 tokenizer 时挂上。
        if (m) return { type: 'superscript', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        return undefined;
      },
      renderer(token: Tokens.Generic) {
        return `<sup>${this.parser.parseInline(token.tokens ?? [])}</sup>`;
      },
    },
    {
      name: 'subscript',
      level: 'inline',
      start(src: string) {
        return src.indexOf('~');
      },
      tokenizer(src: string) {
        // 开头用 [^\s~] 排除双波浪：`~~x~~` 不会被这里截胡，仍走内置 del
        const m = /^~([^\s~][^~]*?)~/.exec(src);
        if (m) return { type: 'subscript', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        return undefined;
      },
      renderer(token: Tokens.Generic) {
        return `<sub>${this.parser.parseInline(token.tokens ?? [])}</sub>`;
      },
    },
  ],
});
