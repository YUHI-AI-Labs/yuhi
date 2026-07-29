/** Single source of truth for the Yuhi version string used in manifests/audit. */
export const YUHI_VERSION = "0.1.0";

/** Config file + schema constants. `yuhi.yaml` is canonical; alternates are
 * accepted so the AI-context policy can live under a standard-looking name. */
export const CONFIG_FILENAME = "yuhi.yaml";
export const ALT_CONFIG_FILENAMES = ["yuhi.yaml", ".aicontext", "yuhi.context"] as const;
export const CONFIG_VERSION = "1";
