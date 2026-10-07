/**
 * 设备更换记录台账（本调压站）
 * 展示旧/新设备、停机与投运时间、复制点位数与状态；支持对中断记录「接着续跑」、
 * 对待投运记录「登记投运」。旧设备历史读数与泄漏单不迁移，仅在此留痕。
 */
import { useState } from 'react'
import { Button, Message, Modal, Space, Table, Tag } from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import { useStationStore } from '@/stores/stationStore'
import { useReplacementStore } from '@/stores/replacementStore'
import { isRetiredDevice } from '@/types/device'
import { REPLACEMENT_STATE_LABEL, type Replacement } from '@/types/replacement'

interface ReplacementHistoryProps {
  visible: boolean
  onClose: () => void
}

const STATE_COLOR: Record<Replacement['state'], string> = {
  已登记: 'arcoblue',
  停机中: 'orange',
  已停机待投运: 'gold',
  已完成: 'green',
  失败: 'red'
}

export function ReplacementHistory({ visible, onClose }: ReplacementHistoryProps) {
  const stationStore = useStationStore()
  const replacementStore = useReplacementStore()
  const [submittingId, setSubmittingId] = useState<string | null>(null)

  const stationId = stationStore.currentStationId
  const records = stationId ? replacementStore.ofStation(stationId) : []

  const resume = async (record: Replacement): Promise<void> => {
    setSubmittingId(record.id)
    try {
      await replacementStore.resume(record.id)
      Message.success('已接着上次进度完成迁移')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '续跑失败')
    } finally {
      setSubmittingId(null)
    }
  }

  const commit = async (record: Replacement): Promise<void> => {
    setSubmittingId(record.id)
    try {
      await replacementStore.commit(record.id, record.commissionDate)
      Message.success('新设备已投运，旧设备退役并保留历史')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '投运失败')
    } finally {
      setSubmittingId(null)
    }
  }

  const shutdown = async (record: Replacement): Promise<void> => {
    setSubmittingId(record.id)
    try {
      await replacementStore.shutdown(record.id)
      Message.success('已停机，旧设备当前点位已复制到新设备，等待登记投运')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '停机失败')
    } finally {
      setSubmittingId(null)
    }
  }

  const deviceText = (id: string): string => {
    const device = stationStore.devices.find((item) => item.id === id)
    return device ? `${device.type} ${device.model}（${device.serialNo}）` : id
  }

  const columns: TableColumnProps<Replacement>[] = [
    {
      title: '状态',
      dataIndex: 'state',
      width: 120,
      render: (value: Replacement['state']) => <Tag color={STATE_COLOR[value]}>{REPLACEMENT_STATE_LABEL[value]}</Tag>
    },
    { title: '旧设备（保留历史）', width: 220, render: (_v, record) => {
      const old = stationStore.devices.find((d) => d.id === record.oldDeviceId)
      return (
        <Space size={4}>
          <span>{deviceText(record.oldDeviceId)}</span>
          {old && isRetiredDevice(old) ? <Tag size="small" color="gray">已退役</Tag> : null}
        </Space>
      )
    } },
    { title: '新设备', width: 220, render: (_v, record) => deviceText(record.newDeviceId) },
    { title: '停机时间', dataIndex: 'shutdownDate', width: 110 },
    { title: '投运时间', dataIndex: 'commissionDate', width: 110, render: (value: string, record) => (record.state === '已完成' ? value : '待投运') },
    {
      title: '复制点位',
      width: 100,
      render: (_v, record) => `${record.copiedPointIds.length}/${record.sourcePointIds.length}`
    },
    {
      title: '操作',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          {record.state === '失败' || record.state === '停机中' ? (
            <Button type="text" size="small" loading={submittingId === record.id} onClick={() => resume(record)}>
              续跑
            </Button>
          ) : null}
          {record.state === '已停机待投运' ? (
            <Button type="primary" size="mini" loading={submittingId === record.id} onClick={() => commit(record)}>
              登记投运
            </Button>
          ) : null}
          {record.state === '已登记' ? (
            <Button type="text" size="small" loading={submittingId === record.id} onClick={() => shutdown(record)}>
              去停机
            </Button>
          ) : null}
          {record.state === '已完成' ? <span className="muted">—</span> : null}
        </Space>
      )
    }
  ]

  return (
    <Modal
      visible={visible}
      title={`设备更换记录${stationStore.currentStation() ? ` · ${stationStore.currentStation()?.name}` : ''}`}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      unmountOnExit
      style={{ width: 960 }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        更换只复制当前巡检点位并标明来源；旧设备读数与未闭环泄漏单保留在旧设备，泄漏单需到「泄漏处置」人工归档。
      </p>
      {records.length === 0 ? (
        <div className="empty-inline">本站暂无设备更换记录。年度检修整机更换时，请在设备明细中点击「整机更换」。</div>
      ) : (
        <Table<Replacement> rowKey="id" size="small" border data={records} columns={columns} pagination={false} scroll={{ x: 1100 }} />
      )}
    </Modal>
  )
}
