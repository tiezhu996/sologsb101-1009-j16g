/**
 * /replacements 年度检修设备更换台账
 * 登记旧设备/新设备、停机与投运时间；停机后旧设备保留历史，未完成巡检点位复制到新设备并标明来源；
 * 泄漏处置单按旧设备留在原处等待人工归档。切换按步骤断点推进，写入中断后重进接着上次进度。
 * 消费 DeviceReplacement、Device、Point、Leak；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useLeakStore } from '@/stores/leakStore'
import { useReplacementStore } from '@/stores/replacementStore'
import { DEVICE_TYPES } from '@/types/device'
import { isRetiredDevice } from '@/types/device'
import {
  EMPTY_REPLACEMENT_DRAFT,
  isCutoverInterrupted,
  REPLACEMENT_STATES,
  type DeviceReplacement,
  type ReplacementDraft
} from '@/types/replacement'

export default function ReplacementBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()
  const replacementStore = useReplacementStore()

  const [form] = Form.useForm<ReplacementDraft>()
  const [shutdownForm] = Form.useForm<{ shutdownDate: string }>()
  const [commissionForm] = Form.useForm<{ commissionDate: string }>()
  const [registerOpen, setRegisterOpen] = useState(false)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const [commissionOpen, setCommissionOpen] = useState(false)
  const [target, setTarget] = useState<DeviceReplacement | null>(null)
  const [keyword, setKeyword] = useState('')
  const [stationId, setStationId] = useState('')
  const [states, setStates] = useState<string[]>([])
  const [formStationId, setFormStationId] = useState('')

  const deviceName = (deviceId: string): string => {
    const device = stationStore.devices.find((item) => item.id === deviceId)
    return device ? `${device.type} ${device.model}（${device.serialNo || '无编号'}）` : '设备已不存在'
  }

  const stationName = (id: string): string =>
    stationStore.stations.find((item) => item.id === id)?.name ?? '—'

  /** 挂在旧设备名下、等待人工归档的未闭环泄漏单 */
  const openLeaksOf = (replacement: DeviceReplacement) =>
    leakStore.leaks.filter(
      (leak) => leak.deviceId === replacement.oldDeviceId && leak.state !== '已复检'
    )

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '更换状态', options: REPLACEMENT_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword, stationId, states }

  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    setStationId(typeof next.stationId === 'string' ? next.stationId : '')
    setStates(Array.isArray(next.states) ? next.states : [])
  }

  const rows = replacementStore.replacements.filter((replacement) => {
    if (stationId && replacement.stationId !== stationId) return false
    if (states.length > 0 && !states.includes(replacement.state)) return false
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    return (
      deviceName(replacement.oldDeviceId).toLowerCase().includes(text) ||
      deviceName(replacement.newDeviceId).toLowerCase().includes(text) ||
      replacement.newSerialNo.toLowerCase().includes(text) ||
      replacement.remark.toLowerCase().includes(text)
    )
  })

  /** 仅允许对在役设备登记更换（已停机保留的旧机、已接替的新机不再登记）；按表单所选站点过滤 */
  const oldDeviceOptions = stationStore.devices
    .filter((device) => !formStationId || device.stationId === formStationId)
    .filter((device) => !device.replacedFromDeviceId)
    .filter((device) => !(device.state === '停用' && device.replacementId))
    .map((device) => {
      const station = stationStore.stations.find((item) => item.id === device.stationId)
      return {
        label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}（${device.serialNo || '无编号'}）`,
        value: device.id
      }
    })

  const pointCountOf = (deviceId: string): number =>
    stationStore.points.filter((point) => point.deviceId === deviceId).length

  const openRegister = (): void => {
    const current = stationStore.currentStation()
    const initialStation = current ? current.id : stationStore.stations[0]?.id ?? ''
    const candidates = stationStore.devices.filter(
      (device) => (!initialStation || device.stationId === initialStation) && !device.replacedFromDeviceId && !(device.state === '停用' && device.replacementId)
    )
    if (stationStore.devices.length === 0) {
      Message.warning('暂无可更换的在役设备')
      return
    }
    if (candidates.length === 0) {
      Message.warning('所选站点暂无可更换的在役设备，请切换调压站')
    }
    setFormStationId(initialStation)
    form.setFieldsValue({
      ...EMPTY_REPLACEMENT_DRAFT,
      stationId: initialStation,
      oldDeviceId: candidates[0]?.id,
      shutdownPlanDate: new Date().toISOString().slice(0, 10),
      commissionPlanDate: new Date().toISOString().slice(0, 10)
    })
    setRegisterOpen(true)
  }

  const onStationChange = (nextStationId: string): void => {
    setFormStationId(nextStationId)
    form.setFieldsValue({ oldDeviceId: undefined as never })
    const first = stationStore.devices.find(
      (device) => device.stationId === nextStationId && !device.replacedFromDeviceId && !(device.state === '停用' && device.replacementId)
    )
    if (first) form.setFieldsValue({ oldDeviceId: first.id })
  }

  const submitRegister = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    await replacementStore.register({
      ...values,
      stationId: values.stationId || stationStore.currentStation()?.id || ''
    })
    Message.success('更换单已登记：旧设备仍在役，停机时执行切换并复制点位')
    setRegisterOpen(false)
  }

  const openShutdown = (replacement: DeviceReplacement): void => {
    setTarget(replacement)
    shutdownForm.setFieldsValue({ shutdownDate: replacement.shutdownDate || replacement.shutdownPlanDate })
    setShutdownOpen(true)
  }

  const submitShutdown = async (): Promise<void> => {
    const values = await shutdownForm.validate().catch(() => null)
    if (!values || !target) return
    try {
      const { resumed } = await replacementStore.shutdown(target.id, values.shutdownDate)
      if (resumed) {
        Message.success('已按上次中断进度续跑完成停机切换：旧设备保留历史，当前点位已复制到新设备')
      } else {
        Message.success('停机切换完成：旧设备保留历史读数与点位，新设备已承接当前点位（标明来源）')
      }
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '停机切换失败，可重新进入续跑')
    }
    setShutdownOpen(false)
  }

  const openCommission = (replacement: DeviceReplacement): void => {
    setTarget(replacement)
    commissionForm.setFieldsValue({ commissionDate: replacement.commissionDate || replacement.commissionPlanDate })
    setCommissionOpen(true)
  }

  const submitCommission = async (): Promise<void> => {
    const values = await commissionForm.validate().catch(() => null)
    if (!values || !target) return
    await replacementStore.commission(target.id, values.commissionDate)
    Message.success('新设备已投运；历史读数与未归档泄漏单继续留在旧设备名下')
    setCommissionOpen(false)
  }

  const remove = async (replacement: DeviceReplacement): Promise<void> => {
    try {
      await replacementStore.remove(replacement.id)
      Message.success('未执行的更换登记单已删除')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const columns: TableColumnProps<DeviceReplacement>[] = [
    {
      title: '调压站',
      width: 150,
      render: (_value, record) => stationName(record.stationId)
    },
    {
      title: '旧设备（停机保留）',
      width: 220,
      render: (_value, record) => {
        const device = stationStore.devices.find((item) => item.id === record.oldDeviceId)
        return (
          <Space direction="vertical" size={2}>
            <span>{deviceName(record.oldDeviceId)}</span>
            {device ? (
              <Space size={4}>
                <Tag size="small" color={isRetiredDevice(device) ? 'gray' : 'green'}>
                  {device.state}
                </Tag>
                {device.shutdownDate ? <span className="muted">停机 {device.shutdownDate}</span> : null}
              </Space>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: '新设备（承接当前点位）',
      width: 230,
      render: (_value, record) => {
        if (!record.newDeviceId) return <span className="muted">停机切换时建账</span>
        const device = stationStore.devices.find((item) => item.id === record.newDeviceId)
        return (
          <Space direction="vertical" size={2}>
            <span>{deviceName(record.newDeviceId)}</span>
            {device ? (
              <Space size={4}>
                <Tag size="small" color={device.state === '运行' ? 'green' : 'orange'}>{device.state}</Tag>
                {device.installDate ? <span className="muted">投运 {device.installDate}</span> : null}
              </Space>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: '停机 / 投运',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <span className="muted">停机 {record.shutdownDate || record.shutdownPlanDate || '—'}</span>
          <span className="muted">投运 {record.commissionDate || record.commissionPlanDate || '—'}</span>
        </Space>
      )
    },
    {
      title: '点位 / 待归档泄漏单',
      width: 190,
      render: (_value, record) => {
        const copied = record.copiedPointMap.length
        const openLeaks = openLeaksOf(record)
        return (
          <Space direction="vertical" size={2}>
            <span>
              新设备点位 {record.newDeviceId ? pointCountOf(record.newDeviceId) : 0} 个
              {copied > 0 ? <span className="muted">（复制 {copied}，带来源）</span> : null}
            </span>
            <span style={{ color: openLeaks.length > 0 ? '#f53f3f' : undefined }}>
              旧设备待人工归档泄漏单 {openLeaks.length} 单
            </span>
          </Space>
        )
      }
    },
    {
      title: '状态 / 进度',
      width: 230,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={record.state === '已投运' ? 'green' : record.state === '已停机' ? 'blue' : 'orange'}>
            {record.state}
          </Tag>
          <span className="muted">{replacementStore.stepText(record)}</span>
        </Space>
      )
    },
    {
      title: '操作',
      width: 220,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} direction="vertical">
          <Space size={4}>
            {record.state === '已登记' ? (
              <Button type="text" size="small" onClick={() => openShutdown(record)}>
                {isCutoverInterrupted(record) ? '续跑停机切换' : '执行停机切换'}
              </Button>
            ) : null}
            {record.state === '已停机' ? (
              <Button type="text" size="small" onClick={() => openCommission(record)}>
                确认投运
              </Button>
            ) : null}
            {record.state === '已投运' ? <span className="muted">已闭环</span> : null}
          </Space>
          {record.completedSteps.length === 0 ? (
            <Popconfirm title="仅删除登记单（尚未切换，不影响旧设备账）" onOk={() => remove(record)}>
              <Button type="text" size="small" status="danger">
                删除登记
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      )
    }
  ]

  const registered = replacementStore.replacements.filter((item) => item.state === '已登记').length
  const stopped = replacementStore.replacements.filter((item) => item.state === '已停机').length
  const live = replacementStore.replacements.filter((item) => item.state === '已投运').length
  const pendingLeaks = replacementStore.replacements.reduce(
    (sum, item) => sum + openLeaksOf(item).length,
    0
  )

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">年度检修设备更换台账</h2>
          <p className="page-head__desc">
            整机更换不直接改编号或删旧设备：旧设备停机保留全部历史读数与点位，未完成巡检点位复制到新设备并标明来源；
            泄漏处置单留在旧设备等待人工归档。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openRegister}>
            登记设备更换
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="更换单总数" value={replacementStore.replacements.length} suffix="张" tone="primary" />
        <StatBadge label="待停机" value={registered} suffix="张" tone="warning" />
        <StatBadge label="已停机待投运" value={stopped} suffix="张" tone="info" />
        <StatBadge label="旧机待归档泄漏单" value={pendingLeaks} suffix="单" tone="danger" />
        <StatBadge label="已投运闭环" value={live} suffix="张" tone="success" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索设备型号 / 出厂编号 / 备注" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            更换记录（{rows.length} / {replacementStore.replacements.length}）
          </h3>
          <span className="muted">切换按步骤断点推进，写入中断后再次「执行停机切换」即接着上次进度</span>
        </div>

        <Alert
          type="info"
          style={{ margin: '12px 0' }}
          content="停机切换口径：① 登记新设备（投运前为检修态）② 旧设备当前点位复制到新设备并写明来源点位/设备 ③ 旧设备置停用并记录停机时间；历史读数不复制，泄漏处置单不迁移。"
        />

        {rows.length === 0 ? (
          <EmptyPanel
            title="还没有设备更换记录"
            description="年度检修整机更换时在此登记旧设备、新设备与停机/投运时间，避免直接改编号或删旧设备导致历史错挂。"
            actionText="登记设备更换"
            onAction={openRegister}
            compact
          />
        ) : (
          <Table<DeviceReplacement>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={registerOpen}
        title="登记年度检修设备更换"
        onCancel={() => setRegisterOpen(false)}
        onOk={submitRegister}
        okText="登记（停机时再切换）"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_REPLACEMENT_DRAFT}>
          <Alert
            type="warning"
            style={{ marginBottom: 12 }}
            content="登记后旧设备保持在役；执行停机切换时才会复制点位并停用旧机。未归档泄漏单将继续挂在旧设备上。"
          />
          <Form.Item field="stationId" label="所属调压站" rules={[{ required: true, message: '请选择调压站' }]}>
            <Select
              options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
              onChange={(value: string) => onStationChange(value)}
            />
          </Form.Item>
          <Form.Item field="oldDeviceId" label="旧设备（整机更换对象）" rules={[{ required: true, message: '请选择旧设备' }]}>
            <Select options={oldDeviceOptions} showSearch placeholder="选择待更换的在役设备" />
          </Form.Item>
          <Form.Item field="newType" label="新设备类型" rules={[{ required: true, message: '请选择新设备类型' }]}>
            <Select options={DEVICE_TYPES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="newModel" label="新设备型号" rules={[{ required: true, message: '请填写新设备型号' }]}>
            <Input placeholder="如 RTZ-80/0.4" />
          </Form.Item>
          <Form.Item field="newSerialNo" label="新设备出厂编号" rules={[{ required: true, message: '请填写出厂编号' }]}>
            <Input placeholder="如 SN20250920-09" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="shutdownPlanDate" label="停机时间" rules={[{ required: true, message: '请填写停机时间' }]} style={{ flex: 1 }}>
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item field="commissionPlanDate" label="投运时间" rules={[{ required: true, message: '请填写投运时间' }]} style={{ flex: 1 }}>
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
          </Space>
          <Form.Item field="remark" label="检修批次 / 备注">
            <Input.TextArea placeholder="如 2025 年度检修 · 1 号调压器整机更换" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={shutdownOpen}
        title={target && isCutoverInterrupted(target) ? '续跑停机切换' : '执行停机切换'}
        onCancel={() => setShutdownOpen(false)}
        onOk={submitShutdown}
        okText="执行 / 续跑"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={shutdownForm} layout="vertical">
          {target && isCutoverInterrupted(target) ? (
            <Alert type="warning" style={{ marginBottom: 12 }} content={replacementStore.stepText(target)} />
          ) : null}
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            content="将登记新设备、把旧设备当前点位复制到新设备（标明来源）、旧设备置停用；历史读数留在旧设备，泄漏单不迁移。"
          />
          <Form.Item field="shutdownDate" label="实际停机时间" rules={[{ required: true, message: '请填写停机时间' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={commissionOpen}
        title="确认新设备投运"
        onCancel={() => setCommissionOpen(false)}
        onOk={submitCommission}
        okText="确认投运"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={commissionForm} layout="vertical">
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            content="新设备转为运行并记录投运时间；旧设备保持停用留档，其历史读数与未归档泄漏单不迁移。"
          />
          <Form.Item field="commissionDate" label="实际投运时间" rules={[{ required: true, message: '请填写投运时间' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
