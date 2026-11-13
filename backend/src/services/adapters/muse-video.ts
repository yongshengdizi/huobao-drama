import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export class MuseVideoAdapter implements VideoProviderAdapter {
  provider = 'muse2api'
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('Muse 视频需要提示词')
    if (record.lastFrameUrl || record.referenceVideoUrls || record.referenceAudioUrls || record.referenceFileUrl || record.referenceLinkUrl) {
      throw new Error('Muse 视频暂不支持这些参考素材类型或尾帧，请移除后重试')
    }
    let refs: string[] = []
    if (record.referenceImageUrls) {
      try { const parsed = JSON.parse(record.referenceImageUrls); if (Array.isArray(parsed)) refs = parsed.filter((v: unknown) => typeof v === 'string' && v) } catch { throw new Error('参考图片格式无效') }
    }
    const images = [...new Set([record.firstFrameUrl || record.imageUrl, ...refs].filter((v): v is string => !!v))]
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'), method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: { model: record.model || config.model || 'muse-video', prompt, ...(record.duration ? { duration: record.duration } : {}), ...(record.aspectRatio ? { aspect_ratio: record.aspectRatio } : {}), ...(images.length ? { images } : {}) },
    }
  }
  parseGenerateResponse(result: any): VideoGenResponse {
    const id = result.task_id || result.id
    if (!id) throw new Error('Muse 未返回视频任务 ID')
    return { isAsync: true, taskId: String(id) }
  }
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return { url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${encodeURIComponent(taskId)}`), method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, body: undefined }
  }
  parsePollResponse(result: any): VideoPollResponse {
    if (result.status === 'completed') {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl ? { status: 'completed', videoUrl } : { status: 'failed', error: 'Muse 视频任务完成但没有返回视频地址' }
    }
    if (['failed', 'cancelled'].includes(result.status)) return { status: 'failed', error: typeof result.error === 'string' ? result.error : result.error?.message || 'Muse 视频生成失败' }
    return { status: result.status === 'queued' || result.status === 'pending' ? 'pending' : 'processing' }
  }
  extractVideoUrl(result: any): string | null { return result.url || result.video?.url || result.result?.url || null }
}
