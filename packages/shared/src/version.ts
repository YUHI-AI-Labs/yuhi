/**
 * The RELEASE version, as it appears in manifests, the audit log and
 * `processorVersion` strings.
 *
 * This is deliberately the version users see (`yuhi --version`, the Marketplace
 * listing), NOT `@yuhi/shared`'s own package version — that package is internal and
 * has always sat at 0.1.0, which is why every manifest and audit record claimed
 * `0.1.0` long after 0.4.x shipped.
 *
 * `version.drift.test.ts` asserts this equals the CLI and extension versions, so a
 * release that forgets to bump it fails the suite instead of quietly writing a wrong
 * version into artifacts.
 */
export const YUHI_VERSION = "0.4.7";

/** Config file + schema constants. `yuhi.yaml` is canonical; alternates are
 * accepted so the AI-context policy can live under a standard-looking name. */
export const CONFIG_FILENAME = "yuhi.yaml";
export const ALT_CONFIG_FILENAMES = ["yuhi.yaml", ".aicontext", "yuhi.context"] as const;
export const CONFIG_VERSION = "1";
