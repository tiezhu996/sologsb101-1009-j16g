/**
 * 设备更换状态（Zustand）
 * 维护整机更换台账与登记/停机切换/投运动作。
 * - 停机切换按步骤断点推进，刷新或写入失败后重进接着上次进度
 * - 旧设备保留历史读数/点位；未完成巡检点位复制到新设备并标明来源
 * - 泄漏处置单不迁移，按旧设备留在原处等待人工归档
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  confirmCommissioned,
  db,
  deleteReplacement,
  executeShutdownCutover,
  registerReplacement,
  type ReplacementRow
} from '@/utils/db'
import {
  isCutoverInterrupted,
  nextPendingStep,
  REPLACEMENT_STEP_LABEL,
  type DeviceReplacement,
  type ReplacementDraft,
  type ReplacementStep
} from '@/types/replacement'

interface ReplacementState {
  replacements: DeviceReplacement[]
  ready: boolean
  register: (draft: ReplacementDraft) => Promise<DeviceReplacement>
  /** 停机切换：幂等续跑，返回切换后的更换单与是否从断点恢复 */
  shutdown: (id: string, shutdownDate: string) => Promise<{ row: DeviceReplacement; resumed: boolean }>
  commission: (id: string, commissionDate: string) => Promise<DeviceReplacement>
  remove: (id: string) => Promise<void>
  /** 某设备是否在未闭环的更换单中出现（旧机/新机），用于台账页置灰危险操作 */
  activeReplacementOfDevice: (deviceId: string) => DeviceReplacement | null
  interruptedOfDevice: (deviceId: string) => DeviceReplacement | null
  stepText: (replacement: DeviceReplacement) => string
}

export const useReplacementStore = create<ReplacementState>((_set, get) => ({
  replacements: [],
  ready: false,

  async register(draft) {
    return registerReplacement({
      stationId: draft.stationId,
      oldDeviceId: draft.oldDeviceId,
      newType: draft.newType as never,
      newModel: draft.newModel,
      newSerialNo: draft.newSerialNo,
      shutdownPlanDate: draft.shutdownPlanDate,
      commissionPlanDate: draft.commissionPlanDate,
      remark: draft.remark
    })
  },

  async shutdown(id, shutdownDate) {
    const before = get().replacements.find((item) => item.id === id) ?? null
    const resumed = before ? isCutoverInterrupted(before) : false
    const row = await executeShutdownCutover(id, shutdownDate)
    return { row, resumed }
  },

  async commission(id, commissionDate) {
    return confirmCommissioned(id, commissionDate)
  },

  async remove(id) {
    await deleteReplacement(id)
  },

  activeReplacementOfDevice(deviceId) {
    return (
      get().replacements.find(
        (item) =>
          item.state !== '已投运' && (item.oldDeviceId === deviceId || item.newDeviceId === deviceId)
      ) ?? null
    )
  },

  interruptedOfDevice(deviceId) {
    return (
      get().replacements.find(
        (item) =>
          isCutoverInterrupted(item) &&
          (item.oldDeviceId === deviceId || item.newDeviceId === deviceId)
      ) ?? null
    )
  },

  stepText(replacement) {
    if (replacement.state === '已登记') {
      const pending = nextPendingStep(replacement)
      if (!pending) return '切换步骤已完成，待置停机态'
      if (replacement.completedSteps.length === 0) return `待停机（${REPLACEMENT_STEP_LABEL[pending as ReplacementStep]}未开始）`
      return `切换中断 · 已完成 ${replacement.completedSteps.length}/${
        Object.keys(REPLACEMENT_STEP_LABEL).length
      }，下一步：${REPLACEMENT_STEP_LABEL[pending as ReplacementStep]}`
    }
    if (replacement.state === '已停机') {
      return `已停机切换（复制点位 ${replacement.copiedPointMap.length} 个），待投运`
    }
    return `已投运，闭环完成`
  }
}))

liveQuery(async () =>
  (await db.replacements.toArray()).sort((a, b) => b.createdAt - a.createdAt)
).subscribe({
  next: (rows: ReplacementRow[]) => useReplacementStore.setState({ replacements: rows, ready: true }),
  error: () => useReplacementStore.setState({ ready: true })
})
