import GoogleSans from "../../assets/fonts/google-sans/GoogleSans-Regular.woff2";
// The darker and italic faces register under the same family; only the first import is read.
import "../../assets/fonts/google-sans/GoogleSans-Medium.woff2";
import "../../assets/fonts/google-sans/GoogleSans-SemiBold.woff2";
import "../../assets/fonts/google-sans/GoogleSans-Italic.woff2";

export interface BundledFont {
  /** The family its files register under, and the value the setting stores. */
  family: string;
  /** The i18n key of its label in the settings. */
  labelKey: string;
}

/** The fonts the app ships, offered beside the system's own. */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: GoogleSans, labelKey: "settings.font.families.googleSans" },
];
