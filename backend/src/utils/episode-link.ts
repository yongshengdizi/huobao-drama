import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from './response.js'

type Kind = 'character' | 'scene' | 'prop'
export async function validEpisode(dramaId: number, episodeId: unknown) {
  const id = Number(episodeId)
  if (!Number.isSafeInteger(id) || id <= 0) return false
  const rows = await db.select().from(schema.episodes).where(and(eq(schema.episodes.id, id), eq(schema.episodes.dramaId, Number(dramaId)), isNull(schema.episodes.deletedAt)))
  return rows.length > 0
}
export async function linkEpisode(kind: Kind, episodeId: number, entityId: number) {
  const ts = now()
  if (kind === 'character') {
    const rows = await db.select().from(schema.episodeCharacters).where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, entityId)))
    if (!rows.length) await db.insert(schema.episodeCharacters).values({ episodeId, characterId: entityId, createdAt: ts })
  } else if (kind === 'scene') {
    const rows = await db.select().from(schema.episodeScenes).where(and(eq(schema.episodeScenes.episodeId, episodeId), eq(schema.episodeScenes.sceneId, entityId)))
    if (!rows.length) await db.insert(schema.episodeScenes).values({ episodeId, sceneId: entityId, createdAt: ts })
  } else {
    const rows = await db.select().from(schema.episodeProps).where(and(eq(schema.episodeProps.episodeId, episodeId), eq(schema.episodeProps.propId, entityId)))
    if (!rows.length) await db.insert(schema.episodeProps).values({ episodeId, propId: entityId, createdAt: ts })
  }
}
