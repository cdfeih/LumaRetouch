import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const env = { ...process.env };
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof packageMetadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(packageMetadata.version)) {
  console.error('package.json 中的版本号无效。');
  process.exit(1);
}
const cachedSdk = path.join(os.homedir(), '.cache/luma-retouch/android-sdk');
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (existsSync(path.join(cachedSdk, 'platforms')) ? cachedSdk : path.join(os.homedir(), 'AppData/Local/Android/Sdk'));
if (!existsSync(path.join(sdk, 'platforms/android-36'))) {
  console.error('未找到 Android SDK 36。安装 Android Studio / SDK，并设置当前终端 ANDROID_HOME 后重试。');
  process.exit(1);
}
env.ANDROID_HOME = sdk; env.ANDROID_SDK_ROOT = sdk;
const cachedJava = path.join(os.homedir(), '.jdks/liberica-21.0.8');
if (!env.JAVA_HOME && existsSync(cachedJava)) env.JAVA_HOME = cachedJava;
if (env.JAVA_HOME) {
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKeys.map((key) => env[key]).find(Boolean) || '';
  for (const key of pathKeys) delete env[key];
  env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${inheritedPath}`;
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.bat') });
  if (result.error || result.status !== 0) { console.error(result.error?.message || 'Android 构建失败'); process.exit(result.status || 1); }
}
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run(process.execPath, ['--experimental-strip-types', 'node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android']);
const gradleName = process.platform === 'win32' ? 'gradle.bat' : 'gradle';
const cachedGradle = path.join(os.homedir(), '.cache/luma-retouch/gradle-8.14.3/bin', gradleName);
const gradle = existsSync(cachedGradle) ? cachedGradle : process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const gradleArgs = ['assembleDebug', '--no-daemon'];
if (env.LUMA_GRADLE_INIT_SCRIPT) {
  const initScript = path.resolve(env.LUMA_GRADLE_INIT_SCRIPT);
  if (!existsSync(initScript)) { console.error('LUMA_GRADLE_INIT_SCRIPT 指定的 Gradle init 脚本不存在。'); process.exit(1); }
  gradleArgs.push('-I', initScript);
}
run(gradle, gradleArgs, path.resolve('android'));
mkdirSync('release/android', { recursive: true });
const apkOutput = `release/android/LumaRetouch-${packageMetadata.version}-debug.apk`;
copyFileSync('android/app/build/outputs/apk/debug/app-debug.apk', apkOutput);
console.log(`Android APK：${apkOutput}（开发签名，适合侧载测试）`);
