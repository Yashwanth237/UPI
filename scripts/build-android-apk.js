import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncAndroidAllowlist } from './sync-android-allowlist.js';
import { parseLanHosts, applyLanHosts } from './android-network-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log('🚀 Starting certified Android APK compilation for YouPI SMS Gateway...');

// Resolve Toolchain Paths dynamically across macOS, Linux, and Windows
const isWin = process.platform === 'win32';

function findBinary(name, winExt = '.exe', searchDirs = []) {
  const binaryName = isWin ? `${name}${winExt}` : name;
  for (const dir of searchDirs) {
    if (!dir) continue;
    const full = path.join(dir, binaryName);
    if (fs.existsSync(full)) return full;
  }
  // Fall back to PATH
  return binaryName;
}

// Locate Android SDK
const androidSdkCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(process.env.HOME || '', 'Library/Android/sdk'),
  path.join(process.env.HOME || '', 'Android/Sdk'),
  path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk'),
  'C:\\Users\\gaura\\scoop\\apps\\android-clt\\current'
].filter(Boolean);

let ANDROID_SDK = androidSdkCandidates.find(p => fs.existsSync(p));
if (!ANDROID_SDK) {
  throw new Error('❌ Android SDK not found! Please set ANDROID_HOME or ANDROID_SDK_ROOT environment variable.');
}

// The app declares compileSdk 34 (app/build.gradle.kts). Build against API 34 and Build-Tools
// 34.x when installed; otherwise fall back to the highest available and say so.
// ANDROID_PLATFORM (e.g. android-34) / ANDROID_BUILD_TOOLS (e.g. 34.0.0) pin a choice.
const PROJECT_COMPILE_SDK = 34;
const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

const buildToolsDir = path.join(ANDROID_SDK, 'build-tools');
let CLT_BUILD_TOOLS = '';
if (fs.existsSync(buildToolsDir)) {
  const versions = fs.readdirSync(buildToolsDir).filter(v => fs.statSync(path.join(buildToolsDir, v)).isDirectory()).sort(byVersionDesc);
  const chosen = process.env.ANDROID_BUILD_TOOLS
    || versions.find(v => v.startsWith(`${PROJECT_COMPILE_SDK}.`))
    || versions[0];
  if (chosen) {
    CLT_BUILD_TOOLS = path.join(buildToolsDir, chosen);
    if (!chosen.startsWith(`${PROJECT_COMPILE_SDK}.`)) {
      console.warn(`⚠️  Build-Tools ${PROJECT_COMPILE_SDK}.x not installed; using ${chosen}.`);
    }
  }
}

const platformsDir = path.join(ANDROID_SDK, 'platforms');
let ANDROID_JAR = '';
if (fs.existsSync(platformsDir)) {
  const platforms = fs.readdirSync(platformsDir).filter(p => fs.existsSync(path.join(platformsDir, p, 'android.jar'))).sort(byVersionDesc);
  const chosen = process.env.ANDROID_PLATFORM
    || platforms.find(p => p === `android-${PROJECT_COMPILE_SDK}`)
    || platforms[0];
  if (chosen) {
    ANDROID_JAR = path.join(platformsDir, chosen, 'android.jar');
    if (chosen !== `android-${PROJECT_COMPILE_SDK}`) {
      console.warn(`⚠️  Platform android-${PROJECT_COMPILE_SDK} not installed; compiling against ${chosen} (targetSdk stays 34).`);
    }
  }
}
if (!ANDROID_JAR) {
  throw new Error(`❌ android.jar not found under ${platformsDir}!`);
}

// Locate Java toolchain
const JAVAC = findBinary('javac', '.exe', [process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : null]);
const KEYTOOL = findBinary('keytool', '.exe', [process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : null]);

// Locate Android build tools binaries
const AAPT = findBinary('aapt', '.exe', [CLT_BUILD_TOOLS]);
const D8 = findBinary('d8', isWin ? '.bat' : '', [CLT_BUILD_TOOLS]);
const ZIPALIGN = findBinary('zipalign', '.exe', [CLT_BUILD_TOOLS]);
const APKSIGNER = findBinary('apksigner', isWin ? '.bat' : '', [CLT_BUILD_TOOLS]);
const JAVA = findBinary('java', '.exe', [process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : null]);

// d8.bat and apksigner.bat break ("The syntax of the command is incorrect") on any argument
// containing a space, such as a Windows user folder "C:\Users\first last". Run the jars they
// wrap directly when present; fall back to the wrappers otherwise.
const D8_JAR = path.join(CLT_BUILD_TOOLS, 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(CLT_BUILD_TOOLS, 'lib', 'apksigner.jar');
const D8_CMD = fs.existsSync(D8_JAR)
  ? `"${JAVA}" -Xmx1024M -cp "${D8_JAR}" com.android.tools.r8.D8`
  : (isWin ? null : `"${D8}"`);
const APKSIGNER_CMD = fs.existsSync(APKSIGNER_JAR)
  ? `"${JAVA}" -jar "${APKSIGNER_JAR}"`
  : (isWin ? null : `"${APKSIGNER}"`);
// Windows without the jars: the original cmd.exe wrapper invocation.
const winWrap = (bin, args) => `cmd.exe /c ""${bin}" ${args}"`;
const runD8 = args => (D8_CMD ? `${D8_CMD} ${args}` : winWrap(D8, args));
const runApksigner = args => (APKSIGNER_CMD ? `${APKSIGNER_CMD} ${args}` : winWrap(APKSIGNER, args));

console.log(`ℹ️  Toolchain:
   Android SDK: ${ANDROID_SDK}
   Build Tools: ${CLT_BUILD_TOOLS}
   Android JAR: ${ANDROID_JAR}
   javac:       ${JAVAC}
   d8:          ${D8}
   aapt:        ${AAPT}
   zipalign:    ${ZIPALIGN}
   apksigner:   ${APKSIGNER}`);

const APP_DIR = path.resolve(REPO_ROOT, 'apps/android-observer-app/app');
const MANIFEST = path.resolve(APP_DIR, 'src/main/AndroidManifest.xml');
const RES_DIR = path.resolve(APP_DIR, 'src/main/res');
const JAVA_DIR = path.resolve(APP_DIR, 'src/main/java/com/youpi/observer');

const WORK_DIR = path.resolve(REPO_ROOT, '.tmp_apk_build');
if (fs.existsSync(WORK_DIR)) {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}
fs.mkdirSync(WORK_DIR, { recursive: true });

const BIN_DIR = path.join(WORK_DIR, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });

// Resources are packaged from a copy, so a LAN cleartext exception (YOUPI_ANDROID_LAN_HOSTS)
// applies to this APK only and never lands in the committed network_security_config.xml.
const LAN_HOSTS = parseLanHosts(process.env.YOUPI_ANDROID_LAN_HOSTS);
const BUILD_RES_DIR = path.join(WORK_DIR, 'res');
fs.cpSync(RES_DIR, BUILD_RES_DIR, { recursive: true });
if (LAN_HOSTS.length) {
  const nscPath = path.join(BUILD_RES_DIR, 'xml', 'network_security_config.xml');
  fs.writeFileSync(nscPath, applyLanHosts(fs.readFileSync(nscPath, 'utf8'), LAN_HOSTS), 'utf8');
  console.log(`ℹ️  Plain HTTP allowed for this build to LAN host(s): ${LAN_HOSTS.join(', ')}`);
}

// One debug signing key per checkout, kept outside the repo (data/.secrets is git-ignored). A new
// key on every build made each rebuilt APK refuse to install over the last one.
const KEYSTORE_PATH = process.env.YOUPI_ANDROID_KEYSTORE || path.resolve(REPO_ROOT, 'data/.secrets/android-debug.keystore');

try {
  // 0. Synchronize banking package allowlist from packages/common/src/upi-providers.js into Java service
  console.log('🔄 [0/6] Synchronizing Android banking package allowlist from @youpi/common...');
  syncAndroidAllowlist();

  // 1. Compile Java Source Code into Bytecode (.class)
  console.log('📦 [1/6] Compiling Java source files with javac...');
  const LIBS_DIR = path.resolve(APP_DIR, 'libs');
  const libJars = fs.existsSync(LIBS_DIR)
    ? fs.readdirSync(LIBS_DIR).filter(f => f.endsWith('.jar')).map(f => path.join(LIBS_DIR, f))
    : [];
  const cpSeparator = process.platform === 'win32' ? ';' : ':';
  const classpath = [ANDROID_JAR, ...libJars].map(p => `"${p}"`).join(cpSeparator);

  const javaFiles = fs.readdirSync(JAVA_DIR)
    .filter(f => f.endsWith('.java'))
    .map(f => `"${path.join(JAVA_DIR, f)}"`)
    .join(' ');

  execSync(`"${JAVAC}" -encoding UTF-8 -cp ${classpath} -d "${BIN_DIR}" ${javaFiles}`, {
    stdio: 'inherit'
  });
  console.log('   ✅ Java compilation succeeded.');

  // 2. Convert .class files to Dalvik Executable (classes.dex) using D8
  console.log('⚡ [2/6] Converting Java bytecode to Dalvik Executable (classes.dex) with D8...');
  const classFiles = [];
  function collectClasses(dir) {
    for (const item of fs.readdirSync(dir)) {
      const p = path.join(dir, item);
      if (fs.statSync(p).isDirectory()) {
        collectClasses(p);
      } else if (p.endsWith('.class')) {
        classFiles.push(p);
      }
    }
  }
  collectClasses(BIN_DIR);

  // Write all input class paths into an argfile (@args.txt) so D8 reads raw paths without shell expansion of '$'
  const d8ArgFile = path.join(WORK_DIR, 'd8_inputs.txt');
  fs.writeFileSync(d8ArgFile, [...classFiles, ...libJars].join('\n'), 'utf8');

  execSync(runD8(`--lib "${ANDROID_JAR}" --output "${WORK_DIR}" @"${d8ArgFile}"`), { stdio: 'inherit' });

  const dexPath = path.join(WORK_DIR, 'classes.dex');
  if (!fs.existsSync(dexPath)) {
    throw new Error('D8 failed to generate classes.dex');
  }
  console.log(`   ✅ Dalvik classes.dex created (${fs.statSync(dexPath).size} bytes).`);

  // 3. Package Resources and compiled binary AndroidManifest.xml into initial APK with AAPT
  console.log('📜 [3/6] Packaging resources & compiled binary AndroidManifest with AAPT...');
  const unalignedApk = path.join(WORK_DIR, 'unaligned.apk');
  execSync(`"${AAPT}" package -f -M "${MANIFEST}" -S "${BUILD_RES_DIR}" -I "${ANDROID_JAR}" -F "${unalignedApk}"`, {
    stdio: 'inherit'
  });

  // Add classes.dex into unaligned APK
  process.chdir(WORK_DIR);
  execSync(`"${AAPT}" add -v "${unalignedApk}" classes.dex`, {
    stdio: 'pipe'
  });
  console.log('   ✅ Base APK packaged with classes.dex and compiled binary manifest.');

  // 4. Align 4-byte boundaries using zipalign
  console.log('📐 [4/6] 4-byte boundary zip-aligning APK...');
  const alignedApk = path.join(WORK_DIR, 'aligned.apk');
  execSync(`"${ZIPALIGN}" -f -v 4 "${unalignedApk}" "${alignedApk}"`, {
    stdio: 'pipe'
  });
  console.log('   ✅ APK 4-byte alignment verified.');

  // 5. Generate Keystore & Sign APK with apksigner (v1, v2, and v3 signatures)
  console.log('🔏 [5/6] Signing APK with Android v2 + v3 cryptographic certificate...');
  const keystorePath = KEYSTORE_PATH;
  const ksPass = 'youpipg123';
  const alias = 'youpi_gateway';

  if (!fs.existsSync(keystorePath)) {
    fs.mkdirSync(path.dirname(keystorePath), { recursive: true });
    execSync(`"${KEYTOOL}" -genkeypair -v -keystore "${keystorePath}" -alias "${alias}" -keyalg RSA -keysize 2048 -validity 10000 -storepass "${ksPass}" -keypass "${ksPass}" -dname "CN=YouPI SMS Gateway, OU=Merchant Payments, O=YouPI PG, L=Mumbai, ST=MH, C=IN"`, {
      stdio: 'pipe'
    });
    console.log(`   ℹ️  Created debug signing key: ${keystorePath}`);
  } else {
    console.log(`   ℹ️  Reusing debug signing key: ${keystorePath}`);
  }

  const signedApk = path.join(WORK_DIR, 'signed.apk');
  execSync(runApksigner(`sign --ks "${keystorePath}" --ks-pass pass:${ksPass} --key-pass pass:${ksPass} --ks-key-alias "${alias}" --out "${signedApk}" "${alignedApk}"`), { stdio: 'inherit' });

  // Verify APK signature
  const verifyOutput = execSync(runApksigner(`verify --verbose "${signedApk}"`), {
    encoding: 'utf8'
  });
  console.log('   ✅ Verification Report:\n' + verifyOutput.trim().split('\n').map(l => '      ' + l).join('\n'));

  // 6. Copy final APK to all distribution endpoints & compute cryptographic checksum
  console.log('🚚 [6/6] Distributing final APK to app portals and calculating SHA-256...');
  const apkBuffer = fs.readFileSync(signedApk);
  const sha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');
  const targets = [
    path.resolve(REPO_ROOT, 'apps/android-observer-app/youpi-sms-gateway.apk'),
    path.resolve(REPO_ROOT, 'apps/payment-api/public/youpi-sms-gateway.apk'),
    path.resolve(REPO_ROOT, 'apps/merchant-admin/public/youpi-sms-gateway.apk')
  ];

  for (const t of targets) {
    const dir = path.dirname(t);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(t, apkBuffer);
    fs.writeFileSync(`${t}.sha256`, `${sha256}  youpi-sms-gateway.apk\n`, 'utf8');
    console.log(`   🎉 Saved signed installable APK: ${t} (${apkBuffer.length.toLocaleString()} bytes)`);
    console.log(`      Checksum saved: ${t}.sha256`);
  }

  console.log(`\n========================================================`);
  console.log(`🔑 Certified APK SHA-256: ${sha256}`);
  console.log(`========================================================`);
  console.log('\n✨ Android APK compilation, signing, and verification completed successfully!');
  if (LAN_HOSTS.length) {
    console.log(`⚠️  This APK allows plain HTTP to ${LAN_HOSTS.join(', ')}. It is for local testing only; do not commit it (git restore the .apk files).`);
  }
} finally {
  try {
    process.chdir(REPO_ROOT);
    if (fs.existsSync(WORK_DIR)) {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    }
  } catch {}
}
