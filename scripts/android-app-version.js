import fs from 'node:fs';

/**
 * The observer app's version, which AndroidManifest.xml (used by `npm run build:android:apk`) and
 * app/build.gradle.kts (used by Android Studio / Gradle) must both declare identically.
 * Throws when they differ or are missing, so neither build can ship an unexpected versionCode.
 * @param {string} manifestPath
 * @param {string} gradlePath
 * @returns {{ versionCode: number, versionName: string }}
 */
export function readAppVersion(manifestPath, gradlePath) {
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const gradle = fs.readFileSync(gradlePath, 'utf8');
  const fromManifest = {
    versionCode: Number(/android:versionCode="(\d+)"/.exec(manifest)?.[1]),
    versionName: /android:versionName="([^"]+)"/.exec(manifest)?.[1]
  };
  const fromGradle = {
    versionCode: Number(/versionCode\s*=\s*(\d+)/.exec(gradle)?.[1]),
    versionName: /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1]
  };
  if (!Number.isInteger(fromManifest.versionCode) || !fromManifest.versionName) {
    throw new Error(`AndroidManifest.xml must declare android:versionCode and android:versionName (${manifestPath}).`);
  }
  if (fromManifest.versionCode !== fromGradle.versionCode || fromManifest.versionName !== fromGradle.versionName) {
    throw new Error(`App version mismatch: AndroidManifest.xml ${fromManifest.versionName} (${fromManifest.versionCode}) vs build.gradle.kts ${fromGradle.versionName} (${fromGradle.versionCode}). Set both to the same values.`);
  }
  return fromManifest;
}
