import assert from 'node:assert/strict'
import { MuseVideoAdapter } from './src/services/adapters/muse-video'
const adapter = new MuseVideoAdapter()
const config = { provider: 'muse2api', baseUrl: 'http://127.0.0.1:18610/v1', apiKey: 'fixture', model: 'muse-video' }
const req = adapter.buildGenerateRequest(config, { id: 1, prompt: 'test', firstFrameUrl: 'data:image/png;base64,YQ==', duration: 5, aspectRatio: '16:9' })
assert.equal(req.url, 'http://127.0.0.1:18610/v1/videos')
assert.deepEqual(req.body.images, ['data:image/png;base64,YQ=='])
assert.equal(adapter.parseGenerateResponse({ task_id: 't1' }).taskId, 't1')
assert.equal(adapter.buildPollRequest(config, 't/1').url, 'http://127.0.0.1:18610/v1/videos/t%2F1')
assert.deepEqual(adapter.parsePollResponse({ status: 'completed', url: 'http://example.test/video.mp4' }), { status: 'completed', videoUrl: 'http://example.test/video.mp4' })
assert.equal(adapter.parsePollResponse({ status: 'failed', error: 'failed' }).error, 'failed')
assert.throws(() => adapter.buildGenerateRequest(config, { id: 1, prompt: 'test', lastFrameUrl: 'x' }))
console.log('Muse video contract checks passed')
