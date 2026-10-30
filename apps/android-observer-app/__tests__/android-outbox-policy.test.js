import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compiles the app's Java sources with jvm/OutboxPolicyCheck.java and runs the outbox's pure
// delivery rules (which HTTP statuses count as delivered, held for review or retried; back-off;
// message ids; filter) on a desktop JVM. Skipped when no JDK or Android SDK platform is installed.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../app/src/main/java/com/youpi/observer');
const LIBS = path.resolve(HERE, '../app/libs');

function findAndroidJar() {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')]
    .filter(Boolean).find(p => fs.existsSync(path.join(p, 'platforms')));
  if (!sdk) return null;
  const platform = fs.readdirSync(path.join(sdk, 'platforms'))
    .filter(p => fs.existsSync(path.join(sdk, 'platforms', p, 'android.jar')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  return platform ? path.join(sdk, 'platforms', platform, 'android.jar') : null;
}

function findJdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', exe))) return path.join(process.env.JAVA_HOME, 'bin', exe);
  try {
    execFileSync(exe, ['-version'], { stdio: 'ignore' });
    return exe;
  } catch {
    return null;
  }
}

const androidJar = findAndroidJar();
const javac = findJdkTool('javac');
const java = findJdkTool('java');

test('outbox delivery rules run on the JVM', { skip: !(androidJar && javac && java) && 'needs a JDK and an Android SDK platform' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-outbox-check-'));
  try {
    const sources = [...fs.readdirSync(SRC).filter(f => f.endsWith('.java')).map(f => path.join(SRC, f)), path.join(HERE, 'jvm', 'OutboxPolicyCheck.java')];
    const libJars = fs.existsSync(LIBS) ? fs.readdirSync(LIBS).filter(f => f.endsWith('.jar')).map(f => path.join(LIBS, f)) : [];
    const cp = [androidJar, ...libJars].join(path.delimiter);
    execFileSync(javac, ['-nowarn', '-encoding', 'UTF-8', '-cp', cp, '-d', out, ...sources], { stdio: 'pipe' });
    const result = execFileSync(java, ['-cp', [out, cp].join(path.delimiter), 'com.youpi.observer.OutboxPolicyCheck'], { encoding: 'utf8' });
    assert.equal(result.trim(), 'OK');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
