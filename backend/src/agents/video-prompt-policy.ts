/** Prompt guidance derived from documented patterns, not copied example prompts. */
export type VideoPromptMode = 'muse' | 'muse_skill' | 'other'
export function videoPromptPolicy(mode?: VideoPromptMode): string {
  if (mode !== 'muse' && mode !== 'muse_skill') return ''
  const structured = `\n【六段式方案】按需组织时长与画幅、人物、场景、时间线动作、镜头、声音对白和限制；每段只写与当前分镜相关的信息。保持人物服装、外貌和场景连续，人物描述在多段中尽量一致。只使用实际已提供的音频和素材，不指定默认口音，不假设模型支持快照续接或自动拼接。`
  return `【本次视频提示词：Muse 专用】本段是本次视频提示词格式的优先规则；与既有默认视频提示词中固定三秒分段、固定段数或单段格式冲突时，以本段为准。图片提示词规则不受影响。
根据分镜实际内容和时长，写清主体与参考素材、场景、光线、机位及镜头运动、动作和画面风格；需要对白或声音时只使用剧本已有内容。角色外貌、服装与物品保持连续，参考素材使用现有 @名称，名称必须精确匹配绑定资产。
按实际动作和镜头变化选择连续时间区间，区间覆盖该分镜总时长，不强制每三秒切分；若只有一个镜头可使用一镜到底。沿用原有镜头顺序，不添加情节或对白，不编造未提供的参考素材、链接、声音和模型参数。输出直接可供视频生成的提示词，不要求模型浏览网页、读取外部链接或执行应用操作。只更新指定的视频提示词字段。${structured}`
}

export function museCompatibleInstructions(text: string): string {
  return text.split('\n').filter(line => !/(?:3\s*(?:秒|second|sec)|3-second|3초|三秒)/i.test(line)).join('\n')
}
