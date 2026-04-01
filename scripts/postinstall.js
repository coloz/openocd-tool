"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OPENOCD_VERSION = "0.12.0-7";
const BASE_URL = `https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v${OPENOCD_VERSION}`;
const INSTALL_DIR = path.join(__dirname, "..", "vendor");

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  const map = {
    "win32-x64": { name: `xpack-openocd-${OPENOCD_VERSION}-win32-x64.zip`, ext: "zip" },
    "linux-x64": { name: `xpack-openocd-${OPENOCD_VERSION}-linux-x64.tar.gz`, ext: "tar.gz" },
    "linux-arm64": { name: `xpack-openocd-${OPENOCD_VERSION}-linux-arm64.tar.gz`, ext: "tar.gz" },
    "darwin-x64": { name: `xpack-openocd-${OPENOCD_VERSION}-darwin-x64.tar.gz`, ext: "tar.gz" },
    "darwin-arm64": { name: `xpack-openocd-${OPENOCD_VERSION}-darwin-arm64.tar.gz`, ext: "tar.gz" },
  };

  const key = `${platform}-${arch}`;
  const info = map[key];
  if (!info) {
    throw new Error(`不支持的平台: ${key}，支持的平台: ${Object.keys(map).join(", ")}`);
  }

  return { ...info, url: `${BASE_URL}/${info.name}` };
}

function download(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败，HTTP ${res.statusCode}: ${url}`));
      }

      const contentLength = parseInt(res.headers["content-length"], 10) || 0;
      const chunks = [];
      let downloaded = 0;

      res.on("data", (chunk) => {
        chunks.push(chunk);
        downloaded += chunk.length;
        if (contentLength > 0) {
          const pct = ((downloaded / contentLength) * 100).toFixed(1);
          process.stdout.write(`\r  下载进度: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      res.on("end", () => {
        process.stdout.write("\n");
        resolve(Buffer.concat(chunks));
      });

      res.on("error", reject);
    }).on("error", reject);
  });
}

function extractZip(buffer, destDir) {
  const tmpFile = path.join(destDir, "_tmp.zip");
  fs.writeFileSync(tmpFile, buffer);

  try {
    // Use PowerShell on Windows to extract zip
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${tmpFile}' -DestinationPath '${destDir}' -Force`,
    ], { windowsHide: true });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function extractTarGz(buffer, destDir) {
  const tmpFile = path.join(destDir, "_tmp.tar.gz");
  fs.writeFileSync(tmpFile, buffer);

  try {
    execFileSync("tar", ["xzf", tmpFile, "-C", destDir], { windowsHide: true });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function install() {
  const platformInfo = getPlatformInfo();
  const extractedDir = path.join(INSTALL_DIR, `xpack-openocd-${OPENOCD_VERSION}`);
  const binName = process.platform === "win32" ? "openocd.exe" : "openocd";
  const binPath = path.join(extractedDir, "bin", binName);

  // 已安装则跳过
  if (fs.existsSync(binPath)) {
    console.log(`openocd 已安装: ${binPath}`);
    return;
  }

  console.log(`正在安装 OpenOCD ${OPENOCD_VERSION} (${process.platform}-${process.arch})...`);
  console.log(`  下载: ${platformInfo.url}`);

  // 创建目录
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // 下载
  const buffer = await download(platformInfo.url);
  console.log("  正在解压...");

  // 解压
  if (platformInfo.ext === "zip") {
    extractZip(buffer, INSTALL_DIR);
  } else {
    extractTarGz(buffer, INSTALL_DIR);
  }

  // 验证
  if (!fs.existsSync(binPath)) {
    throw new Error(`安装失败: 未找到 ${binPath}`);
  }

  // Linux/macOS 设置可执行权限
  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }

  console.log(`  安装完成: ${binPath}`);
}

install().catch((err) => {
  console.error(`OpenOCD 安装失败: ${err.message}`);
  process.exit(1);
});
