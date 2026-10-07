/**
 * 设备整机更换（年度检修）：
 * 登记旧设备、新设备、停机时间与投运时间；旧设备保留历史读数与泄漏单，
 * 旧设备未完成（当前有效）巡检点位复制到新设备并标明来源。
 *
 * 更换按"阶段步骤"推进，每步独立落库、幂等可重入：
 * 写入中途失败后恢复时，从 lastStep 之后继续，不重复复制点位、不留两套当前点位。
 */
import type { DeviceType } from '@/types/device'

/** 更换阶段 */
export type ReplacementState =
  | '已登记' // 仅登记旧设备 + 新设备，尚未停机
  | '停机中' // 已停机，点位迁移进行中（含中断待恢复）
  | '已停机待投运' // 点位迁移已完成，等待填写投运时间
  | '已完成' // 新设备已投运，旧设备退役
  | '失败' // 某一步写入失败，等待恢复续跑

/** 有序步骤：恢复时按此顺序找到 lastStep 之后的下一步 */
export type ReplacementStep = 'REGISTER' | 'SHUTDOWN' | 'COPY_POINTS' | 'RETIRE_OLD' | 'COMMIT'

export const REPLACEMENT_STEPS: ReplacementStep[] = ['REGISTER', 'SHUTDOWN', 'COPY_POINTS', 'RETIRE_OLD', 'COMMIT']

/** 阶段内下一步：空串表示当前无需自动续跑（已登记待停机 / 已停机待投运，等人工操作） */
export type PendingStep = ReplacementStep | ''

export interface Replacement {
  id: string
  stationId: string
  /** 旧设备 id（停机后退役，历史读数/点位/泄漏单继续挂它） */
  oldDeviceId: string
  /** 新设备 id */
  newDeviceId: string
  /** 新设备登记信息快照 */
  newType: DeviceType
  newModel: string
  newSerialNo: string
  /** 停机时间（YYYY-MM-DD） */
  shutdownDate: string
  /** 投运时间（YYYY-MM-DD） */
  commissionDate: string
  state: ReplacementState
  /** 最近一次成功完成的步骤；REGISTER 建账时即为 REGISTER */
  lastStep: ReplacementStep
  /** 恢复时应接着执行的下一步；空串表示等待人工触发停机/投运 */
  pendingStep: PendingStep
  /** 已复制到新设备的点位 id（COPY 阶段的进度账本） */
  copiedPointIds: string[]
  /** 停机时旧设备有效点位快照（源点位 id 顺序列表），COPY/RETIRE 均以此为准 */
  sourcePointIds: string[]
  /** 最近一次失败原因（写失败后恢复用） */
  lastError: string
  failedAt?: number
  createdAt: number
  updatedAt: number
}

/** 建账草稿：旧设备 + 新设备登记信息（停机/投运时间在后续阶段填写） */
export interface ReplacementDraft {
  oldDeviceId: string
  newType: DeviceType
  newModel: string
  newSerialNo: string
  shutdownDate: string
  commissionDate: string
}

export function createEmptyReplacementDraft(): ReplacementDraft {
  return {
    oldDeviceId: '',
    newType: '调压器',
    newModel: '',
    newSerialNo: '',
    shutdownDate: '',
    commissionDate: ''
  }
}

export const REPLACEMENT_STATE_LABEL: Record<ReplacementState, string> = {
  已登记: '已登记待停机',
  停机中: '停机迁移中',
  已停机待投运: '已停机待投运',
  已完成: '更换完成',
  失败: '失败待恢复'
}

/** 阶段总步数（含登记），用于进度展示 */
export const REPLACEMENT_STEP_INDEX: Record<ReplacementStep, number> = {
  REGISTER: 0,
  SHUTDOWN: 1,
  COPY_POINTS: 2,
  RETIRE_OLD: 3,
  COMMIT: 4
}

/**
 * 应用启动时是否需要自动接着上次进度续跑：
 * 仅"迁移中途失败 / 正在迁移"的记录自动续跑；
 * 「已登记待停机」「已停机待投运」是等人工的正常停顿，不自动推进。
 */
export function shouldAutoResume(replacement: Pick<Replacement, 'state' | 'pendingStep'>): boolean {
  if (replacement.state === '已完成' || replacement.state === '已登记' || replacement.state === '已停机待投运') {
    return false
  }
  return replacement.pendingStep !== ''
}

/** 记录是否仍有可手动/自动续跑的步骤 */
export function isInProgress(replacement: Pick<Replacement, 'state'>): boolean {
  return replacement.state !== '已完成'
}
