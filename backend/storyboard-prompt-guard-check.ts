import assert from 'node:assert/strict'
import { db, schema } from './src/db/index.js'
import { storyboardTools } from './src/agents/tools/storyboard-tools.js'
const ts = new Date().toISOString()
const d = await db.insert(schema.dramas).values({ title:'test', createdAt:ts, updatedAt:ts }).returning()
const e = await db.insert(schema.episodes).values({ dramaId:d[0].id, episodeNumber:1, title:'test', scriptContent:'test', createdAt:ts, updatedAt:ts }).returning()
const scene = await db.insert(schema.scenes).values({ dramaId:d[0].id, location:'room', time:'night', prompt:'room', createdAt:ts, updatedAt:ts }).returning()
await db.insert(schema.episodeScenes).values({ episodeId:e[0].id, sceneId:scene[0].id, createdAt:ts })
const b = await db.insert(schema.storyboards).values({ episodeId:e[0].id, sceneId:scene[0].id, storyboardNumber:1, createdAt:ts, updatedAt:ts }).returning()
const values: Record<string, unknown> = { episodeId:e[0].id, dramaId:d[0].id, promptFieldsOnly:true }
const context:any = { requestContext:{ get:(key:string)=>values[key] } }
const result:any = await storyboardTools.updateStoryboard.execute!({ storyboard_id:b[0].id, video_prompt:'test', scene_id:null },context)
assert.match(result.error,/scene_id/)
const updated = await db.select().from(schema.storyboards)
assert.equal(updated[0].sceneId,scene[0].id)
assert.equal(updated[0].videoPrompt,null)
const result2:any = await storyboardTools.updateStoryboard.execute!({ storyboard_id:b[0].id, image_prompt:'image', video_prompt:'video' },context)
assert.ok(!result2.error)
const after = await db.select().from(schema.storyboards)
assert.equal(after[0].sceneId,scene[0].id)
assert.equal(after[0].imagePrompt,'image')
assert.equal(after[0].videoPrompt,'video')
const read:any = await storyboardTools.readStoryboardContext.execute!({}, context)
assert.equal(read.existing_storyboards[0].scene_id,scene[0].id)
console.log('PASS context binding and prompt-only updates')
