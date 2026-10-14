import Anthropic from '@anthropic-ai/sdk'
import { providerRequestHeaders } from '@shared/lib/provider-request-headers'
import { resolveLightModel } from '@shared/lib/model-slots'
import { getApiKey } from '../secrets.ts'
import { readCurrentConfig } from '../ipc/inputs.ts'
import type { TextReuseFinding } from './text-reuse-scan.ts'

const LEARN_REWRITE_SYSTEM_PROMPT =
  '你是写作方法编辑。下面这张能力卡的正文与源书原文过近。请只重写正文中与原文重合的表述，用抽象的方法语言替换具体文字，保留 [runtime]/[evidence] 分区结构与原有含义。只输出重写后的完整卡正文，不加任何解释。'

/** 贴原文重写：直连 @anthropic-ai/sdk 一次性调用（照 pack-compile.ts:255 的调用模式），模型走
 * resolveLightModel 解析的轻量槽（未验证/跨端点失配时 fail-soft 回落主力槽），max_tokens 2048。
 * 调用失败或输出为空一律返 null——学习编排按丢弃处理，不因重写失败中断整条流程。 */
export async function rewriteCardBody(input: { body: string; findings: TextReuseFinding[] }): Promise<string | null> {
  const config = await readCurrentConfig()
  const light = resolveLightModel(config)
  const apiKey = light ? await getApiKey(light.provider) : null
  if (!apiKey) return null
  const model = light?.modelId
  if (!model) return null

  const client = new Anthropic({ apiKey, baseURL: light?.baseUrl || undefined, defaultHeaders: providerRequestHeaders(light?.baseUrl) })
  const samples = input.findings.map((finding, index) => `${index + 1}. ${finding.sample}`).join('\n')
  try {
    const response = await client.messages.create({
      model,
      system: LEARN_REWRITE_SYSTEM_PROMPT,
      max_tokens: 2048,
      messages: [{ role: 'user', content: `${input.body}\n\n---\n命中样例：\n${samples}` }],
    })
    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }
    text = text.trim()
    return text || null
  } catch (error) {
    console.error('学习卡重写调用失败：', error)
    return null
  }
}
