// The Lucide names match OpenPencil v0.14.0's editor icon registry.
import type { Tool } from '@open-pencil/core/editor'
import type { Component } from 'vue'
import MousePointer from '~icons/lucide/mouse-pointer'
import Frame from '~icons/lucide/frame'
import LayoutGrid from '~icons/lucide/layout-grid'
import Square from '~icons/lucide/square'
import Circle from '~icons/lucide/circle'
import Minus from '~icons/lucide/minus'
import Triangle from '~icons/lucide/triangle'
import Star from '~icons/lucide/star'
import PenTool from '~icons/lucide/pen-tool'
import Type from '~icons/lucide/type'
import Hand from '~icons/lucide/hand'
import Group from '~icons/lucide/group'
import Diamond from '~icons/lucide/diamond'
import ComponentSet from '~icons/lucide/component'
import Rows from '~icons/lucide/rows-3'
import Columns from '~icons/lucide/columns-3'
import Grid from '~icons/lucide/grid-3x3'

export const toolIcons: Record<Tool, Component> = {
  SELECT: MousePointer, FRAME: Frame, SECTION: LayoutGrid, RECTANGLE: Square,
  ELLIPSE: Circle, LINE: Minus, POLYGON: Triangle, STAR: Star,
  PEN: PenTool, TEXT: Type, HAND: Hand
}
export const toolLabels: Record<Tool, string> = {
  SELECT: '移动', FRAME: '画板', SECTION: '分区', RECTANGLE: '矩形',
  ELLIPSE: '椭圆', LINE: '线段', POLYGON: '多边形', STAR: '星形',
  PEN: '钢笔', TEXT: '文本', HAND: '抓手'
}
const nodeIcons: Record<string, Component> = {
  ...toolIcons, VECTOR: PenTool, GROUP: Group, COMPONENT: Diamond,
  INSTANCE: Diamond, COMPONENT_SET: ComponentSet
}
const layoutIcons: Record<string, Component> = { VERTICAL: Rows, HORIZONTAL: Columns, GRID: Grid }
export function nodeIcon(node: { type: string; layoutMode: string }): Component {
  return node.type === 'FRAME' && node.layoutMode !== 'NONE'
    ? layoutIcons[node.layoutMode] ?? Frame
    : nodeIcons[node.type] ?? Square
}
