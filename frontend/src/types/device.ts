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
  /**
   * 设备更换台账：整机更换时旧设备不删除（保留历史读数/点位/泄漏单），
   * 停机后置「停用」并记录停机时间与更换单；新设备记录接替的旧设备与投运时间。
   */
  /** 停机时间 YYYY-MM-DD（年度检修整机更换时回写，在役设备为空串） */
  shutdownDate?: string
  /** 关联更换单 id（旧设备、新设备均回填） */
  replacementId?: string
  /** 新设备：被接替的旧设备 id；原装机/旧设备为空串 */
  replacedFromDeviceId?: string
  createdAt: number
  updatedAt: number
}

export const DEVICE_TYPES: DeviceType[] = ['调压器', '过滤器', '切断阀', '放散阀']
export const DEVICE_STATES: DeviceState[] = ['运行', '停用', '检修']

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

/** 旧设备是否已在整机更换中停机保留（停用且有更换单） */
export function isRetiredDevice(device: Device): boolean {
  return device.state === '停用' && typeof device.replacementId === 'string' && device.replacementId.length > 0
}

/** 设备是否为整机更换后的接替新设备 */
export function isReplacementDevice(device: Device): boolean {
  return typeof device.replacedFromDeviceId === 'string' && device.replacedFromDeviceId.length > 0
}
