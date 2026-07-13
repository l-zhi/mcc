// 图片读取，裁剪自参考 readImageWithTokenBudget。
// 参考实现有 sharp 降采样 + token 预算压缩两级管线，这里未移植（原图直传），
// 只保留大小护栏；压缩管线留作后续迭代。
import { readFile } from 'fs/promises'
import { formatFileSize } from '../../utils/file.js'

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

// 原图直传没有压缩兜底，超过此值直接报错（base64 后 ~33% 膨胀会顶爆请求体）
const MAX_IMAGE_SIZE = 5 * 1024 * 1024

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export type ImageReadResult = {
  /** data URI，直接用于 OpenAI image_url 内容块 */
  dataUrl: string
  mediaType: string
  originalSize: number
}

export async function readImage(
  filePath: string,
  ext: string,
): Promise<ImageReadResult> {
  const buffer = await readFile(filePath)
  if (buffer.length === 0) {
    throw new Error(`Image file is empty: ${filePath}`)
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image file (${formatFileSize(buffer.length)}) exceeds maximum allowed size (${formatFileSize(MAX_IMAGE_SIZE)}). ` +
        'Image compression is not implemented yet; please provide a smaller image.',
    )
  }
  const mediaType = EXT_TO_MEDIA_TYPE[ext] ?? 'image/png'
  return {
    dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
    mediaType,
    originalSize: buffer.length,
  }
}
