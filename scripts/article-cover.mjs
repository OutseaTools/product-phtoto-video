// 文章封面：从竖屏视频里截 1–3 帧并排放在模糊背景上，输出 1200×630 的 JPG（og:image 的尺寸，见 site.seo.ogImageSize）。
// 用法（需要本机 ffmpeg）：
//   node scripts/article-cover.mjs public/guides/neon-shuffle-ai-trend.jpg public/demo/original.mp4@1.5 public/demo/ai1.mp4@2
// 每个输入写成 <视频>@<秒>，也可以是图片（如示例照片，写 @0）；背景取第一帧。生成后在 site.articles 对应文章里填 cover: '/guides/<文件名>'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const W = 1200
const H = 630
const FRAME_H = 570
const GAP = 24
const IMAGE = /\.(jpe?g|png|webp)$/i

const [out, ...inputs] = process.argv.slice(2)
if (!out || !/\.jpe?g$/i.test(out) || inputs.length < 1 || inputs.length > 3) {
  console.error('用法：node scripts/article-cover.mjs <输出.jpg> <视频@秒> [<视频@秒> …]（1–3 帧）')
  process.exit(1)
}

const frames = inputs.map((input) => {
  const match = /^(.+)@(\d+(?:\.\d+)?)$/.exec(input)
  if (!match) {
    console.error(`输入要写成 <视频>@<秒>：${input}`)
    process.exit(1)
  }
  return { file: match[1], at: match[2] }
})

// 竖屏 9:16 帧缩到 FRAME_H 高，宽度取偶数
const frameW = Math.round((FRAME_H * 9) / 16 / 2) * 2
const totalW = frames.length * frameW + (frames.length - 1) * GAP
const x0 = Math.round((W - totalW) / 2)
const y = Math.round((H - FRAME_H) / 2)

// 每路输入的时间戳归零（seek 后首帧可能不在 0，overlay 会漏画）；第一帧同时用作背景，显式 split
const filters = [
  '[0:v]setpts=PTS-STARTPTS,split[bgsrc][first]',
  `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,eq=brightness=-0.18[bg]`,
]
frames.forEach((_, i) => filters.push(`[${i ? `${i}:v` : 'first'}]setpts=PTS-STARTPTS,scale=${frameW}:${FRAME_H}:force_original_aspect_ratio=increase,crop=${frameW}:${FRAME_H}[f${i}]`))
let last = 'bg'
frames.forEach((_, i) => {
  filters.push(`[${last}][f${i}]overlay=${x0 + i * (frameW + GAP)}:${y}[o${i}]`)
  last = `o${i}`
})
// 输入里有照片（JPG 是全范围 YUV）时，mjpeg 编码器要求统一成 yuvj420p
filters.push(`[${last}]format=yuvj420p[out]`)

mkdirSync(dirname(out), { recursive: true })
// ffmpeg 没取到帧时也会以 0 退出，先删掉旧文件，事后检查是否生成
rmSync(out, { force: true })
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // 图片（如示例照片）循环成视频流，否则和视频帧合成时拿不到画面；秒数对图片无意义
    ...frames.flatMap(({ file, at }) => (IMAGE.test(file) ? ['-loop', '1', '-i', file] : ['-ss', at, '-i', file])),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-q:v',
    '4',
    out,
  ],
  { stdio: 'inherit' },
)
if (!existsSync(out)) {
  console.error(`没有生成 ${out}：检查秒数是否超出视频时长`)
  process.exit(1)
}
console.log(`已生成 ${out}（${W}×${H}）`)
