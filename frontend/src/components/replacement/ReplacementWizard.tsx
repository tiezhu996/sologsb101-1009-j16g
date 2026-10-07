/**
 * 设备整机更换操作组件（年度检修）
 * - 更换向导：登记旧设备/新设备/停机与投运时间 → 停机并复制当前点位 → 退役旧设备 → 投运
 * - 断点续跑（接着上次进度）、登记投运
 * 旧设备历史读数与泄漏单不迁移；泄漏单留旧设备等待人工归档。
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Form, Input, Message, Modal, Select, Steps, Tag } from '@arco-design/web-react'
import { useStationStore } from '@/stores/stationStore'
import { useReplacementStore } from '@/stores/replacementStore'
import { useLeakStore } from '@/stores/leakStore'
import { isRetiredDevice, DEVICE_TYPES, type Device } from '@/types/device'
import { isOpenLeak } from '@/types/leak'
import {
  REPLACEMENT_STATE_LABEL,
  createEmptyReplacementDraft,
  type Replacement,
  type ReplacementDraft
} from '@/types/replacement'
import { nextActionText, progressOf } from '@/utils/replacementRunner'

const STEP_ITEMS = [{ title: '登记' }, { title: '停机' }, { title: '复制点位' }, { title: '旧设备退役' }, { title: '投运' }]

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

interface ReplacementWizardProps {
  visible: boolean
  /** 从某台旧设备发起时预填 */
  sourceDevice?: Device | null
  onClose: () => void
}

export function ReplacementWizard({ visible, sourceDevice, onClose }: ReplacementWizardProps) {
  const stationStore = useStationStore()
  const replacementStore = useReplacementStore()
  const leaks = useLeakStore((state) => state.leaks)
  const [form] = Form.useForm<ReplacementDraft>()
  const [submitting, setSubmitting] = useState(false)
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null)
  const [oldDeviceId, setOldDeviceId] = useState<string>('')

  const currentStation = stationStore.currentStation()

  const oldDeviceOptions = useMemo(() => {
    if (!currentStation) return []
    return stationStore
      .devicesOfStation(currentStation.id)
      .filter((device) => !isRetiredDevice(device))
      .map((device) => ({
        label: `${device.type} ${device.model}（${device.serialNo}）`,
        value: device.id
      }))
  }, [currentStation, stationStore])

  const record: Replacement | undefined = activeRecordId
    ? replacementStore.replacements.find((item) => item.id === activeRecordId)
    : undefined

  const chosenOld = oldDeviceId ? stationStore.devices.find((device) => device.id === oldDeviceId) : undefined
  const activePointCount = chosenOld ? stationStore.activePointsOfDevice(chosenOld.id).length : 0
  const openLeakCount = chosenOld
    ? leaks.filter((leak) => leak.deviceId === chosenOld.id && isOpenLeak(leak)).length
    : 0

  const resetAndClose = (): void => {
    setActiveRecordId(null)
    setOldDeviceId('')
    setSubmitting(false)
    onClose()
  }

  const initForm = (): void => {
    setActiveRecordId(null)
    const preset = sourceDevice ?? null
    setOldDeviceId(preset ? preset.id : '')
    form.setFieldsValue({
      ...createEmptyReplacementDraft(),
      oldDeviceId: preset ? preset.id : '',
      newType: preset ? preset.type : '调压器',
      shutdownDate: today(),
      commissionDate: today()
    })
  }

  const submitRegister = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values || !currentStation) return
    setSubmitting(true)
    try {
      const created = await replacementStore.register(values, currentStation.id)
      // 登记成功即推进停机迁移，一次走通到「已停机待投运」；中途失败可续跑
      await replacementStore.shutdown(created.id)
      setActiveRecordId(created.id)
      Message.success('已登记并完成停机：旧设备当前点位已复制到新设备，等待登记投运')
    } catch (error) {
      // 登记可能已成功而停机失败：找回本站最新未完成记录，便于就地续跑
      const latest = replacementStore
        .ofStation(currentStation.id)
        .find((item) => item.newSerialNo === values.newSerialNo.trim() && item.state !== '已完成')
      if (latest) setActiveRecordId(latest.id)
      Message.error(error instanceof Error ? error.message : '更换流程失败，可在更换记录中续跑')
    } finally {
      setSubmitting(false)
    }
  }

  const onShutdown = async (): Promise<void> => {
    if (!record) return
    setSubmitting(true)
    try {
      await replacementStore.shutdown(record.id)
      Message.success('已停机，旧设备当前点位已复制到新设备，等待登记投运')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '停机失败，可续跑恢复')
    } finally {
      setSubmitting(false)
    }
  }

  const onResume = async (): Promise<void> => {
    if (!record) return
    setSubmitting(true)
    try {
      await replacementStore.resume(record.id)
      Message.success('已接着上次进度完成迁移')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '续跑失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const onCommit = async (): Promise<void> => {
    if (!record) return
    setSubmitting(true)
    try {
      await replacementStore.commit(record.id, record.commissionDate || today())
      Message.success('新设备已投运、旧设备退役并保留历史；旧设备遗留泄漏单请到泄漏处置页人工归档')
      resetAndClose()
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '投运失败')
      setSubmitting(false)
    }
  }

  return (
    <Modal
      visible={visible}
      title="年度检修 · 设备整机更换"
      onCancel={resetAndClose}
      footer={null}
      unmountOnExit
      style={{ width: 680 }}
      afterOpen={initForm}
    >
      {!record ? (
        <>
          <Alert
            type="info"
            content="整机保留旧设备历史读数；旧设备当前点位复制到新设备并标明来源；未闭环泄漏单留在旧设备等待人工归档，不迁到新设备。"
            style={{ marginBottom: 16 }}
          />
          <Form form={form} layout="vertical" initialValues={createEmptyReplacementDraft()}>
            <Form.Item
              field="oldDeviceId"
              label="旧设备（停机后退役、保留历史）"
              rules={[{ required: true, message: '请选择要更换的旧设备' }]}
            >
              <Select
                options={oldDeviceOptions}
                showSearch
                placeholder="选择本站在役设备"
                onChange={(value: string) => setOldDeviceId(value)}
              />
            </Form.Item>

            {chosenOld ? (
              <div className="replacement-hint">
                <span>
                  当前点位 <strong>{activePointCount}</strong> 个（将复制到新设备）
                </span>
                <span style={{ color: openLeakCount > 0 ? '#f53f3f' : undefined }}>
                  · 未闭环泄漏单 <strong>{openLeakCount}</strong> 张（留旧设备人工归档，不迁移）
                </span>
              </div>
            ) : null}

            <Form.Item field="newType" label="新设备类型" rules={[{ required: true, message: '请选择设备类型' }]}>
              <Select options={DEVICE_TYPES.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
            <Form.Item field="newModel" label="新设备型号" rules={[{ required: true, message: '请填写新设备型号' }]}>
              <Input placeholder="如 RTZ-80/0.4" />
            </Form.Item>
            <Form.Item field="newSerialNo" label="新设备出厂编号" rules={[{ required: true, message: '请填写出厂编号' }]}>
              <Input placeholder="如 SN20251008-01" />
            </Form.Item>
            <div style={{ display: 'flex', gap: 12 }}>
              <Form.Item
                field="shutdownDate"
                label="停机时间"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写停机时间' }]}
              >
                <Input placeholder="YYYY-MM-DD" />
              </Form.Item>
              <Form.Item
                field="commissionDate"
                label="投运时间"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写投运时间' }]}
              >
                <Input placeholder="YYYY-MM-DD" />
              </Form.Item>
            </div>
          </Form>
          <div className="replacement-footer">
            <Button onClick={resetAndClose}>取消</Button>
            <Button type="primary" loading={submitting} onClick={submitRegister}>
              登记并执行停机
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Steps current={Math.min(progressOf(record) - 1, 4)} style={{ margin: '8px 0 20px' }}>
            {STEP_ITEMS.map((item) => (
              <Steps.Step key={item.title} title={item.title} />
            ))}
          </Steps>

          <ReplacementDetail record={record} />

          {record.state === '失败' ? (
            <Alert
              type="error"
              content={`上次写入失败：${record.lastError || '未知错误'}。已复制点位不会重复，可直接接着续跑。`}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {record.state === '已停机待投运' ? (
            <Alert
              type="warning"
              content={`旧设备已停机退役，${record.copiedPointIds.length} 个点位已复制到新设备。确认投运时间「${record.commissionDate}」后新设备上线。`}
              style={{ marginBottom: 12 }}
            />
          ) : null}

          <div className="replacement-footer">
            <Button onClick={resetAndClose}>关闭</Button>
            {record.state === '失败' || record.state === '停机中' ? (
              <Button type="primary" loading={submitting} onClick={onResume}>
                接着上次进度续跑
              </Button>
            ) : null}
            {record.state === '已登记' ? (
              <Button type="primary" loading={submitting} onClick={onShutdown}>
                执行停机并复制点位
              </Button>
            ) : null}
            {record.state === '已停机待投运' ? (
              <Button type="primary" loading={submitting} onClick={onCommit}>
                登记投运，新设备上线
              </Button>
            ) : null}
            {record.state === '已完成' ? <Tag color="green">更换已完成</Tag> : null}
          </div>
        </div>
      )}
    </Modal>
  )
}

function ReplacementDetail({ record }: { record: Replacement }) {
  const stationStore = useStationStore()
  const oldDevice = stationStore.devices.find((device) => device.id === record.oldDeviceId)
  const newDevice = stationStore.devices.find((device) => device.id === record.newDeviceId)
  return (
    <div className="replacement-detail">
      <div className="replacement-detail__row">
        <span className="muted">更换状态</span>
        <Tag color={record.state === '已完成' ? 'green' : record.state === '失败' ? 'red' : 'orange'}>
          {REPLACEMENT_STATE_LABEL[record.state]}
        </Tag>
        <span className="muted">下一步：{nextActionText(record)}</span>
      </div>
      <div className="replacement-detail__row">
        <span className="muted">旧设备</span>
        <span>{oldDevice ? `${oldDevice.type} ${oldDevice.model}（${oldDevice.serialNo}）` : record.oldDeviceId}</span>
        {oldDevice && isRetiredDevice(oldDevice) ? <Tag color="gray">已退役 · 保留历史</Tag> : <Tag>未退役</Tag>}
      </div>
      <div className="replacement-detail__row">
        <span className="muted">新设备</span>
        <span>{`${record.newType} ${record.newModel}（${record.newSerialNo}）`}</span>
        <Tag color={newDevice?.state === '运行' ? 'green' : 'orange'}>{newDevice ? newDevice.state : '检修'}</Tag>
      </div>
      <div className="replacement-detail__row">
        <span className="muted">停机时间</span>
        <span>{record.shutdownDate}</span>
        <span className="muted">投运时间</span>
        <span>{record.state === '已完成' || record.state === '已停机待投运' ? record.commissionDate : '待登记'}</span>
      </div>
      <div className="replacement-detail__row">
        <span className="muted">已复制点位</span>
        <span>
          <strong>{record.copiedPointIds.length}</strong> / {record.sourcePointIds.length} 个（标明来源，不重复）
        </span>
      </div>
    </div>
  )
}
