// 文件名 glob，裁剪自参考项目 src/utils/glob.ts（130 行）。
// 保留：extractGlobBaseDirectory（绝对路径 glob 拆 baseDir + 相对 pattern，
//      因为 rg --glob 只认相对 pattern）、rg --files --glob --sort=modified、
//      相对路径转绝对、limit/offset 截断 + truncated 标记。
// 桩化/简化：权限 ignore 注入、插件缓存排除（mini 无这两个子系统）；
//          --no-ignore / --hidden 的环境变量开关直接写死为 true（对齐参考默认值）。
import { isAbsolute, join, sep } from 'path'
import { ripGrep } from './ripgrep.js'

/**
 * 从 glob pattern 里抽出静态基目录：第一个 glob 特殊字符（* ? [ {）之前的部分。
 * 返回 baseDir 与其后的相对 pattern。copy 自参考 extractGlobBaseDirectory。
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // 没有 glob 字符——当成字面路径，切成目录 + 文件名
    const lastSep = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf(sep))
    if (lastSep === -1) return { baseDir: '', relativePattern: pattern }
    return {
      baseDir: pattern.slice(0, lastSep),
      relativePattern: pattern.slice(lastSep + 1),
    }
  }

  const staticPrefix = pattern.slice(0, match.index)
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // glob 字符前没有路径分隔符——pattern 相对 cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)
  // 根目录形态（/*.txt）：lastSepIndex 为 0 时 baseDir 空，用 '/' 兜底
  if (baseDir === '' && lastSepIndex === 0) baseDir = '/'

  return { baseDir, relativePattern }
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // 绝对路径 pattern：抽 baseDir 转相对，因为 rg --glob 只吃相对 pattern
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  // --files: 列文件而非搜内容；--glob: 按 pattern 过滤；
  // --sort=modified: 按修改时间排序；--no-ignore: 不理会 .gitignore；--hidden: 含隐藏文件
  // （参考实现这两个开关受环境变量控制，mini 写死为参考的默认值 true）
  const args = [
    '--files',
    '--glob',
    searchPattern,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
  ]

  const allPaths = await ripGrep(args, searchDir)

  // rg 返回相对路径，统一转绝对
  const absolutePaths = allPaths.map(p => (isAbsolute(p) ? p : join(searchDir, p)))

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated }
}
