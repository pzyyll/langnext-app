import { Image, View, type Accessor } from "nsh";
import googleCloudIcon from "../../../assets/icons/google-cloud.svg";
import googleIcon from "../../../assets/icons/google.svg";
import { Icon } from "../../components/ui/icon";
import { ProviderMark } from "../../modules/ai/ui/provider-mark";
import type { PresetChannelMark } from "./model-choices";

interface PresetMarkProps {
  mark: Accessor<PresetChannelMark | null>;
  testID?: string;
  class?: string;
}

/** Leads a preset summary with its channel mark: DeepL, a Google service, or the primary model's channel. */
export function PresetMark(props: PresetMarkProps) {
  const iconClass = () => `overflow-hidden ${props.class ?? "size-3 shrink-0"}`;
  const providerPresentation = () => {
    const mark = props.mark();
    return mark?.kind === "provider" ? mark.presentation : null;
  };

  return (
    <If when={props.mark() !== null}>
      <View testID={props.testID} class="shrink-0 flex-row items-center justify-center">
        <If
          when={providerPresentation()}
          else={
            <If
              when={props.mark()?.kind === "google-cloud"}
              else={
                <If
                  when={props.mark()?.kind === "google-web"}
                  else={<Icon name="deepl" tone="foreground" class={iconClass()} />}
                >
                  <Image
                    testID={props.testID ? `${props.testID}-google-web` : undefined}
                    src={googleIcon}
                    accessibilityElementsHidden={true}
                    class={iconClass()}
                  />
                </If>
              }
            >
              <Image src={googleCloudIcon} accessibilityElementsHidden={true} class={iconClass()} />
            </If>
          }
        >
          {(presentation) => <ProviderMark presentation={presentation()} class={iconClass()} />}
        </If>
      </View>
    </If>
  );
}
