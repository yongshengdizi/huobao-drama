import assert from 'node:assert/strict'
import { videoPromptPolicy } from './src/agents/video-prompt-policy'
assert.match(videoPromptPolicy('muse'), /Muse 专用/)
assert.match(videoPromptPolicy('muse'), /不强制每三秒/)
assert.match(videoPromptPolicy('muse_skill'), /六段式方案/)
assert.doesNotMatch(videoPromptPolicy('muse'), /六段式方案/)
assert.equal(videoPromptPolicy('other'), '')
assert.equal(videoPromptPolicy(), '')
console.log('video prompt mode policy checks passed')
