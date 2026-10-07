/**
 * 设备更换：年度检修整机更换时，登记旧设备/新设备、停机与投运时间。
 * 停机执行切换：旧设备保留历史读数与点位（置停用），当前点位复制到新设备并标明来源；
 * 泄漏处置单按旧设备留在原处等待人工归档，不迁到新设备。
 * 切换按步骤推进并落断点，写入中断后重进接着上次进度。
 */

/** 更换单状态：已登记（待停机）→ 已停机（已复制点位，待投运）→ 已投运 */
export type ReplacementState = '已登记' | '已停机' | '已投运'

/** 切换执行步骤（断点续跑按此顺序逐步推进） */
export type ReplacementStep = 'create-device' | 'retire-device' | 'copy-points'

export const REPLACEMENT_STATES: ReplacementState[] = ['已登记', '已停机', '已投运']

export const REPLACEMENT_STEPS: ReplacementStep[] = ['create-device', 'retire-device', 'copy-points']

export const REPLACEMENT_STEP_LABEL: Record<ReplacementStep, string> = {
  'create-device': '登记新设备',
  'retire-device': '旧设备停机保留',
  'copy-points': '复制当前点位到新设备'
}

export interface DeviceReplacement {
  id: string
  stationId: string
  oldDeviceId: string
  newDeviceId: string
  /** 新设备登记信息（停机切换建账前先随更换单持久化，保证中断/刷新后续跑不丢账） */
  newType: string
  newModel: string
  newSerialNo: string
  /** 计划停机时间 YYYY-MM-DD */
  shutdownPlanDate: string
  /** 实际停机时间，停机切换后回写 */
  shutdownDate: string
  /** 计划投运时间 YYYY-MM-DD */
  commissionPlanDate: string
  /** 实际投运时间，投运确认后回写 */
  commissionDate: string
  state: ReplacementState
  /** 已完成的切换步骤（断点续跑位置） */
  completedSteps: ReplacementStep[]
  /** 复制点位映射：旧点位 id → 新点位 id（标明来源用） */
  copiedPointMap: Array<{ oldPointId: string; newPointId: string }>
  /** 年度检修批次 / 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 新建更换单草稿 */
export interface ReplacementDraft {
  stationId: string
  oldDeviceId: string
  newType: string
  newModel: string
  newSerialNo: string
  shutdownPlanDate: string
  commissionPlanDate: string
  remark: string
}

export const EMPTY_REPLACEMENT_DRAFT: ReplacementDraft = {
  stationId: '',
  oldDeviceId: '',
  newType: '调压器',
  newModel: '',
  newSerialNo: '',
  shutdownPlanDate: '',
  commissionPlanDate: '',
  remark: ''
}

export function isReplacementFinished(state: ReplacementState): boolean {
  return state === '已投运'
}

/** 更换单是否处于停机切换中断、需要续跑的状态 */
export function isCutoverInterrupted(replacement: DeviceReplacement): boolean {
  if (replacement.state !== '已登记') return false
  return replacement.completedSteps.length > 0 && replacement.completedSteps.length < REPLACEMENT_STEPS.length
}

export function nextPendingStep(replacement: DeviceReplacement): ReplacementStep | null {
  return REPLACEMENT_STEPS.find((step) => !replacement.completedSteps.includes(step)) ?? null
}
