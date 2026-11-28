import { Scroll, View, type Bounds, type JSX, type ScrollProps } from "nsh";
import { t } from "nsh/i18n";
import { ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable";

export const MIN_STREAM_PANEL_HEIGHT = 110;
export const MIN_DICTIONARY_DRAWER_HEIGHT = 88;
export const DEFAULT_DICTIONARY_DRAWER_HEIGHT = 212;
export const MAX_DICTIONARY_DRAWER_HEIGHT = 480;

export interface QuickTranslateSplitLayoutProps {
  scrollTestID: string;
  onScroll?: ScrollProps["onScroll"];
  onContentLayout?: (bounds: Bounds) => void;
  content: JSX.Element;
  drawerOpen: boolean;
  drawerSize: number;
  maxDrawerHeight?: number;
  onDrawerResize: (height: number) => void;
  drawer: JSX.Element;
}

/** Shared vertical split separating the scrollable translation stream from the docked dictionary drawer. */
export function QuickTranslateSplitLayout(props: QuickTranslateSplitLayoutProps) {
  return (
    <ResizablePanelGroup
      testID="quick-translate-split-pane"
      axis="vertical"
      class="min-h-0 flex-1"
      handleAccessibilityLabel={t("dictionary.resizeDrawer")}
      onResize={({ sizes }) => {
        const nextDrawerHeight = sizes[1];
        if (nextDrawerHeight !== undefined && props.drawerOpen) {
          props.onDrawerResize(Math.round(nextDrawerHeight));
        }
      }}
    >
      <ResizablePanel
        testID="quick-translate-stream-panel"
        minSize={props.drawerOpen ? MIN_STREAM_PANEL_HEIGHT : 0}
        class="min-h-0"
      >
        <Scroll testID={props.scrollTestID} class="min-h-0 flex-1" onScroll={props.onScroll}>
          {/* Measure the natural content height, not the scroll viewport. */}
          <View class="shrink-0" onLayout={({ bounds }) => props.onContentLayout?.(bounds)}>
            {props.content}
          </View>
        </Scroll>
      </ResizablePanel>
      <ResizablePanel
        testID="quick-translate-dictionary-panel"
        visible={props.drawerOpen}
        fixed
        size={props.drawerSize}
        minSize={MIN_DICTIONARY_DRAWER_HEIGHT}
        maxSize={props.maxDrawerHeight ?? MAX_DICTIONARY_DRAWER_HEIGHT}
        class="min-h-0"
      >
        {props.drawer}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
