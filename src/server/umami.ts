// Umami 同域代理：页面只加载本站的 /s/script.js，上报也发到 /s/api/send，
// 实例地址（UMAMI_ORIGIN）只存在于 Worker，网页源码和 JS 里看不到

const SCRIPT_PATH = '/s/script.js'
const SEND_PATH = '/s/api/send'
const MAX_BODY_BYTES = 16 * 1024
const UPSTREAM_TIMEOUT_MS = 5000

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

// 不匹配 /s/script.js、/s/api/send 时返回 undefined，交给原有逻辑
export function handleUmamiProxy(request: Request, env: Env): Promise<Response> | undefined {
  const { pathname } = new URL(request.url)
  if (pathname !== SCRIPT_PATH && pathname !== SEND_PATH) return undefined
  const isScript = pathname === SCRIPT_PATH
  const allowed = isScript ? request.method === 'GET' || request.method === 'HEAD' : request.method === 'POST'
  if (!allowed) return Promise.resolve(text('Method not allowed', 405, { Allow: isScript ? 'GET, HEAD' : 'POST' }))
  const origin = (env.UMAMI_ORIGIN ?? '').trim().replace(/\/+$/, '')
  if (!origin) return Promise.resolve(text('Not found', 404))
  return isScript ? proxyScript(origin) : proxySend(request, origin)
}

async function proxyScript(origin: string): Promise<Response> {
  try {
    const upstream = await fetch(`${origin}/script.js`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // 脚本很少变，让 Cloudflare 边缘缓存一天，减少对实例的请求
      cf: { cacheTtl: 86400, cacheEverything: true },
    })
    if (!upstream.ok) {
      console.warn('[umami] script upstream status', upstream.status)
      return text('Bad gateway', 502)
    }
    // 只保留 Content-Type，其它上游头会暴露后端
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-Robots-Tag': 'noindex',
      },
    })
  } catch (error) {
    console.warn('[umami] script upstream failed', error instanceof Error ? error.name : 'unknown')
    return text('Bad gateway', 502)
  }
}

async function proxySend(request: Request, origin: string): Promise<Response> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return text('Payload too large', 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return text('Invalid JSON', 400)
  }
  const payload = isObject(body) ? body.payload : undefined
  if (!isObject(body) || !isObject(payload)) return text('Invalid payload', 400)
  // Umami 看到 payload.ip 会用它查国家、计算访客；不写则会用 Worker 的出口 IP。本地开发没有这个头。
  // 带 payload.ip 时 Umami 跳过请求头里的地区信息、改查 GeoLite2 库，实例没有库会返回 500（Vercel 上要设 BUILD_GEO=1）。
  // 不能改用 CF-IPCountry 请求头：Worker 发往非 Cloudflare 源站时它会被删掉，Vercel 的 x-vercel-ip-country 又只反映 Worker 出口
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) payload.ip = ip
  // 请求头白名单：绝不能转发 Cookie、Authorization（站点登录态不能发给第三方）
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const userAgent = request.headers.get('User-Agent')
  if (userAgent) headers['User-Agent'] = userAgent
  const cache = request.headers.get('x-umami-cache')
  if (cache) headers['x-umami-cache'] = cache
  try {
    const upstream = await fetch(`${origin}/api/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    // 响应只保留状态码、body 和 Content-Type
    const responseHeaders: Record<string, string> = { 'Cache-Control': 'no-store' }
    const contentType = upstream.headers.get('Content-Type')
    if (contentType) responseHeaders['Content-Type'] = contentType
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (error) {
    // 日志和响应都不带 UMAMI_ORIGIN
    console.warn('[umami] send upstream failed', error instanceof Error ? error.name : 'unknown')
    return text('Bad gateway', 502)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
