/**
 * computer_use 的 clean-room 最小可用子集（Windows，2026-09）。
 *
 * 按 bridge.ts 的 ComputerUseImpl 契约独立实现：createComputerUseTool /
 * createPlatformDriver / isComputerUsePlatform 三个命名导出（bridge 动态
 * import 后按模块命名空间消费）。闭源边界：不复制闭源驱动，仅用 Windows
 * 公开的 PowerShell/.NET 能力（截图 CopyFromScreen、user32 鼠标、SendKeys
 * 键盘、窗口枚举/聚焦/启动）实现核心动作；浏览器 CDP / UIA 可访问性树的
 * 高级动作（navigate/read_page/js_eval/tabs/browser_adopt 及基于 ref 的
 * 元素定位）在本子集内 fail-closed 报「未实现」，不做静默降级。
 *
 * 定位：让 CLI 侧 computer_use 工具可被注册并对「截图/点击/输入/滚动/窗口
 * 管理」这些桌面自动化基本功给出真实可用的最小实现；完整 UIA 树与 CDP 后端
 * 属桌面端 Pro 驱动，超出本 clean-room 子集范围。
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Tool, ToolCallParams, ToolResult } from '../../tools/types.js'
import { isAppGranted } from '../../tools/computer-use/app-grants.js'

const execFileAsync = promisify(execFile)

/** 能力探针与纯 sleep 免审批（与 stub.ts 的 NO_APPROVAL_ACTIONS 对齐）。 */
const NO_APPROVAL_ACTIONS = new Set(['check_permissions', 'wait'])
/** 任意代码执行 / 端点接管面——授权表永不免审。 */
const ALWAYS_APPROVE_ACTIONS = new Set(['js_eval', 'browser_adopt'])

// ---------------------------------------------------------------------------
// 平台判定 / 驱动
// ---------------------------------------------------------------------------

export function isComputerUsePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

async function pwsh(script: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  return { stdout, stderr }
}

/** 截取主屏 → 临时 PNG，返回字节。 */
async function capturePrimaryScreenPng(): Promise<Buffer> {
  const pngPath = join(tmpdir(), `rivet-cu-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  const winPath = pngPath.replace(/\\/g, '\\\\')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
    `$bmp.Save('${winPath}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$bmp.Dispose()',
  ].join('; ')
  const { stderr } = await pwsh(script)
  if (stderr.trim()) throw new Error(stderr.trim().split('\n')[0])
  return readFile(pngPath)
}

export function createPlatformDriver(platform?: NodeJS.Platform): {
  checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean; detail: string }>
} {
  void platform
  return {
    async checkPermissions() {
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        return { accessibility: false, screenRecording: false, detail: `平台 ${process.platform} 不支持 computer_use` }
      }
      // Windows 无需像 macOS 那样单独授权屏幕录制；CopyFromScreen 一般可用。
      // accessibility 以能枚举窗口标题为准（最小子集不依赖 UIA 树）。
      let screenRecording = false
      let detail = ''
      try {
        await capturePrimaryScreenPng()
        screenRecording = true
        detail = '屏幕捕获可用'
      } catch (e) {
        detail = `屏幕捕获不可用：${(e as Error).message}`
      }
      return { accessibility: process.platform === 'win32', screenRecording, detail }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function createComputerUseTool(options?: Record<string, unknown>): Tool {
  void options
  /** W4-13：本会话 list_apps 已获批执行过（进程内，不落盘）。 */
  let listAppsApproved = false

  return {
    definition: {
      name: 'computer_use',
      description: `操作桌面图形应用（Windows 最小可用子集）：截图、点击/滚动、输入文本、发送组合键、聚焦/启动应用、枚举窗口标题。仅当 CLI 工具、MCP 服务或结构化集成无法完成任务时使用（如无 API 的原生应用、纯 GUI 设置、或复现 UI-only bug）——有结构化工具时优先用结构化工具。

对应用的每个操作都需要人工审批，除非该应用已被授予"始终允许"。截图保存为可查看的 artifact。

操作（本子集已实现）：
- check_permissions：报告屏幕捕获/能力状态（无需审批）。
- list_apps：列出带窗口标题的可见应用。
- snapshot(app)：截取主屏并返回截图 artifact + 窗口标题列表（本子集用窗口标题近似可访问性树，不提供编号 ref 元素树）。
- click(app, x, y) / double_click(app, x, y) / right_click(app, x, y)：在屏幕坐标点击。
- scroll(app, direction, amount?)：在窗口中心滚动滚轮。
- type(app, text)：向聚焦字段输入文本（短 ASCII）。
- key(app, combo)：发送组合键如 "ctrl+s" 或 "return"。
- wait(duration_ms)：暂停最多 5000ms（无需审批）。
- focus_app(app)：将窗口带到前台。
- launch_app(app)：启动未运行的应用（已在运行时则聚焦它）。
- paste_text(app, text)：将文本放入剪贴板并粘贴。

未实现（fail-closed 报错）：find / wait_for 的编号元素树定位、drag、set_value、menu_select，以及浏览器 CDP 快路径（navigate/read_page/js_eval/tabs/browser_adopt）——这些依赖完整 UIA 树或 CDP 后端，属桌面端 Pro 驱动。`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'click', 'double_click', 'right_click', 'scroll', 'type', 'key', 'wait', 'focus_app', 'launch_app', 'paste_text', 'find', 'wait_for', 'drag', 'set_value', 'menu_select', 'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt'],
            description: '要执行的操作。',
          },
          app: { type: 'string', description: '目标应用名称（除 list_apps/check_permissions/wait 外所有操作必需）。' },
          x: { type: 'number', description: 'X 坐标（屏幕像素）。' },
          y: { type: 'number', description: 'Y 坐标（屏幕像素）。' },
          text: { type: 'string', description: '要输入（type）或粘贴（paste_text）的文本。' },
          combo: { type: 'string', description: '组合键如 "ctrl+s"、"shift+ctrl+4"、"return"（key 操作）。' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（scroll 操作）。' },
          amount: { type: 'number', description: '滚动幅度，滚轮行数 1-50（默认 5）。' },
          duration_ms: { type: 'number', description: '等待时长毫秒数，上限 5000（wait 操作）。' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = String(params.input.action ?? '')
      const app = typeof params.input.app === 'string' ? params.input.app.trim() : ''
      try {
        switch (action) {
          case 'check_permissions': {
            const driver = createPlatformDriver()
            const p = await driver.checkPermissions()
            return { content: JSON.stringify(p, null, 2) }
          }
          case 'wait': {
            const ms = Math.min(Number(params.input.duration_ms ?? 500) || 500, 5000)
            await new Promise(r => setTimeout(r, ms))
            return { content: `已等待 ${ms}ms` }
          }
          case 'list_apps': {
            const titles = await listWindowTitles()
            const out = titles.length ? titles.map((t, i) => `${i + 1}. ${t}`).join('\n') : '（未检测到带窗口标题的可见应用）'
            listAppsApproved = true // W4-13：首次成功执行后本会话豁免审批
            return { content: out }
          }
          case 'snapshot': {
            if (!app) return { content: 'snapshot 需要 app 参数', isError: true }
            const png = await capturePrimaryScreenPng()
            const titles = await listWindowTitles()
            const dataUrl = `data:image/png;base64,${png.toString('base64')}`
            const tree = titles.filter(t => t.toLowerCase().includes(app.toLowerCase())).map(t => `· ${t}`).join('\n')
            return {
              content: `已截取主屏（${png.length} 字节）。\n\n【窗口标题近似树】（本子集不含编号 ref 元素树）\n${tree || '（未匹配到目标应用窗口）'}`,
              images: [dataUrl],
            }
          }
          case 'click':
          case 'double_click':
          case 'right_click': {
            const x = toInt(params.input.x)
            const y = toInt(params.input.y)
            if (x == null || y == null) return { content: `${action} 需要 x/y 坐标`, isError: true }
            await mouseClick(x, y, action)
            return { content: `已在 (${x}, ${y}) 执行 ${action}` }
          }
          case 'scroll': {
            const dir = String(params.input.direction ?? 'down')
            const amount = Math.min(Math.max(toInt(params.input.amount) ?? 5, 1), 50)
            await mouseScroll(dir, amount)
            return { content: `已在窗口中心 ${dir} 滚动 ${amount} 行` }
          }
          case 'type': {
            const text = String(params.input.text ?? '')
            if (!text) return { content: 'type 需要 text 参数', isError: true }
            await sendKeys(text, { raw: true })
            return { content: `已输入文本` }
          }
          case 'key': {
            const combo = String(params.input.combo ?? '')
            if (!combo) return { content: 'key 需要 combo 参数', isError: true }
            await sendKeys(combo, { raw: false })
            return { content: `已发送组合键 ${combo}` }
          }
          case 'focus_app': {
            if (!app) return { content: 'focus_app 需要 app 参数', isError: true }
            const ok = await focusApp(app)
            return ok ? { content: `已聚焦 ${app}` } : { content: `未找到窗口标题匹配 "${app}" 的进程`, isError: true }
          }
          case 'launch_app': {
            if (!app) return { content: 'launch_app 需要 app 参数', isError: true }
            const already = await focusApp(app)
            if (already) return { content: `${app} 已在运行，已聚焦` }
            await pwsh(`Start-Process ${psQuote(app)}`)
            return { content: `已尝试启动 ${app}` }
          }
          case 'paste_text': {
            const text = String(params.input.text ?? '')
            if (!text) return { content: 'paste_text 需要 text 参数', isError: true }
            await pasteText(text)
            return { content: '已粘贴文本' }
          }
          default: {
            const known = ['find', 'wait_for', 'drag', 'set_value', 'menu_select', 'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt']
            if (known.includes(action)) {
              return { content: `computer_use 操作 "${action}" 在此 clean-room 最小子集未实现（依赖完整 UIA 树或 CDP 后端，属桌面端 Pro 驱动）。`, isError: true }
            }
            return { content: `未知 computer_use 操作 "${action}"`, isError: true }
          }
        }
      } catch (e) {
        return { content: `computer_use 执行失败：${(e as Error).message}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = String(params.input.action ?? '')
      if (NO_APPROVAL_ACTIONS.has(action)) return false
      if (ALWAYS_APPROVE_ACTIONS.has(action)) return true
      const app = typeof params.input.app === 'string' ? params.input.app.trim() : ''
      if (!app) return !(action === 'list_apps' && listAppsApproved)
      return !isAppGranted(app)
    },

    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: (p?: ToolCallParams) => {
      const action = p?.input?.action as string | undefined
      return action === 'snapshot' || action === 'find' || action === 'wait_for' ? 90_000 : 60_000
    },
  }
}

// ---------------------------------------------------------------------------
// Windows 原语（PowerShell/.NET）
// ---------------------------------------------------------------------------

async function listWindowTitles(): Promise<string[]> {
  const { stdout } = await pwsh('Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle | Where-Object { $_ }')
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
}

async function mouseClick(x: number, y: number, action: string): Promise<void> {
  const lines = [
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'",
    `[N.W]::SetCursorPos(${x},${y})`,
  ]
  if (action === 'right_click') {
    lines.push('[N.W]::mouse_event(0x0008,0,0,0,0)', '[N.W]::mouse_event(0x0010,0,0,0,0)')
  } else {
    lines.push('[N.W]::mouse_event(0x0002,0,0,0,0)', '[N.W]::mouse_event(0x0004,0,0,0,0)')
    if (action === 'double_click') {
      lines.push('[N.W]::mouse_event(0x0002,0,0,0,0)', '[N.W]::mouse_event(0x0004,0,0,0,0)')
    }
  }
  await pwsh(lines.join('; '))
}

async function mouseScroll(direction: string, amount: number): Promise<void> {
  const delta = direction === 'up' ? amount * 120 : direction === 'down' ? -amount * 120 : 0
  const script = [
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'",
    `[N.W]::mouse_event(0x0800,0,0,${delta},0)`,
  ].join('; ')
  await pwsh(script)
}

/** SendKeys 特殊字符转义（+ ^ % ~ ( ) { } [ ]）。 */
function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}\[\]])/g, '{$1}')
}

/** combo 转 SendKeys：ctrl→^、alt→%、shift→+、return→{ENTER}，其余键直传。 */
function comboToSendKeys(combo: string): string {
  const key = (k: string): string => {
    const lower = k.toLowerCase()
    if (lower === 'return' || lower === 'enter') return '{ENTER}'
    if (lower === 'tab') return '{TAB}'
    if (lower === 'escape' || lower === 'esc') return '{ESC}'
    if (lower === 'space') return ' '
    if (lower === 'backspace') return '{BACKSPACE}'
    if (lower === 'delete') return '{DELETE}'
    if (lower === 'up' || lower === 'down' || lower === 'left' || lower === 'right') return `{${lower.toUpperCase()}}`
    return k
  }
  return combo.split('+').map(part => {
    const p = part.trim().toLowerCase()
    if (p === 'ctrl' || p === 'cmd' || p === 'control') return '^'
    if (p === 'alt' || p === 'option') return '%'
    if (p === 'shift') return '+'
    return key(part.trim())
  }).join('')
}

async function sendKeys(input: string, opts: { raw: boolean }): Promise<void> {
  const keys = opts.raw ? escapeSendKeys(input) : comboToSendKeys(input)
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})`
  await pwsh(script)
}

async function pasteText(text: string): Promise<void> {
  // 写入剪贴板后发送 Ctrl+V。
  const script = `Set-Clipboard -Value ${psQuote(text)}; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`
  await pwsh(script)
}

async function focusApp(app: string): Promise<boolean> {
  const script = [
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${app.replace(/'/g, "''")}*' } | Select-Object -First 1`,
    'if ($p) { [N.W]::SetForegroundWindow($p.MainWindowHandle); "ok" } else { "none" }',
  ].join('; ')
  const { stdout } = await pwsh(script)
  return stdout.trim().includes('ok')
}

function toInt(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/** 最小安全引用：将字符串包裹成 PowerShell 单引号字面量。 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
