<script setup lang="ts">
import { ToolbarRoot, getToolbarToolSelection, isToolbarToolActive } from '@open-pencil/vue'
import ChevronDown from '~icons/lucide/chevron-down'
import { toolIcons, toolLabels } from './icons.ts'

function closeFlyout(event: Event): void {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}
</script>

<template>
  <ToolbarRoot v-slot="{ tools, activeTool, flyoutSelections, actions }">
    <div class="tool-row" role="toolbar" aria-label="设计工具">
      <div v-for="tool in tools" :key="tool.key" class="tool-group">
        <button type="button" class="tool-button"
          :class="{ active: isToolbarToolActive(tool, activeTool) }"
          :aria-pressed="isToolbarToolActive(tool, activeTool)"
          :aria-label="toolLabels[getToolbarToolSelection(tool, activeTool, flyoutSelections)]"
          :title="`${toolLabels[getToolbarToolSelection(tool, activeTool, flyoutSelections)]} (${tool.shortcut})`"
          @click="actions.setTool(getToolbarToolSelection(tool, activeTool, flyoutSelections))">
          <component :is="toolIcons[getToolbarToolSelection(tool, activeTool, flyoutSelections)]" aria-hidden="true" />
        </button>
        <details v-if="tool.flyout" class="tool-flyout">
          <summary :aria-label="`${toolLabels[tool.key]}工具选项`" :title="`${toolLabels[tool.key]}工具选项`"><ChevronDown /></summary>
          <div class="flyout-menu" role="menu">
            <button v-for="choice in tool.flyout" :key="choice" type="button" role="menuitemradio"
              :aria-checked="activeTool === choice" @click="actions.setTool(choice); closeFlyout($event)">
              <component :is="toolIcons[choice]" aria-hidden="true" />{{ toolLabels[choice] }}
            </button>
          </div>
        </details>
      </div>
    </div>
  </ToolbarRoot>
</template>
