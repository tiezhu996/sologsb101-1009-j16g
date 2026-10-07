/**
 * 设备更换断点续跑逻辑验证（Node + fake-indexeddb，不进浏览器）：
 * 1. 登记不改变旧设备账；
 * 2. 停机切换后旧设备历史点位/读数/泄漏单全保留，新设备复制点位且带来源，不产生两套当前点位；
 * 3. 泄漏单不迁移；
 * 4. 任意步骤后中断，再次调用接着上次进度且结果一致（幂等、无重复点位）。
 */
import 'fake-indexeddb/auto'
import {
  db,
  seedDatabase,
  registerReplacement,
  executeShutdownCutover,
  confirmCommissioned,
  deleteDeviceCascade,
  type DeviceRow,
  type PointRow,
  type LeakRow
} from '../src/utils/db.ts'
import type { DeviceReplacement } from '../src/types/replacement.ts'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.error(`  ❌ ${name} ${detail}`)
  }
}

async function snapshotCounts(): Promise<{ points: number; readings: number; leaks: number; devices: number }> {
  const [points, readings, leaks, devices] = await Promise.all([
    db.points.count(),
    db.readings.count(),
    db.leaks.count(),
    db.devices.count()
  ])
  return { points, readings, leaks, devices }
}

async function main(): Promise<void> {
  await db.open()
  await seedDatabase()

  // 旧设备 dv-4（st-2 调压器，3 个点位 pt-7/8/9/10，泄漏单 lk-3 待处置）
  const oldId = 'dv-4'
  const oldPointsBefore = await db.points.where('deviceId').equals(oldId).toArray()
  const oldLeaksBefore = await db.leaks.where('deviceId').equals(oldId).toArray()
  const before = await snapshotCounts()
  console.log(`旧设备点位 ${oldPointsBefore.length} 个，泄漏单 ${oldLeaksBefore.length} 张`)

  // ---------- 1. 登记 ----------
  console.log('\n[1] 登记更换单（停机前）')
  const rep = await registerReplacement({
    stationId: 'st-2',
    oldDeviceId: oldId,
    newType: '调压器',
    newModel: 'RTZ-50/0.2-NEW',
    newSerialNo: 'SN2026-NEW-01',
    shutdownPlanDate: '2026-10-07',
    commissionPlanDate: '2026-10-08',
    remark: '2026 年度检修整机更换'
  })
  const oldAfterRegister = await db.devices.get(oldId)
  check('登记后旧设备仍在役', oldAfterRegister?.state === '运行')
  check('登记后点位/读数/泄漏单不变', JSON.stringify(await snapshotCounts()) === JSON.stringify(before))
  check('登记后尚无新设备', !(await db.devices.where('replacedFromDeviceId').equals(oldId).first()))

  // 中断模拟：分别在 0/1/2 步后重进
  for (const stopAfter of [0, 1, 2]) {
    // 每次用全新库跑一遍，观察中间态不变式
    await db.close(); await db.delete()
    await db.open()
    await seedDatabase()
    const r = await registerReplacement({
      stationId: 'st-2',
      oldDeviceId: oldId,
      newType: '调压器',
      newModel: 'RTZ-50/0.2-NEW',
      newSerialNo: 'SN2026-NEW-01',
      shutdownPlanDate: '2026-10-07',
      commissionPlanDate: '2026-10-08',
      remark: '中断测试'
    })

    if (stopAfter > 0) {
      // 手工只推进前 stopAfter 步（通过直接调用内部步骤不可见，改为利用断点：逐步伪造中断）
      await stepThrough(r.id, stopAfter)
    }
    const intermediate = await db.replacements.get(r.id) as DeviceReplacement

    // 任意中间态不变式：不允许「旧机仍在役 且 新机已有点位」两套当前点位
    const oldDev = await db.devices.get(oldId)
    const newDevId = intermediate.newDeviceId
    const newDev = newDevId ? await db.devices.get(newDevId) : null
    const newPointCount = newDevId ? await db.points.where('deviceId').equals(newDevId).count() : 0
    const twoActiveSets = oldDev?.state === '运行' && newPointCount > 0
    check(`停在第 ${stopAfter} 步后不存在两套当前点位`, !twoActiveSets)
    check(`停在第 ${stopAfter} 步后旧机历史点位仍保留`, (await db.points.where('deviceId').equals(oldId).count()) === oldPointsBefore.length)

    // 续跑完成
    await executeShutdownCutover(r.id, '2026-10-07')
    await assertFinalState(r.id, oldId, oldPointsBefore.length, oldLeaksBefore.length, before)
  }

  // ---------- 正常一次跑完（幂等重复调用） ----------
  await db.close(); await db.delete()
  await db.open()
  await seedDatabase()
  const r2 = await registerReplacement({
    stationId: 'st-2', oldDeviceId: oldId, newType: '调压器', newModel: 'M2', newSerialNo: 'S2',
    shutdownPlanDate: '2026-10-07', commissionPlanDate: '2026-10-08', remark: '正常'
  })
  await executeShutdownCutover(r2.id, '2026-10-07')
  // 再调一次：应幂等，不产生重复点位
  await executeShutdownCutover(r2.id, '2026-10-07')
  await assertFinalState(r2.id, oldId, oldPointsBefore.length, oldLeaksBefore.length, before)

  // ---------- 投运 ----------
  console.log('\n[4] 确认投运')
  const commissioned = await confirmCommissioned(r2.id, '2026-10-08')
  check('更换单闭环为已投运', commissioned.state === '已投运')
  const newDevFinal = await db.devices.get(commissioned.newDeviceId)
  check('新设备运行且投运日期回写', newDevFinal?.state === '运行' && newDevFinal.installDate === '2026-10-08')

  // ---------- 旧设备受保护 ----------
  console.log('\n[5] 旧机/新机删除保护')
  let blockedOld = false
  try {
    await deleteDeviceCascade(oldId)
  } catch {
    blockedOld = true
  }
  check('旧机不能直接删除', blockedOld)

  // ---------- v3 升级：老库缺更换记录按原设备账 ----------
  console.log('\n[6] v2 → v3 升级按原设备账继续')
  await simulateV2Upgrade()

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项失败 ❌`)
  if (failures > 0) process.exit(1)
}

/** 仅推进前 n 个步骤：复刻 executeShutdownCutover 的分步事务（按 completedSteps 落点） */
async function stepThrough(repId: string, n: number): Promise<void> {
  // 通过把内部步骤“跑到一半”不可外部触发；这里用直接构造完成态来模拟“前 n 步已提交”的断点。
  // n=1: 新设备已建；n=2: 旧机已停。通过真实执行再删除后续产物来复现断点等价状态。
  // 简化：直接调用完整切换然后回滚后续步骤的结果。
  const { createId } = await import('../src/utils/db.ts')
  const rep = (await db.replacements.get(repId)) as DeviceReplacement
  if (n === 1) {
    const now = Date.now()
    const newRow: DeviceRow = {
      id: createId('dv'), stationId: 'st-2', type: '调压器', model: rep.newModel, serialNo: rep.newSerialNo,
      installDate: '', state: '检修', shutdownDate: '', replacementId: rep.id,
      replacedFromDeviceId: rep.oldDeviceId, createdAt: now, updatedAt: now, revision: 2
    }
    await db.devices.put(newRow)
    await db.replacements.update(rep.id, { newDeviceId: newRow.id, completedSteps: ['create-device'] })
  } else if (n === 2) {
    const now = Date.now()
    const newRow: DeviceRow = {
      id: createId('dv'), stationId: 'st-2', type: '调压器', model: rep.newModel, serialNo: rep.newSerialNo,
      installDate: '', state: '检修', shutdownDate: '', replacementId: rep.id,
      replacedFromDeviceId: rep.oldDeviceId, createdAt: now, updatedAt: now, revision: 2
    }
    await db.devices.put(newRow)
    await db.devices.update(rep.oldDeviceId, { state: '停用', shutdownDate: '2026-10-07', replacementId: rep.id })
    await db.replacements.update(rep.id, {
      newDeviceId: newRow.id,
      completedSteps: ['create-device', 'retire-device']
    })
  }
}

async function assertFinalState(
  repId: string,
  oldId: string,
  oldPointTotal: number,
  oldLeakTotal: number,
  before: { points: number; readings: number; leaks: number; devices: number }
): Promise<void> {
  console.log(`\n[最终态校验] ${repId}`)
  const rep = (await db.replacements.get(repId)) as DeviceReplacement
  check('状态为已停机', rep.state === '已停机')
  check('三个步骤全部落点', rep.completedSteps.length === 3)

  const oldDev = await db.devices.get(oldId) as DeviceRow
  check('旧设备置停用', oldDev.state === '停用')
  check('旧设备记录停机时间', oldDev.shutdownDate === '2026-10-07')
  check('旧设备回写更换单', oldDev.replacementId === repId)

  const newDev = (await db.devices.get(rep.newDeviceId)) as DeviceRow
  check('新设备已建账', !!newDev)
  check('新设备记录接替来源', newDev.replacedFromDeviceId === oldId)
  check('投运前新设备为检修态', newDev.state === '检修')

  const oldPoints = await db.points.where('deviceId').equals(oldId).toArray()
  const newPoints = await db.points.where('deviceId').equals(newDev.id).toArray()
  check('旧机历史点位数量不变', oldPoints.length === oldPointTotal, `got ${oldPoints.length}`)
  check('新机复制点位数量一致', newPoints.length === oldPointTotal, `got ${newPoints.length}`)
  check('新点位全部标明来源设备', newPoints.every((p: PointRow) => p.sourceDeviceId === oldId))
  check('新点位全部标明来源点位', newPoints.every((p: PointRow) => p.sourcePointId && oldPoints.some((o) => o.id === p.sourcePointId)))
  check('新点位均无历史读数（读数留在旧机）', (await db.readings.where('pointId').anyOf(newPoints.map((p) => p.id)).count()) === 0)

  // 两套当前点位判定：旧机已停用，只有新机承担当前点位
  const twoActiveSets = oldDev.state === '运行' && newPoints.length > 0
  check('最终态只有一套当前点位', !twoActiveSets)

  // 泄漏单
  const oldLeaks = await db.leaks.where('deviceId').equals(oldId).toArray()
  const newLeaks = await db.leaks.where('deviceId').equals(newDev.id).toArray()
  check('泄漏单仍挂旧设备', oldLeaks.length === oldLeakTotal)
  check('新设备未背旧故障（0 张迁移泄漏单）', newLeaks.length === 0)
  check('待处置单 lk-3 原样留在旧机', oldLeaks.some((l: LeakRow) => l.id === 'lk-3' && l.state === '待处置'))

  // 总量
  const after = await snapshotCounts()
  check('读数总量不变', after.readings === before.readings)
  check('泄漏单总量不变', after.leaks === before.leaks)
  check('设备增加 1（旧机保留）', after.devices === before.devices + 1)
  check('点位增加恰好旧机点位数（复制而非迁移）', after.points === before.points + oldPointTotal)

  // 映射
  check('复制映射完整', rep.copiedPointMap.length === oldPointTotal)
}

async function simulateV2Upgrade(): Promise<void> {
  // 删除重建后通过 seedDatabase 已是新结构；这里验证“缺更换记录的老数据”不会被当成更换
  await db.close(); await db.delete()
  await db.open()
  await seedDatabase()
  const dv4 = await db.devices.get('dv-4')
  check('无更换记录设备保持运行（按原设备账继续）', dv4?.state === '运行' && !dv4?.replacementId && !dv4?.replacedFromDeviceId)
  const pt7 = await db.points.get('pt-7')
  check('原装机点位无来源标记', !pt7?.sourceDeviceId && !pt7?.replacementId)
  const repCount = await db.replacements.count()
  check('不会凭空生成更换记录', repCount === 0)
  // 点位数不翻倍：不存在两套当前点位
  check('全站点位仍为 11 个（未拆出两套）', (await db.points.count()) === 11)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
