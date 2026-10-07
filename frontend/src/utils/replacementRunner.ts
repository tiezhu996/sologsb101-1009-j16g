/**
 * 设备整机更换执行引擎（年度检修）
 *
 * 原则：
 * - 旧设备保留历史：历史读数、退役点位、泄漏处置单一律不迁移、不改挂。
 * - 未完成（当前有效）巡检点位复制到新设备，并在新点位上标明来源旧点位/旧设备。
 * - 未闭环泄漏单留在旧设备等待人工归档，绝不到新设备。
 * - 每个阶段步骤独立成事务、幂等可重入；写入失败后从 pendingStep 接着上次进度续跑，
 *   不重复复制点位，最终只保留一套当前点位。
 * - 缺少更换记录的旧数据不会被引擎推断为更换，继续按原设备账运行。
 */
import { createId, db, type DeviceRow, type PointRow, type ReplacementRow } from '@/utils/db'
import type { Replacement, ReplacementDraft, ReplacementStep } from '@/types/replacement'
import { isActivePoint } from '@/types/point'
import { isRetiredDevice } from '@/types/device'

export class ReplacementError extends Error {}

/** 组装更换登记参数（旧设备来自库内实存数据，防止前端缓存脏读） */
export interface RegisterReplacementInput {
  stationId: string
  oldDeviceId: string
  newType: ReplacementDraft['newType']
  newModel: string
  newSerialNo: string
  shutdownDate: string
  commissionDate: string
}

function assertDate(value: string, field: string): void {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ReplacementError(`请填写正确的${field}（YYYY-MM-DD）`)
  }
}

/** 更换步骤的唯一顺序事实来源 */
export const STEP_ORDER: ReplacementStep[] = ['REGISTER', 'SHUTDOWN', 'COPY_POINTS', 'RETIRE_OLD', 'COMMIT']

/** 标记失败：尽量落库，便于下次恢复；落库本身失败则向上抛出 */
async function markFailure(replacementId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await db.replacements.update(replacementId, {
    state: '失败',
    lastError: message,
    failedAt: Date.now(),
    updatedAt: Date.now()
  })
}

/* ------------------------------- 步骤 1：登记 ------------------------------- */

/**
 * 建账：登记旧设备 + 新设备。
 * 新设备先以「检修」态入库（尚未投运），旧设备本步不改动，保持运行。
 */
export async function registerReplacement(input: RegisterReplacementInput): Promise<ReplacementRow> {
  const model = input.newModel.trim()
  const serialNo = input.newSerialNo.trim()
  if (!model) throw new ReplacementError('请填写新设备型号')
  if (!serialNo) throw new ReplacementError('请填写新设备出厂编号')
  assertDate(input.shutdownDate, '停机时间')
  assertDate(input.commissionDate, '投运时间')
  if (input.commissionDate < input.shutdownDate) {
    throw new ReplacementError('投运时间不能早于停机时间')
  }

  const id = createId('rp')
  const now = Date.now()

  await db.transaction('rw', [db.devices, db.replacements], async () => {
    const old = await db.devices.get(input.oldDeviceId)
    if (!old) throw new ReplacementError('旧设备不存在或已被删除')
    if (isRetiredDevice(old)) throw new ReplacementError('旧设备已退役，不能再次整机更换')
    const inProgress = await db.replacements
      .where('oldDeviceId')
      .equals(old.id)
      .filter((row) => row.state !== '已完成')
      .first()
    if (inProgress) throw new ReplacementError('该设备已有一笔未完成的更换记录，请先完成或处理原记录')

    const newId = createId('dv')
    const newDevice: DeviceRow = {
      id: newId,
      stationId: old.stationId,
      type: input.newType,
      model,
      serialNo,
      // 尚未投运：投用日期先记计划投运日，COMMIT 时以实际投运时间回写
      installDate: input.commissionDate,
      state: '检修',
      retiredAt: '',
      replacedBy: '',
      replacementId: id,
      createdAt: now,
      updatedAt: now,
      revision: 3
    }

    // 停机时迁移的源点位快照在 SHUTDOWN 步固化（此刻旧点位仍可能在调整）
    const record: ReplacementRow = {
      id,
      stationId: old.stationId,
      oldDeviceId: old.id,
      newDeviceId: newId,
      newType: input.newType,
      newModel: model,
      newSerialNo: serialNo,
      shutdownDate: input.shutdownDate,
      commissionDate: input.commissionDate,
      state: '已登记',
      lastStep: 'REGISTER',
      pendingStep: '',
      copiedPointIds: [],
      sourcePointIds: [],
      lastError: '',
      createdAt: now,
      updatedAt: now,
      revision: 3
    }
    await db.devices.put(newDevice)
    await db.replacements.put(record)
  })

  const created = await db.replacements.get(id)
  if (!created) throw new ReplacementError('更换登记写入失败')
  return created
}

/* ------------------------------ 步骤 2：停机 ------------------------------ */

/**
 * 停机：旧设备置「停用」并记录停机时间；固化当时旧设备的有效点位快照，
 * 随即进入点位迁移。停机后录入的巡检读数仍走旧设备历史点位，不受影响。
 */
async function runShutdown(record: ReplacementRow): Promise<ReplacementRow> {
  const now = Date.now()
  let snapshotIds: string[] = []
  await db.transaction('rw', [db.devices, db.points, db.replacements], async () => {
    const old = await db.devices.get(record.oldDeviceId)
    if (!old) throw new ReplacementError('旧设备不存在，无法停机')
    const sourcePoints = await db.points.where('deviceId').equals(old.id).toArray()
    snapshotIds = sourcePoints.filter(isActivePoint).map((point) => point.id)

    await db.replacements.update(record.id, {
      state: '停机中',
      pendingStep: 'COPY_POINTS',
      sourcePointIds: snapshotIds,
      lastError: '',
      updatedAt: now
    })
    if (!isRetiredDevice(old)) {
      await db.devices.update(old.id, {
        state: '停用',
        replacementId: record.id,
        updatedAt: now
      })
    }
  })
  return db.replacements.get(record.id) as Promise<ReplacementRow>
}

/* --------------------------- 步骤 3：复制当前点位 --------------------------- */

/**
 * 把快照中的旧有效点位逐个复制到新设备并标明来源。逐点独立事务、按 copiedPointIds
 * 记账：重入时已复制的点位直接跳过，绝不重复产生点位。
 */
async function runCopyPoints(record: ReplacementRow): Promise<ReplacementRow> {
  for (const sourcePointId of record.sourcePointIds) {
    await db.transaction('rw', [db.points, db.replacements], async () => {
      const fresh = (await db.replacements.get(record.id)) as ReplacementRow | undefined
      if (!fresh) throw new ReplacementError('更换记录不存在，无法续跑')
      if (fresh.copiedPointIds.includes(sourcePointId)) return // 幂等：该点位上次已复制

      const source = await db.points.get(sourcePointId)
      if (!source || !isActivePoint(source)) {
        // 源点位已不存在/已退役：登记为已处理，续跑时不再反复扫描
        if (!fresh.copiedPointIds.includes(sourcePointId)) {
          await db.replacements.update(fresh.id, {
            copiedPointIds: [...fresh.copiedPointIds, sourcePointId],
            state: '停机中',
            pendingStep: 'COPY_POINTS',
            updatedAt: Date.now()
          })
        }
        return
      }

      const now = Date.now()
      const created: PointRow = {
        id: createId('pt'),
        deviceId: fresh.newDeviceId,
        stationId: source.stationId,
        name: source.name,
        standardMin: source.standardMin,
        standardMax: source.standardMax,
        unit: source.unit,
        isCritical: source.isCritical,
        retiredAt: '',
        sourcePointId: source.id,
        sourceDeviceId: source.deviceId,
        replacementId: fresh.id,
        createdAt: now,
        updatedAt: now,
        revision: 3
      }
      await db.points.put(created)
      await db.replacements.update(fresh.id, {
        copiedPointIds: [...fresh.copiedPointIds, source.id],
        // 仍有后续点位时保持 COPY_POINTS；全部复制完在循环结束后才推进到 RETIRE_OLD
        state: '停机中',
        pendingStep: 'COPY_POINTS',
        lastError: '',
        updatedAt: now
      })
    })
  }

  const now = Date.now()
  await db.replacements.update(record.id, {
    pendingStep: 'RETIRE_OLD',
    updatedAt: now
  })
  return db.replacements.get(record.id) as Promise<ReplacementRow>
}

/* ------------------------ 步骤 4：退役旧设备/旧点位 ------------------------ */

/**
 * 退役：仅退役已成功复制到新设备的那批源点位，并把旧设备标记退役。
 * 旧设备与其历史读数、未归档泄漏单原样保留——历史不丢、故障不转嫁。
 * 完成后进入「已停机待投运」，等待人工填写/确认投运时间。
 */
async function runRetireOld(record: ReplacementRow): Promise<ReplacementRow> {
  const now = Date.now()
  await db.transaction('rw', [db.devices, db.points, db.replacements], async () => {
    // 兜底：若 COPY 阶段有源点位漏迁，先补齐，保证不出现两套当前点位
    const copiedIds = [...record.copiedPointIds]
    const missing = record.sourcePointIds.filter((id) => !copiedIds.includes(id))
    for (const sourcePointId of missing) {
      const source = await db.points.get(sourcePointId)
      if (!source || !isActivePoint(source)) continue
      const created: PointRow = {
        id: createId('pt'),
        deviceId: record.newDeviceId,
        stationId: source.stationId,
        name: source.name,
        standardMin: source.standardMin,
        standardMax: source.standardMax,
        unit: source.unit,
        isCritical: source.isCritical,
        retiredAt: '',
        sourcePointId: source.id,
        sourceDeviceId: source.deviceId,
        replacementId: record.id,
        createdAt: now,
        updatedAt: now,
        revision: 3
      }
      await db.points.put(created)
      copiedIds.push(source.id)
    }
    if (copiedIds.length !== record.copiedPointIds.length) {
      await db.replacements.update(record.id, { copiedPointIds: copiedIds, updatedAt: now })
    }

    const migrated = await db.points.where('deviceId').equals(record.newDeviceId).toArray()
    const sourceIdOfNew = new Map(migrated.filter((p) => p.sourcePointId).map((p) => [p.sourcePointId as string, p.id]))

    // 仅退役已迁移的源点位；逐点标记退役并回指新点位
    await Promise.all(
      record.sourcePointIds.map(async (sourceId) => {
        const newPointId = sourceIdOfNew.get(sourceId)
        if (!newPointId) return
        const source = await db.points.get(sourceId)
        if (source && isActivePoint(source)) {
          await db.points.update(sourceId, {
            retiredAt: record.shutdownDate,
            replacementId: record.id,
            updatedAt: now
          })
        }
      })
    )

    await db.devices.update(record.oldDeviceId, {
      state: '停用',
      retiredAt: record.shutdownDate,
      replacedBy: record.newDeviceId,
      replacementId: record.id,
      updatedAt: now
    })

    await db.replacements.update(record.id, {
      state: '已停机待投运',
      lastStep: 'RETIRE_OLD',
      pendingStep: '',
      lastError: '',
      updatedAt: now
    })
  })
  return db.replacements.get(record.id) as Promise<ReplacementRow>
}

/* --------------------------- 步骤 5：新设备投运 --------------------------- */

/**
 * 投运：新设备置「运行」并回写实际投运时间，更换记录闭环。
 * 泄漏单不随设备迁移，旧设备遗留的未闭环单仍等待人工归档。
 */
export async function commitReplacement(replacementId: string, commissionDate: string): Promise<ReplacementRow> {
  assertDate(commissionDate, '投运时间')
  const now = Date.now()
  await db.transaction('rw', [db.devices, db.replacements], async () => {
    const record = await db.replacements.get(replacementId)
    if (!record) throw new ReplacementError('更换记录不存在')
    if (record.state === '已完成') return // 幂等：重复投运不重复处理
    if (record.lastStep !== 'RETIRE_OLD') {
      throw new ReplacementError('点位迁移尚未完成，不能投运')
    }
    const freshDate = commissionDate || record.commissionDate
    if (freshDate < record.shutdownDate) throw new ReplacementError('投运时间不能早于停机时间')

    await db.devices.update(record.newDeviceId, {
      state: '运行',
      installDate: freshDate,
      updatedAt: now
    })
    await db.replacements.update(record.id, {
      commissionDate: freshDate,
      state: '已完成',
      lastStep: 'COMMIT',
      pendingStep: '',
      lastError: '',
      failedAt: undefined,
      updatedAt: now
    })
  })
  return db.replacements.get(replacementId) as Promise<ReplacementRow>
}

/* ------------------------------- 停机入口 -------------------------------- */

/**
 * 人工触发停机：从「已登记」推进，依次执行 SHUTDOWN → COPY_POINTS → RETIRE_OLD，
 * 到「已停机待投运」停下等待投运。任一步失败都落失败态并向上抛出，可恢复续跑。
 */
export async function shutdownReplacement(replacementId: string): Promise<ReplacementRow> {
  return driveTo(replacementId, ['SHUTDOWN', 'COPY_POINTS', 'RETIRE_OLD'])
}

/**
 * 从上次进度接着续跑（写失败恢复）。按 pendingStep 决定续跑区间：
 * - 停机迁移链路（COPY_POINTS / RETIRE_OLD）跑到「已停机待投运」
 * - 其余中间态不自动越过人工停顿点
 */
export async function resumeReplacement(replacementId: string): Promise<ReplacementRow> {
  const record = await db.replacements.get(replacementId)
  if (!record) throw new ReplacementError('更换记录不存在')
  if (record.state === '已完成') return record

  if (record.pendingStep === 'COPY_POINTS') {
    return driveTo(replacementId, ['COPY_POINTS', 'RETIRE_OLD'])
  }
  if (record.pendingStep === 'RETIRE_OLD') {
    return driveTo(replacementId, ['RETIRE_OLD'])
  }
  // 没有明确待跑步骤（已登记待停机 / 已停机待投运），原样返回，等人工操作
  return record
}

/** 启动时统一恢复所有中断在迁移链路中的更换记录 */
export async function resumeInterruptedReplacements(): Promise<{ resumed: number; failed: number }> {
  const pending = await db.replacements
    .filter((row) => row.state !== '已完成' && (row.pendingStep === 'COPY_POINTS' || row.pendingStep === 'RETIRE_OLD'))
    .toArray()
  let failed = 0
  for (const record of pending) {
    try {
      await resumeReplacement(record.id)
    } catch {
      failed += 1
    }
  }
  return { resumed: pending.length - failed, failed }
}

const STEP_RUNNERS: Partial<Record<ReplacementStep, (record: ReplacementRow) => Promise<ReplacementRow>>> = {
  SHUTDOWN: runShutdown,
  COPY_POINTS: runCopyPoints,
  RETIRE_OLD: runRetireOld
}

async function driveTo(replacementId: string, steps: ReplacementStep[]): Promise<ReplacementRow> {
  let record = await db.replacements.get(replacementId)
  if (!record) throw new ReplacementError('更换记录不存在')

  for (const step of steps) {
    record = await db.replacements.get(replacementId) as ReplacementRow
    // 幂等：该步已完成则跳过（恢复时接着上次进度）
    const doneIndex = STEP_ORDER.indexOf(record.lastStep)
    const stepIndex = STEP_ORDER.indexOf(step)
    if (doneIndex >= stepIndex) continue
    try {
      const runner = STEP_RUNNERS[step]
      if (!runner) throw new ReplacementError(`未知的更换步骤：${step}`)
      record = await runner(record)
    } catch (error) {
      await markFailure(replacementId, error)
      throw error
    }
  }
  return record
}

/** 供 UI/台账展示：当前步骤进度（1 ~ 总步数） */
export function progressOf(replacement: Pick<Replacement, 'lastStep'>): number {
  return STEP_ORDER.indexOf(replacement.lastStep) + 1
}

/** 下一个人工动作的提示文案 */
export function nextActionText(replacement: Replacement): string {
  switch (replacement.state) {
    case '已登记':
      return '执行停机并迁移点位'
    case '停机中':
    case '失败':
      return replacement.pendingStep ? '接着上次进度续跑' : '执行停机并迁移点位'
    case '已停机待投运':
      return '登记投运，新设备上线'
    case '已完成':
      return '更换已完成'
    default:
      return ''
  }
}
