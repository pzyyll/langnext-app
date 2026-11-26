import type { JSX } from "nsh";
import { Progress as BaseProgress } from "nsh/base";

export function Progress(props: { testID?: string; value: number; children?: JSX.Element }) {
  return (
    <BaseProgress
      testID={props.testID}
      value={props.value}
      class="w-full gap-1.5"
      trackClass="h-2 w-full overflow-hidden rounded-full bg-muted"
      indicatorClass="h-full rounded-full bg-primary"
    >
      {props.children}
    </BaseProgress>
  );
}
