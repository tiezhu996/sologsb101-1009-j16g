/**
 * 设备更换引擎的端到端校验（内存 IndexedDB，不纳入构建）：
 * 1. 正常整机更换：旧设备保留历史、点位复制且只保留一套当前点位、泄漏单留旧设备
 * 2. 逐阶段断点注入：COPY/RETIRE 中断后续跑不重复复制点位
 * 3. 缺少更换记录的旧数据按原设备账继续
 */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import type { DeviceRow, PointRow, LeakRow, ReplacementRow } from '../src/utils/db'
import {
  registerReplacement,
  shutdownReplacement,
  resumeReplacement,
  commitReplacement,
  resumeInterruptedReplacements
} from '../src/utils/replacementRunner'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

async function seedStation(): Promise<{ oldId: string; stationId: string }> {
  const now = Date.now()
  const stationId = 'st-t'
  const oldId = 'dv-old'
  await db.stations.put({
    id: stationId, name: '测试站', location: 'X', designFlowM3h: 1, inletPressureMpa: 0.4,
    grade: '高中压', commissionDate: '2020-01-01', createdAt: now, updatedAt: now, revision: 3
  })
  await db.devices.put({
    id: oldId, stationId, type: '调压器', model: 'OLD', serialNo: 'SN-OLD', installDate: '2020-01-01',
    state: '运行', retiredAt: '', replacedBy: '', replacementId: '', createdAt: now, updatedAt: now, revision: 3
  })
  const points: PointRow[] = ['进口压力', '出口压力', '泄漏浓度'].map((name, i) => ({
    id: `pt-old-${i}`, deviceId: oldId, stationId, name, standardMin: 0, standardMax: 10,
    unit: 'MPa', isCritical: true, retiredAt: '', sourcePointId: '', sourceDeviceId: '',
    replacementId: '', createdAt: now, updatedAt: now, revision: 3
  }))
  await db.points.bulkPut(points)
  // 一张未闭环泄漏单（应留在旧设备）
  const leak: LeakRow = {
    id: 'lk-open', deviceId: oldId, stationId, concentrationPpm: 80, foundTime: '2024-01-01',
    measure: '', state: '待处置', retestValuePpm: 0, handler: '', archived: false,
    archiveNote: '', createdAt: now, updatedAt: now, revision: 3
  }
  await db.leaks.put(leak)
  return { oldId, stationId }
}

async function scenarioHappyPath(): Promise<void> {
  console.log('场景一：正常整机更换全流程')
  const { oldId } = await seedStation()
  const reg = await registerReplacement({
    stationId: 'st-t', oldDeviceId: oldId, newType: '调压器', newModel: 'NEW', newSerialNo: 'SN-NEW',
    shutdownDate: '2025-10-01', commissionDate: '2025-10-03'
  })
  check('登记后新设备为检修态', (await db.devices.get(reg.newDeviceId))?.state === '检修')
  check('登记后旧设备仍未退役', !(await db.devices.get(oldId))?.retiredAt)

  const afterShutdown = await shutdownReplacement(reg.id)
  check('停机迁移后为已停机待投运', afterShutdown.state === '已停机待投运')
  check('复制了 3 个点位', afterShutdown.copiedPointIds.length === 3)

  const newPoints = await db.points.where('deviceId').equals(reg.newDeviceId).toArray()
  check('新设备 3 个点位且均标明来源', newPoints.length === 3 && newPoints.every((p) => p.sourceDeviceId === oldId))

  const oldPoints = await db.points.where('deviceId').equals(oldId).toArray()
  check('旧点位全部退役（保留记录）', oldPoints.every((p) => p.retiredAt === '2025-10-01'))

  const activeOld = oldPoints.filter((p) => !p.retiredAt)
  const activeNew = newPoints.filter((p) => !p.retiredAt)
  check('只有一套当前点位（旧 0 + 新 3）', activeOld.length === 0 && activeNew.length === 3)

  // 泄漏单仍挂旧设备、未迁移
  const leak = await db.leaks.get('lk-open')
  check('未闭环泄漏单仍挂旧设备', leak?.deviceId === oldId && leak?.state === '待处置')
  const newLeakCount = await db.leaks.where('deviceId').equals(reg.newDeviceId).count()
  check('新设备未背上旧泄漏单', newLeakCount === 0)

  const done = await commitReplacement(reg.id, '2025-10-03')
  check('投运后状态已完成', done.state === '已完成')
  check('新设备运行', (await db.devices.get(reg.newDeviceId))?.state === '运行')
  check('旧设备标记 replacedBy', (await db.devices.get(oldId))?.replacedBy === reg.newDeviceId)

  // 投运幂等
  await commitReplacement(reg.id, '2025-10-03')
  const still3 = (await db.points.where('deviceId').equals(reg.newDeviceId).count()) === 3
  check('重复投运不产生额外点位', still3)
}

/** 直接把记录推进到某个中间态，模拟断电后恢复 */
async function forceState(patch: Partial<ReplacementRow>): Promise<void> {
  await db.replacements.update(patch.id!, patch)
}

async function scenarioResumeMidCopy(): Promise<void> {
  console.log('场景二：复制点位中途失败 → 恢复续跑不重复')
  // 重置库
  await db.table('stations').clear()
  for (const t of ['devices', 'points', 'leaks', 'replacements']) await db.table(t).clear()
  const { oldId } = await seedStation()
  const reg = await registerReplacement({
    stationId: 'st-t', oldDeviceId: oldId, newType: '过滤器', newModel: 'N2', newSerialNo: 'SN-N2',
    shutdownDate: '2025-11-01', commissionDate: '2025-11-02'
  })
  // 模拟 SHUTDOWN 已完成、只复制了 1 个点位后断电：手工构造账本
  const sourceIds = (await db.points.where('deviceId').equals(oldId).toArray()).filter((p) => !p.retiredAt).map((p) => p.id)
  const first = sourceIds[0]
  const now = Date.now()
  await db.points.put({
    id: 'pt-new-0', deviceId: reg.newDeviceId, stationId: 'st-t', name: '进口压力', standardMin: 0,
    standardMax: 10, unit: 'MPa', isCritical: true, retiredAt: '', sourcePointId: first,
    sourceDeviceId: oldId, replacementId: reg.id, createdAt: now, updatedAt: now, revision: 3
  })
  await forceState({
    id: reg.id, state: '失败', lastStep: 'SHUTDOWN', pendingStep: 'COPY_POINTS',
    sourcePointIds: sourceIds, copiedPointIds: [first], lastError: '模拟断电', failedAt: now
  })

  const resumed = await resumeReplacement(reg.id)
  check('续跑后到待投运', resumed.state === '已停机待投运')
  const newPoints = await db.points.where('deviceId').equals(reg.newDeviceId).toArray()
  check('新设备仍恰好 3 个点位（不重复）', newPoints.length === 3)
  const uniqueSources = new Set(newPoints.map((p) => p.sourcePointId))
  check('来源点位一一对应无重复', uniqueSources.size === 3)
  const oldPoints = await db.points.where('deviceId').equals(oldId).toArray()
  check('旧点位全部退役', oldPoints.every((p) => p.retiredAt === '2025-11-01'))
  const active = (await db.points.toArray()).filter((p) => !p.retiredAt)
  check('全站只有一套当前点位（3 个）', active.length === 3 && active.every((p) => p.deviceId === reg.newDeviceId))

  await commitReplacement(reg.id, '2025-11-02')
  check('断点记录最终可完成投运', (await db.replacements.get(reg.id))?.state === '已完成')
}

/** 关键断点：只复制完 1/3 点位、pendingStep 仍为 COPY_POINTS 时断电 */
async function scenarioResumeAfterOnePoint(): Promise<void> {
  console.log('场景二·补：复制完首个点位即断电（pendingStep=COPY_POINTS）')
  for (const t of ['devices', 'points', 'leaks', 'replacements']) await db.table(t).clear()
  const { oldId } = await seedStation()
  const reg = await registerReplacement({
    stationId: 'st-t', oldDeviceId: oldId, newType: '调压器', newModel: 'N4', newSerialNo: 'SN-N4',
    shutdownDate: '2025-12-01', commissionDate: '2025-12-02'
  })
  const sourceIds = (await db.points.where('deviceId').equals(oldId).toArray()).filter((p) => !p.retiredAt).map((p) => p.id)
  const now = Date.now()
  // 仅 SHUTDOWN 已跑：旧设备停用、快照固化
  await db.replacements.update(reg.id, { state: '停机中', pendingStep: 'COPY_POINTS', sourcePointIds: sourceIds })
  await db.devices.update(oldId, { state: '停用' })
  // 模拟只把第 1 个点位的事务提交后崩溃
  const firstSource = await db.points.get(sourceIds[0]) as PointRow
  await db.points.put({
    ...firstSource, id: 'pt-crash-new', deviceId: reg.newDeviceId, retiredAt: '',
    sourcePointId: firstSource.id, sourceDeviceId: oldId, replacementId: reg.id,
    createdAt: now, updatedAt: now
  })
  await db.replacements.update(reg.id, { copiedPointIds: [sourceIds[0]], pendingStep: 'COPY_POINTS' })

  const resumed = await resumeInterruptedReplacements()
  check('启动恢复覆盖该断点', resumed.resumed === 1 && resumed.failed === 0)
  const after = await db.replacements.get(reg.id) as ReplacementRow
  check('续跑后到待投运', after.state === '已停机待投运')
  const newPoints = await db.points.where('deviceId').equals(reg.newDeviceId).toArray()
  check('新设备恰好 3 个点位（首点不重、其余补齐）', newPoints.length === 3)
  const active = (await db.points.toArray()).filter((p) => !p.retiredAt)
  check('全站仍只有一套当前点位（3 个）', active.length === 3)
  await commitReplacement(reg.id, '2025-12-02')
  check('该记录可正常投运闭环', (await db.replacements.get(reg.id))?.state === '已完成')
}

async function scenarioStartupAutoResume(): Promise<void> {
  console.log('场景三：启动时自动恢复中断记录')
  // 把上一条完成记录之外再制造一条中断态：直接复用现有库，新增一个设备
  const now = Date.now()
  const old2 = 'dv-old2'
  await db.devices.put({
    id: old2, stationId: 'st-t', type: '放散阀', model: 'O3', serialNo: 'SN-O3', installDate: '2020-01-01',
    state: '停用', retiredAt: '', replacedBy: '', replacementId: 'rp-int', createdAt: now, updatedAt: now, revision: 3
  } as DeviceRow)
  await db.points.put({
    id: 'pt-x', deviceId: old2, stationId: 'st-t', name: '放散压力', standardMin: 0, standardMax: 1,
    unit: 'MPa', isCritical: false, retiredAt: '', sourcePointId: '', sourceDeviceId: '',
    replacementId: '', createdAt: now, updatedAt: now, revision: 3
  })
  await db.devices.put({
    id: 'dv-new2', stationId: 'st-t', type: '放散阀', model: 'N3', serialNo: 'SN-N3', installDate: '2025-11-05',
    state: '检修', retiredAt: '', replacedBy: '', replacementId: 'rp-int', createdAt: now, updatedAt: now, revision: 3
  } as DeviceRow)
  await db.replacements.put({
    id: 'rp-int', stationId: 'st-t', oldDeviceId: old2, newDeviceId: 'dv-new2', newType: '放散阀',
    newModel: 'N3', newSerialNo: 'SN-N3', shutdownDate: '2025-11-04', commissionDate: '2025-11-05',
    state: '停机中', lastStep: 'SHUTDOWN', pendingStep: 'COPY_POINTS', copiedPointIds: [],
    sourcePointIds: ['pt-x'], lastError: '', createdAt: now, updatedAt: now, revision: 3
  } as ReplacementRow)

  const result = await resumeInterruptedReplacements()
  check('自动恢复处理了 1 条中断记录', result.resumed === 1 && result.failed === 0, `got ${JSON.stringify(result)}`)
  check('中断记录已推进到待投运', (await db.replacements.get('rp-int'))?.state === '已停机待投运')
}

async function scenarioLegacyDataUntouched(): Promise<void> {
  console.log('场景四：缺少更换记录的旧数据按原设备账继续')
  // 普通设备（无任何更换记录）保持运行、点位仍为当前
  const now = Date.now()
  await db.devices.put({
    id: 'dv-plain', stationId: 'st-t', type: '切断阀', model: 'P', serialNo: 'SN-P', installDate: '2021-01-01',
    state: '运行', retiredAt: '', replacedBy: '', replacementId: '', createdAt: now, updatedAt: now, revision: 3
  } as DeviceRow)
  await db.points.put({
    id: 'pt-plain', deviceId: 'dv-plain', stationId: 'st-t', name: '切断动作压力', standardMin: 0, standardMax: 1,
    unit: 'MPa', isCritical: true, retiredAt: '', sourcePointId: '', sourceDeviceId: '',
    replacementId: '', createdAt: now, updatedAt: now, revision: 3
  })
  const device = await db.devices.get('dv-plain')
  const point = await db.points.get('pt-plain')
  check('无更换记录的设备仍运行', device?.state === '运行' && !device?.retiredAt)
  check('无更换记录的点位仍是当前点位', !point?.retiredAt)
}

async function main(): Promise<void> {
  await db.open()
  await scenarioHappyPath()
  await scenarioResumeMidCopy()
  await scenarioResumeAfterOnePoint()
  await scenarioStartupAutoResume()
  await scenarioLegacyDataUntouched()
  if (failures > 0) {
    console.error(`\n${failures} 项校验失败`)
    process.exit(1)
  }
  console.log('\n全部校验通过')
  process.exit(0)
}

void main()
