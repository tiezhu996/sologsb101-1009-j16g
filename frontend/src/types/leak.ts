/** 泄漏处置：由异常读数派发的处置单，复检合格后闭环 */
export type LeakState = '待处置' | '已处置' | '已复检'

export interface Leak {
  id: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 泄漏浓度（ppm） */
  concentrationPpm: number
  /** 发现时间 YYYY-MM-DD */
  foundTime: string
  measure: string
  state: LeakState
  /** 复检浓度（ppm） */
  retestValuePpm: number
  handler: string
  /**
   * 整机更换时未闭环的泄漏单按旧设备留在原处，不迁到新设备；
   * 人工确认归档后置 true，不计入当前待处置口径，但仍保留在原设备账上。
   */
  archived?: boolean
  archivedAt?: number
  /** 归档备注（如：设备已整机更换，旧故障随旧设备人工归档） */
  archiveNote?: string
  createdAt: number
  updatedAt: number
}

export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '已复检']

/** 泄漏处置状态机：待处置 → 已处置 → 已复检 */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  已复检: null
}

/** 复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

export interface LeakDraft {
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakState
  retestValuePpm: number
  handler: string
}

export const EMPTY_LEAK_DRAFT: LeakDraft = {
  deviceId: '',
  concentrationPpm: 0,
  foundTime: '',
  measure: '',
  state: '待处置',
  retestValuePpm: 0,
  handler: ''
}

export function createEmptyLeakDraft(): LeakDraft {
  return { ...EMPTY_LEAK_DRAFT }
}

export function retestPassed(value: number): boolean {
  return value > 0 && value <= LEAK_RETEST_PASS_PPM
}

/** 是否为当前仍需跟踪的未闭环泄漏单（已人工归档的旧设备遗留单不再计数） */
export function isOpenLeak(leak: Pick<Leak, 'state' | 'archived'>): boolean {
  return leak.state !== '已复检' && leak.archived !== true
}

/** 整机更换遗留：泄漏单未闭环且其设备已退役，等待人工归档 */
export function isLegacyOpenLeak(
  leak: Pick<Leak, 'state' | 'archived'>,
  device: { retiredAt?: string } | undefined
): boolean {
  return isOpenLeak(leak) && !!device && typeof device.retiredAt === 'string' && device.retiredAt.length > 0
}
