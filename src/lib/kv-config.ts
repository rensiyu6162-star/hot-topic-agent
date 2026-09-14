// 存储后端是否"已配置"的轻量判断。
// 本地 JSON KV 永远就绪（不依赖任何 Node 模块），所以直接 true。
// 这个文件被 scheduler.ts 和 schedule/route.ts 静态 import，
// 必须保证零依赖才能不触发 Next.js 客户端 Webpack 的 Node 模块检查。

export function kvConfigured(): boolean {
  return true;
}
