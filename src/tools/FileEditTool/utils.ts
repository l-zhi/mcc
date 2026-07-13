// Edit 工具的核心字符串替换逻辑，逐字 copy 自参考项目 src/tools/FileEditTool/utils.ts。
// 保留：卷曲引号归一（normalizeQuotes / findActualString / preserveQuoteStyle）
//      与实际替换（applyEditToFile）。
// 未移植：getPatchForEdit / getSnippet* 等——它们依赖 `diff` 包生成给 UI 展示的
//        结构化 patch，mini 的工具结果只回文本、不做 diff 渲染。这里用 applyEdit
//        承接参考 getPatchForEdits 的「应用 + 空改动/未命中防护」职责（不产 patch）。

// 模型无法直接输出卷曲引号，这里定义成常量供代码使用；
// 应用编辑时会把卷曲引号归一为直引号。
export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

/** 把卷曲引号归一为直引号 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * 在文件内容中找到与搜索串匹配的实际字符串，兼容卷曲引号归一。
 * @returns 文件中实际匹配到的字符串，找不到返回 null
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // 先精确匹配
  if (fileContent.includes(searchString)) {
    return searchString
  }

  // 再按引号归一后匹配
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 返回文件里对应位置的原始字符串
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}

/**
 * 当 old_string 是靠引号归一才匹配上的（文件里是卷曲引号、模型给的是直引号），
 * 给 new_string 套上同样的卷曲引号风格，让编辑保持文件原有排版。
 *
 * 用简单的开/闭启发式：引号字符前面是空白、字符串开头或开括号 → 视为开引号，
 * 否则视为闭引号。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // 相同说明没发生归一
  if (oldString === actualOldString) {
    return newString
  }

  // 检测文件里用到了哪种卷曲引号
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }

  return result
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true
  }
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '—' || // em dash
    prev === '–' // en dash
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // 不要把缩写里的撇号（如 "don't"、"it's"）转成引号：
      // 夹在两个字母之间的撇号是缩写，不是引号
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        // 缩写里的撇号 → 用右单卷曲引号
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * 在文件内容上做一次替换（逐字 copy 自参考 applyEditToFile）。
 * 用函数式 replacer 避免 new_string 里的 $ 被当成替换模式特殊字符。
 * new_string 为空（删除）时，若 old_string 后面紧跟换行，连换行一起删，避免留空行。
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * 应用一次编辑并返回新内容，承接参考 getPatchForEdits 的「应用 + 防护」职责
 * （去掉了给 UI 用的结构化 patch 生成）。空改动 / 未命中会抛错，交给 query 层回给模型。
 */
export function applyEdit({
  fileContents,
  oldString,
  newString,
  replaceAll = false,
}: {
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): string {
  // 空文件 + old/new 都为空 → 保持空（对齐参考对空文件的特判）
  if (!fileContents && oldString === '' && newString === '') {
    return ''
  }

  const updatedFile =
    oldString === ''
      ? newString
      : applyEditToFile(fileContents, oldString, newString, replaceAll)

  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

  return updatedFile
}
