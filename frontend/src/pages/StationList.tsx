/**
 * /stations 调压站与设备台账
 * 新建站点与设备、按压力等级与设备类型筛选；卡片回显设备数与待处置泄漏数。
 * 消费 Station、Device；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useLeakStore } from '@/stores/leakStore'
import { useReplacementStore } from '@/stores/replacementStore'
import {
  DEVICE_STATES,
  DEVICE_TYPES,
  EMPTY_DEVICE_DRAFT,
  isReplacementDevice,
  isRetiredDevice,
  type Device,
  type DeviceDraft,
  type DeviceState,
  type DeviceType
} from '@/types/device'
import {
  EMPTY_STATION_DRAFT,
  STATION_GRADES,
  formatFlow,
  formatPressure,
  type Station,
  type StationDraft,
  type StationGrade
} from '@/types/station'

export default function StationList() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()
  const replacementStore = useReplacementStore()

  const [stationForm] = Form.useForm<StationDraft>()
  const [deviceForm] = Form.useForm<DeviceDraft>()
  const [stationOpen, setStationOpen] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const [editingStationId, setEditingStationId] = useState<string | null>(null)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)

  const filter = stationStore.filter
  const filtered = stationStore.filteredStations()
  const currentStation = stationStore.currentStation()
  const devices = currentStation ? stationStore.devicesOfStation(currentStation.id) : []

  const filterSelects = useMemo(
    () => [
      { key: 'grades', label: '压力等级', options: STATION_GRADES.map((item) => ({ label: item, value: item })) },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    []
  )

  const model: FilterModel = { keyword: filter.keyword, grades: filter.grades, deviceTypes: filter.deviceTypes }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchFilter({
      keyword: String(next.keyword ?? ''),
      grades: (Array.isArray(next.grades) ? next.grades : []) as StationGrade[],
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as DeviceType[]
    })
  }

  const openLeakOf = (stationId: string): number =>
    leakStore.leaks.filter((leak) => leak.stationId === stationId && leak.state !== '已复检').length

  const missedOf = (stationId: string): number =>
    patrolStore.patrols.filter((patrol) => patrol.stationId === stationId && patrol.state === '漏检').length

  const openCreateStation = (): void => {
    setEditingStationId(null)
    stationForm.setFieldsValue({ ...EMPTY_STATION_DRAFT })
    setStationOpen(true)
  }

  const openEditStation = (station: Station): void => {
    setEditingStationId(station.id)
    stationForm.setFieldsValue({
      name: station.name,
      location: station.location,
      designFlowM3h: station.designFlowM3h,
      inletPressureMpa: station.inletPressureMpa,
      grade: station.grade,
      commissionDate: station.commissionDate
    })
    setStationOpen(true)
  }

  const submitStation = async (): Promise<void> => {
    const values = await stationForm.validate().catch(() => null)
    if (!values) return
    if (editingStationId) {
      await stationStore.updateStation(editingStationId, values)
      Message.success('调压站信息已更新')
    } else {
      await stationStore.createStation(values)
      Message.success('调压站已创建，可继续登记设备')
    }
    setStationOpen(false)
  }

  const removeStation = async (station: Station): Promise<void> => {
    await stationStore.removeStation(station.id)
    Message.success('调压站及其下游数据已删除')
  }

  const openCreateDevice = (): void => {
    if (!currentStation) {
      Message.warning('请先选择或新建一个调压站')
      return
    }
    setEditingDeviceId(null)
    deviceForm.setFieldsValue({ ...EMPTY_DEVICE_DRAFT, stationId: currentStation.id })
    setDeviceOpen(true)
  }

  const openEditDevice = (device: Device): void => {
    setEditingDeviceId(device.id)
    deviceForm.setFieldsValue({
      stationId: device.stationId,
      type: device.type,
      model: device.model,
      serialNo: device.serialNo,
      installDate: device.installDate,
      state: device.state
    })
    setDeviceOpen(true)
  }

  const submitDevice = async (): Promise<void> => {
    const values = await deviceForm.validate().catch(() => null)
    if (!values) return
    if (editingDeviceId) {
      await stationStore.updateDevice(editingDeviceId, values)
      Message.success('设备已更新')
    } else {
      await stationStore.createDevice(values)
      Message.success('设备已登记，可继续配置点位标准值')
    }
    setDeviceOpen(false)
  }

  const removeDevice = async (device: Device): Promise<void> => {
    if (device.replacementId || device.replacedFromDeviceId) {
      Message.warning('该设备已纳入整机更换台账，不能删除，请在设备更换页查看/处理')
      return
    }
    try {
      await stationStore.removeDevice(device.id)
      Message.success('设备及其点位、处置单已删除')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const deviceColumns: TableColumnProps<Device>[] = [
    {
      title: '设备类型',
      width: 110,
      render: (_value, record) => (
        <Space size={4}>
          <Tag color="arcoblue">{record.type}</Tag>
          {isRetiredDevice(record) ? (
            <Tooltip content="年度检修整机更换后停机保留，历史读数/点位/泄漏单仍挂本机">
              <Tag color="gray" size="small">旧机留档</Tag>
            </Tooltip>
          ) : null}
          {isReplacementDevice(record) ? (
            <Tooltip content={`整机更换后的接替新设备，来源设备 ${record.replacedFromDeviceId}`}>
              <Tag color="green" size="small">接替新机</Tag>
            </Tooltip>
          ) : null}
        </Space>
      )
    },
    { title: '型号', dataIndex: 'model', width: 150 },
    { title: '出厂编号', dataIndex: 'serialNo', width: 170 },
    {
      title: '投用 / 停机',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>投用 {record.installDate || '—'}</span>
          {record.shutdownDate ? <span className="muted">停机 {record.shutdownDate}</span> : null}
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (value: DeviceState) => (
        <Tag color={value === '运行' ? 'green' : value === '检修' ? 'orange' : 'gray'}>{value}</Tag>
      )
    },
    {
      title: '点位数',
      width: 90,
      render: (_value, record) => stationStore.pointsOfDevice(record.id).length
    },
    {
      title: '操作',
      width: 300,
      render: (_value, record) => {
        const retired = isRetiredDevice(record)
        const replaced = isReplacementDevice(record)
        return (
          <Space size={4} wrap>
            <Button
              type="text"
              size="small"
              disabled={retired}
              onClick={() => (retired ? Message.info('旧机已停机留档，不再编辑') : openEditDevice(record))}
            >
              编辑
            </Button>
            {retired || replaced ? (
              <Tooltip content="整机更换台账中的设备不能直接删除，避免历史读数/泄漏单错挂">
                <Button type="text" size="small" status="danger" disabled>
                  删除
                </Button>
              </Tooltip>
            ) : (
              <Popconfirm title="删除该设备将级联删除其点位与泄漏处置单；整机更换请走「设备更换」" onOk={() => removeDevice(record)}>
                <Button type="text" size="small" status="danger">
                  删除
                </Button>
              </Popconfirm>
            )}
            <Button
              type="text"
              size="small"
              disabled={retired || replaced}
              onClick={() => {
                if (retired || replaced) return
                navigate('/replacements')
              }}
            >
              {retired || replaced ? '已纳入更换' : '整机更换'}
            </Button>
            {retired || replaced ? (
              <Button type="text" size="small" onClick={() => navigate('/replacements')}>
                更换台账
              </Button>
            ) : null}
            <Button
              type="text"
              size="small"
              onClick={() => {
                stationStore.patchPointFilter({ stationId: record.stationId, keyword: '' })
                navigate('/points')
              }}
            >
              点位配置
            </Button>
          </Space>
        )
      }
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">调压站与设备台账</h2>
          <p className="page-head__desc">先建站点再登记设备；卡片回显设备数、待处置泄漏数与漏检次数。</p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => navigate('/replacements')}>设备更换台账</Button>
          <Button type="primary" onClick={openCreateStation}>
            新建调压站
          </Button>
          <Button disabled={!currentStation} onClick={openCreateDevice}>
            登记设备
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="调压站" value={stationStore.stations.length} suffix="座" tone="primary" />
        <StatBadge label="设备" value={stationStore.devices.length} suffix="台" tone="info" />
        <StatBadge label="巡检点位" value={stationStore.pointStats().total} suffix="个" tone="default" />
        <StatBadge label="待处置泄漏" value={leakStore.counts()['待处置']} suffix="单" tone="danger" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索站名 / 位置" onModelChange={onModelChange} />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">调压站列表（{filtered.length}）</h3>
          {filtered.length === 0 ? (
            <EmptyPanel
              title="还没有调压站"
              description="新建调压站后即可登记设备与点位。"
              actionText="新建调压站"
              onAction={openCreateStation}
              compact
            />
          ) : (
            filtered.map((station) => (
              <div
                key={station.id}
                className={`card-list-item${station.id === stationStore.currentStationId ? ' is-active' : ''}`}
                onClick={() => stationStore.selectStation(station.id)}
              >
                <div className="card-list-item__head">
                  <span>{station.name}</span>
                  <Tag color="arcoblue">{station.grade}</Tag>
                </div>
                <div className="card-list-item__meta">
                  <span>{station.location}</span>
                  <span>· 设计 {formatFlow(station.designFlowM3h)}</span>
                  <span>· 进口 {formatPressure(station.inletPressureMpa)}</span>
                </div>
                <div className="card-list-item__meta">
                  <span>设备 {stationStore.devicesOfStation(station.id).length}</span>
                  <span>· 点位 {stationStore.points.filter((point) => point.stationId === station.id).length}</span>
                  <span style={{ color: openLeakOf(station.id) > 0 ? '#f53f3f' : undefined }}>
                    · 待处置泄漏 {openLeakOf(station.id)}
                  </span>
                  <span style={{ color: missedOf(station.id) > 0 ? '#ff7d00' : undefined }}>· 漏检 {missedOf(station.id)}</span>
                </div>
                <div className="card-list-item__meta" style={{ gap: 8 }}>
                  <Button
                    type="text"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation()
                      openEditStation(station)
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm title="删除站点会级联删除设备、点位、巡检与处置单" onOk={() => removeStation(station)}>
                    <Button type="text" size="small" status="danger" onClick={(event) => event.stopPropagation()}>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              设备明细{currentStation ? ` · ${currentStation.name}` : ''}
            </h3>
            <span className="muted">共 {devices.length} 台设备</span>
          </div>
          {devices.length === 0 ? (
            <EmptyPanel
              title="该站点暂无设备"
              description="登记调压器、过滤器、切断阀或放散阀后即可配置点位标准值。"
              actionText="登记设备"
              onAction={openCreateDevice}
              compact
            />
          ) : (
            <>
              {currentStation &&
              replacementStore.replacements.some(
                (item) =>
                  item.stationId === currentStation.id &&
                  item.state === '已登记' &&
                  item.completedSteps.length > 0
              ) ? (
                <div style={{ marginBottom: 10 }}>
                  <Tag color="orange" size="small">
                    存在中断的停机切换，请到「设备更换台账」续跑，避免新旧设备点位不一致
                  </Tag>
                  <Button type="text" size="small" onClick={() => navigate('/replacements')}>
                    前往续跑
                  </Button>
                </div>
              ) : null}
              <Table<Device> rowKey="id" size="small" border data={devices} columns={deviceColumns} pagination={false} />
            </>
          )}
        </div>
      </div>

      <Modal
        visible={stationOpen}
        title={editingStationId ? '编辑调压站' : '新建调压站'}
        onCancel={() => setStationOpen(false)}
        onOk={submitStation}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={stationForm} layout="vertical" initialValues={EMPTY_STATION_DRAFT}>
          <Form.Item field="name" label="调压站名称" rules={[{ required: true, message: '请填写调压站名称' }]}>
            <Input placeholder="如 城东高中压调压站" />
          </Form.Item>
          <Form.Item field="location" label="位置" rules={[{ required: true, message: '请填写位置' }]}>
            <Input placeholder="如 城东工业园区 A 区" />
          </Form.Item>
          <Form.Item field="grade" label="压力等级" rules={[{ required: true, message: '请选择压力等级' }]}>
            <Select options={STATION_GRADES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="designFlowM3h" label="设计流量(m³/h)" rules={[{ required: true, message: '请填写设计流量' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="inletPressureMpa" label="进口压力(MPa)" rules={[{ required: true, message: '请填写进口压力' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="commissionDate" label="投运日期" rules={[{ required: true, message: '请填写投运日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={deviceOpen}
        title={editingDeviceId ? '编辑设备' : '登记设备'}
        onCancel={() => setDeviceOpen(false)}
        onOk={submitDevice}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={deviceForm} layout="vertical" initialValues={EMPTY_DEVICE_DRAFT}>
          <Form.Item label="所属调压站">
            <Input value={currentStation ? currentStation.name : ''} disabled />
          </Form.Item>
          <Form.Item field="type" label="设备类型" rules={[{ required: true, message: '请选择设备类型' }]}>
            <Select options={DEVICE_TYPES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如 RTZ-80/0.4" />
          </Form.Item>
          <Form.Item field="serialNo" label="出厂编号" rules={[{ required: true, message: '请填写出厂编号' }]}>
            <Input placeholder="如 SN20160520-01" />
          </Form.Item>
          <Form.Item field="installDate" label="投用日期" rules={[{ required: true, message: '请填写投用日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="state" label="设备状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={DEVICE_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
