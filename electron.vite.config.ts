import { defineConfig } from 'electron-vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const __dirname = import.meta.dirname
const clientVersion = readClientVersion()
// 构建那一刻的 ISO 时间，注入主进程供「内测硬过期兜底」用（#354，构建后 N 天失效）。
// dev 态每次启动 = 当下，硬过期永远 90 天外，不会误伤开发。
const buildTime = new Date().toISOString()

function readClientVersion(): string {
  return execFileSync(process.execPath, [resolve(__dirname, 'scripts/client-version.mjs')], {
    cwd: __dirname,
    encoding: 'utf8',
  }).trim()
}

export default defineConfig({
  main: {
    define: {
      __NARRACAT_BUILD_TIME__: JSON.stringify(buildTime),
      __NARRACAT_CORPUS_TOKEN__: JSON.stringify(process.env.NARRACAT_CORPUS_TOKEN ?? ''),
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      externalizeDeps: true,
      lib: {
        entry: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'memory-worker': resolve(__dirname, 'electron/main/memory/memory-worker.ts'),
        },
        formats: ['es'],
      },
      rollupOptions: {
        // electron 在 devDependencies 里，externalizeDeps 不会自动 externalize 它
        // 必须手动指定，否则 rolldown 会把 electron/index.js 内联，导致 __dirname 路径错乱
        // better-sqlite3 同理手动指定：即使已在 dependencies 里，rolldown 仍会把它的原生绑定加载逻辑
        // （bindings 包按 __dirname 走目录搜索）内联进 bundle，搬家后 __dirname 语义错乱导致运行期找不到 .node 文件
        // pi 双包手动 externalize：内联会把 pi-ai 的 provider SDK 依赖树（@mistralai 等的可选 peer
        // @opentelemetry/api）拉进 bundle 导致构建失败，运行时从 node_modules 解析即可。
        // electron-updater 手动 externalize：它运行时要读打包进 Resources 的 app-update.yml、
        // 并 spawn 平台安装器，属于与 keytar / better-sqlite3 同类的「有运行时文件与进程行为」的包，
        // 内联进 ESM bundle 要多做一层 CJS 转换、徒增静默失效面。运行时从 node_modules 解析即可
        // （electron-builder 会把 dependencies 打进 asar）。
        // 注意：本仓 externalizeDeps: true 实测不会外部化普通 dependencies，必须列在这里才生效。
        external: [
          'electron',
          'keytar',
          'better-sqlite3',
          'electron-updater',
          '@mariozechner/pi-ai',
          '@mariozechner/pi-coding-agent',
        ],
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      externalizeDeps: true,
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.cts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        external: ['electron'],
        output: {
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname),
    plugins: [viteReact(), tailwindcss()],
    define: {
      __NARRACAT_CLIENT_VERSION__: JSON.stringify(clientVersion),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  },
})
