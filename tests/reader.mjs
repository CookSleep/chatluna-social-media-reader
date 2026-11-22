import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, apply } from 'chatluna-plugin-social-media-reader'

async function setup(overrides = {}, transforms = new Map()) {
    let tool
    const ctx = {
        transform: { element(type, handler) { transforms.set(type, handler) } },
        tools: { define(value) { tool = value } }, model: { extend() {} },
        get() { return undefined }, logger: { warn() {}, debug() {} }
    }
    await apply(ctx, Config({ cache: { enabled: false }, xiaohongshu: { maxRetries: 1 }, ...overrides }))
    return tool
}

const share = 'https://www.xiaohongshu.com/explore/601a87f50000000001000a07'
const image = 'https://sns-img-bd.xhscdn.com/test.jpg'
const note = { title: '图文测试', desc: '正文', user: { nickname: '作者' }, imageList: [{ urlDefault: image }] }
const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify({ note: { noteDetailMap: { ['601a87f50000000001000a07']: { note }, other: { note: { title: '错误笔记' } } } } }) + '</script>'
test('读取指定笔记的正文和图片附件', async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => new Response(html))
    const tool = await setup()
    const notes = []
    const result = await tool.run({ url: share }, { signal: new AbortController().signal, note: m => notes.push(m) })
    assert.equal(result.author, '作者')
    assert.equal(result.content, '正文')
    assert.equal(notes[0].content[0].data.url, image)
    assert.equal(request.mock.callCount(), 1)
})

test('关闭工具后不注册工具', async () => {
    assert.equal(await setup({ tool: { enabled: false } }), undefined)
})

test('停用的平台、相似域名和已取消的调用均不发请求', async t => {
    const tool = await setup({ bilibili: { enabled: false } })
    const request = t.mock.method(globalThis, 'fetch', () => { throw Error('不应产生请求') })
    for (const url of ['https://bilibili.com.example.org/video/test', 'https://www.bilibili.com/video/BV17x411w7KC']) {
        await assert.rejects(tool.run({ url }, {}), /不受支持或该平台已停用/)
    }
    await assert.rejects(tool.run({ url: share }, { signal: AbortSignal.abort() }), { name: 'AbortError' })
    assert.equal(request.mock.callCount(), 0)
})

test('工具拒绝跨平台短链跳转', async t => {
    const tool = await setup()
    const request = t.mock.method(globalThis, 'fetch', async () => Response.redirect('https://example.org/post'))
    await assert.rejects(tool.run({ url: 'https://xhslink.com/a/demo' }, {}), /不支持的域名/)
    assert.equal(request.mock.callCount(), 1)
})

test('分享卡片按两行格式展示，预览只使用卡片自身的内容', async t => {
    const handlers = new Map()
    await setup({}, handlers)
    const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('卡片预览不应发起请求'))
    const bilibili = 'https://b23.tv/demo'
    const json = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '视频标题', qqdocurl: bilibili } } })
    assert.equal(handlers.get('onebot:json')({ attrs: { data: json } }).text, '【视频标题-哔哩哔哩】\n' + bilibili)
    for (const data of [
        { fields: { title: '笔记', url: share } },
        { kv: [{ key: '#TITLE#', value: '笔记' }, { key: '#LINK#', value: share }] }
    ]) {
        assert.equal(handlers.get('qq:json')({ attrs: { data } }).text, '【笔记-小红书】\n' + share)
    }
    const xml = '<msg url="' + share + '" brief="分享"><item><title>笔记标题</title></item></msg>'
    assert.equal(handlers.get('onebot:xml')({ attrs: { data: xml } }).text, '【笔记标题-小红书】\n' + share)
    assert.equal(handlers.get('qq:share')({ attrs: { title: '笔记', url: share } }).text, '【笔记-小红书】\n' + share)
    assert.equal(handlers.get('onebot:share')({ attrs: { title: '其它', url: 'https://example.com' } }), undefined)
    assert.equal(fetch.mock.callCount(), 0)
})
