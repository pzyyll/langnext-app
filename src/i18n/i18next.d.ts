// ABOUTME: Augments i18next CustomTypeOptions for typed translation keys.
// ABOUTME: English catalog is the resource shape source of truth.
import "i18next";
import type en from "./locales/en";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}
