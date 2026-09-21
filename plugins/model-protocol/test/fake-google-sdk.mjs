// 伪 @google/genai：仅用于测试注入（`CHRONO_MODEL_SDK_MODULE`），不依赖真实 SDK 与真实网络。
// 把调用参数编码进回包文本，便于测试断言请求编解码；构造时校验 apiKey 是否按预期传入。
// `FAKE_GOOGLE_FAIL_TIMES=N`：前 N 次流式调用先发一个分片再抛错（模拟流断重试）。

let streamCalls = 0

export class GoogleGenAI {
  constructor(options) {
    const expected = process.env.FAKE_GOOGLE_KEY
    if (expected !== undefined && options?.apiKey !== expected) {
      throw new Error('unexpected apiKey')
    }
    const self = this
    this.models = {
      async *generateContentStream(params) {
        self.lastParams = params
        streamCalls += 1
        const failures = Number(process.env.FAKE_GOOGLE_FAIL_TIMES ?? '0')
        if (streamCalls <= failures) {
          yield { text: 'partial' }
          throw new Error('stream broken')
        }
        yield { text: JSON.stringify(params) }
        yield { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
      },
      async generateContent(params) {
        self.lastParams = params
        return { text: 'complete', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
      },
    }
  }
}

export default { GoogleGenAI }
