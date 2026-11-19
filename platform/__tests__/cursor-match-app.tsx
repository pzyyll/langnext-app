import { mount, signal, Text, View } from "nsh";
import { displays } from "nsh/desktop";
import { resolvePopupPlacement } from "../quick-translate";
import { readCursorAnchor } from "../quick-translate-native";

function DesktopCursorMatchApp() {
  const result = signal("checking");

  const anchor = readCursorAnchor();
  const currentDisplays = displays();
  if (anchor === null) {
    result.set("no-anchor");
  } else {
    const matched = currentDisplays.find((item) => item.id === anchor.displayId);
    const placement = resolvePopupPlacement(anchor, currentDisplays, { width: 420, height: 360 });
    result.set(
      matched && placement.kind === "cursor"
        ? `matched:${matched.id}:${placement.bounds.origin.x},${placement.bounds.origin.y}`
        : `mismatch:${anchor.displayId}`,
    );
  }

  return (
    <View class="p-4">
      <Text testID="cursor-match-result">{result()}</Text>
    </View>
  );
}

mount(DesktopCursorMatchApp);
