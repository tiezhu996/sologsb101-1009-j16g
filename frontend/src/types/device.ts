/** 设备：调压站内的调压器 / 过滤器 / 切断阀 / 放散阀 */
export type DeviceType = '调压器' | '过滤器' | '切断阀' | '放散阀'
export type DeviceState = '运行' | '停用' | '检修'

export interface Device {
  id: string
  stationId: string
  type: DeviceType
  model: string
  /** 出厂编号 */
  serialNo: string
  installDate: string
  state: DeviceState
  /** 年度整机更换停机日期（YYYY-MM-DD）；有值表示该设备已退役，历史读数/泄漏单仍挂在本设备 */
  retiredAt?: string
  /** 更换后接替的新设备 id（仅退役旧设备持有） */
  replacedBy?: string
  /** 产生本次退役的更换记录 id */
  replacementId?: string
  createdAt: number
  updatedAt: number
}

export const DEVICE_TYPES: DeviceType[] = ['调压器', '过滤器', '切断阀', '放散阀']
export const DEVICE_STATES: DeviceState[] = ['运行', '停用', '检修']

/** 设备是否已随整机更换退役（退役设备保留历史，不再承担当前点位） */
export function isRetiredDevice(device: Pick<Device, 'retiredAt'>): boolean {
  return typeof device.retiredAt === 'string' && device.retiredAt.length > 0
}

export interface DeviceDraft {
  stationId: string
  type: DeviceType
  model: string
  serialNo: string
  installDate: string
  state: DeviceState
}

export const EMPTY_DEVICE_DRAFT: DeviceDraft = {
  stationId: '',
  type: '调压器',
  model: '',
  serialNo: '',
  installDate: '',
  state: '运行'
}

export function deviceLabel(device: Device): string {
  return `${device.type} ${device.model || ''}`.trim()
}
