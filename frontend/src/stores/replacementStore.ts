/**
 * 设备整机更换状态（Zustand）
 * 维护更换台账列表与登记/停机/续跑/投运动作；真正的分步事务在 utils/replacementRunner。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type ReplacementRow } from '@/utils/db'
import type { Replacement, ReplacementDraft } from '@/types/replacement'
import {
  commitReplacement,
  registerReplacement,
  resumeInterruptedReplacements,
  resumeReplacement,
  shutdownReplacement
} from '@/utils/replacementRunner'

interface ReplacementState_ {
  replacements: Replacement[]
  ready: boolean
  register: (draft: ReplacementDraft, stationId: string) => Promise<Replacement>
  shutdown: (id: string) => Promise<Replacement>
  resume: (id: string) => Promise<Replacement>
  commit: (id: string, commissionDate: string) => Promise<Replacement>
  resumeAllInterrupted: () => Promise<{ resumed: number; failed: number }>
  byOldDevice: (deviceId: string) => Replacement | undefined
  byNewDevice: (deviceId: string) => Replacement | undefined
  ofStation: (stationId: string) => Replacement[]
  /** 旧设备上尚未闭环、等待人工归档的泄漏单（不迁移，仅查询）在 leakStore 侧统计 */
}

export const useReplacementStore = create<ReplacementState_>((_set, get) => ({
  replacements: [],
  ready: false,

  async register(draft, stationId) {
    return registerReplacement({
      stationId,
      oldDeviceId: draft.oldDeviceId,
      newType: draft.newType,
      newModel: draft.newModel,
      newSerialNo: draft.newSerialNo,
      shutdownDate: draft.shutdownDate,
      commissionDate: draft.commissionDate
    })
  },

  async shutdown(id) {
    return shutdownReplacement(id)
  },

  async resume(id) {
    return resumeReplacement(id)
  },

  async commit(id, commissionDate) {
    return commitReplacement(id, commissionDate)
  },

  async resumeAllInterrupted() {
    return resumeInterruptedReplacements()
  },

  byOldDevice(deviceId) {
    return get().replacements.find((item) => item.oldDeviceId === deviceId)
  },

  byNewDevice(deviceId) {
    return get().replacements.find((item) => item.newDeviceId === deviceId)
  },

  ofStation(stationId) {
    return get()
      .replacements.filter((item) => item.stationId === stationId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }
}))

liveQuery(async () =>
  (await db.replacements.toArray()).sort((a, b) => b.createdAt - a.createdAt)
).subscribe({
  next: (rows: ReplacementRow[]) => useReplacementStore.setState({ replacements: rows, ready: true }),
  error: () => useReplacementStore.setState({ ready: true })
})
