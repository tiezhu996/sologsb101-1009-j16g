import 'fake-indexeddb/auto'
import Dexie from 'dexie'

// 1) 用老应用 v2 结构建库并写入没有更换列的设备/点位
class V2 extends Dexie {
  stations!: any; devices!: any; points!: any; patrols!: any; readings!: any; leaks!: any
  constructor() {
    super('gbgaspress')
    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })
    this.version(2).stores({
      stations: 'id, name, grade, updatedAt',
      devices: 'id, stationId, type, state, updatedAt',
      points: 'id, deviceId, stationId, name, isCritical, updatedAt',
      patrols: 'id, stationId, planDate, state, updatedAt',
      readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
      leaks: 'id, deviceId, stationId, state, handler, updatedAt'
    })
  }
}
const old = new V2()
await old.open()
await old.devices.put({ id: 'dv-x', stationId: 'st-x', type: '调压器', model: 'M', serialNo: 'S', installDate: '2020-01-01', state: '运行', createdAt: 1, updatedAt: 1, revision: 2 })
await old.points.put({ id: 'pt-x', deviceId: 'dv-x', stationId: 'st-x', name: '进口压力', standardMin: 0, standardMax: 1, unit: 'MPa', isCritical: true, createdAt: 1, updatedAt: 1, revision: 2 })
await old.close()

// 2) 打开真实应用库（触发 v2->v3 upgrade）
const { db } = await import('../src/utils/db.ts')
await db.open()
const dv = await db.devices.get('dv-x')
const pt = await db.points.get('pt-x')
const repCount = await db.replacements.count()
const ok =
  dv.state === '运行' && dv.shutdownDate === '' && dv.replacementId === '' && dv.replacedFromDeviceId === '' &&
  pt.sourceDeviceId === '' && pt.sourcePointId === '' && pt.replacementId === '' &&
  repCount === 0
console.log('v2 设备:', JSON.stringify({ s: dv.state, sd: dv.shutdownDate, rp: dv.replacementId, rf: dv.replacedFromDeviceId }))
console.log('v2 点位:', JSON.stringify({ src: pt.sourceDeviceId, rp: pt.replacementId }))
console.log('更换表行数:', repCount)
console.log(ok ? '真实 v2→v3 升级通过 ✅（按原设备账继续，无更换记录，无两套点位）' : '升级失败 ❌')
process.exit(ok ? 0 : 1)
