#!/usr/bin/env node
"use strict";

const { detect, flashFirmware } = require("../lib");

const HELP_TEXT = `
openocd-tool - STM32/GD32 调试器检测与固件烧录工具

用法:
  openocd-tool <command> [options]

命令:
  detect                检测已连接的调试器设备 (ST-Link / DAPLink)
  flash <firmware>      烧录固件到目标芯片

检测选项:
      --json                以 JSON 格式输出检测结果

烧录选项:
  -t, --target <name>       目标芯片 (必须), 如 stm32f1x, stm32f4x, gd32e23x
  -i, --interface <type>    调试器接口: stlink (默认) 或 cmsis-dap
  -p, --transport <type>    传输协议: swd (默认) 或 jtag
  -s, --speed <kHz>         适配器速度, 默认 4000
  -a, --address <hex>       .bin 文件基地址, 默认 0x08000000
      --no-verify           烧录后不校验
      --no-reset            烧录后不复位
      --erase-all           全片擦除
      --timeout <ms>        超时时间, 默认 60000

通用选项:
  -h, --help                显示帮助信息
  -v, --version             显示版本号

示例:
  openocd-tool detect
  openocd-tool flash firmware.hex -t stm32f1x
  openocd-tool flash firmware.bin -t stm32f4x -a 0x08000000
  openocd-tool flash firmware.hex -t stm32f1x -i cmsis-dap
  openocd-tool flash app.elf -t gd32e23x --no-reset
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    firmware: null,
    target: null,
    interface: "stlink",
    transport: "swd",
    speed: 4000,
    address: 0x08000000,
    verify: true,
    reset: true,
    eraseAll: false,
    timeout: 60000,
    json: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        return result;
      case "-v":
      case "--version":
        result.version = true;
        return result;
      case "detect":
      case "flash":
        result.command = arg;
        if (arg === "flash" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
          result.firmware = args[++i];
        }
        break;
      case "-t":
      case "--target":
        result.target = args[++i];
        break;
      case "-i":
      case "--interface":
        result.interface = args[++i];
        break;
      case "-p":
      case "--transport":
        result.transport = args[++i];
        break;
      case "-s":
      case "--speed":
        result.speed = parseInt(args[++i], 10);
        break;
      case "-a":
      case "--address":
        result.address = parseInt(args[++i], 16);
        break;
      case "--no-verify":
        result.verify = false;
        break;
      case "--no-reset":
        result.reset = false;
        break;
      case "--erase-all":
        result.eraseAll = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i], 10);
        break;
      default:
        // 如果还没有 command，可能是直接传了固件路径
        if (!result.command && !arg.startsWith("-")) {
          console.error(`未知命令: ${arg}`);
          console.error('使用 "openocd-tool --help" 查看帮助');
          process.exit(1);
        } else if (result.command === "flash" && !result.firmware && !arg.startsWith("-")) {
          result.firmware = arg;
        } else {
          console.error(`未知选项: ${arg}`);
          console.error('使用 "openocd-tool --help" 查看帮助');
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || (!opts.command && !opts.version)) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (opts.version) {
    const pkg = require("../package.json");
    console.log(`openocd-tool v${pkg.version}`);
    process.exit(0);
  }

  if (opts.command === "detect") {
    const devices = await detect();
    if (opts.json) {
      console.log(JSON.stringify(devices, null, 2));
    } else {
      if (devices.length === 0) {
        console.log("\u672a\u68c0\u6d4b\u5230\u5df2\u8fde\u63a5\u7684 ST-Link \u6216 DAPLink \u8bbe\u5907\u3002");
        console.log("\n\u8bf7\u786e\u4fdd\uff1a");
        console.log("  1. \u8bbe\u5907\u5df2\u901a\u8fc7 USB \u8fde\u63a5\u5230\u7535\u8111");
        console.log("  2. \u5df2\u5b89\u88c5\u6b63\u786e\u7684 USB \u9a71\u52a8\u7a0b\u5e8f");
        console.log("     - ST-Link: \u5b89\u88c5 ST-LINK USB Driver (STSW-LINK009)");
        console.log("     - DAPLink: \u901a\u5e38\u514d\u9a71\u52a8\uff0cWindows \u81ea\u5e26 WinUSB \u652f\u6301");
      } else {
        console.log(`\u5171\u68c0\u6d4b\u5230 ${devices.length} \u4e2a\u8c03\u8bd5\u5668\u8bbe\u5907\uff1a\n`);
        devices.forEach((device, index) => {
          console.log(`  [${index + 1}] ${device.type}`);
          console.log(`      \u63cf\u8ff0: ${device.description}`);
          console.log(`      VID:PID = ${device.vid}:${device.pid}`);
          if (device.serial) {
            console.log(`      \u5e8f\u5217\u53f7: ${device.serial}`);
          }
          if (device.targetVoltage) {
            console.log(`      \u76ee\u6807\u7535\u538b: ${device.targetVoltage}`);
          }
          console.log();
        });
      }
    }
    return;
  }

  if (opts.command === "flash") {
    if (!opts.firmware) {
      console.error("错误: 请指定固件文件路径");
      console.error('用法: openocd-tool flash <firmware> -t <target>');
      process.exit(1);
    }
    if (!opts.target) {
      console.error("错误: 请指定目标芯片 (-t/--target)");
      console.error("例如: -t stm32f1x, -t stm32f4x, -t gd32e23x");
      process.exit(1);
    }

    const result = await flashFirmware({
      firmwarePath: opts.firmware,
      target: opts.target,
      interface: opts.interface,
      transport: opts.transport,
      speed: opts.speed,
      baseAddress: opts.address,
      verify: opts.verify,
      reset: opts.reset,
      eraseAll: opts.eraseAll,
      timeout: opts.timeout,
    });

    if (result.success) {
      console.log("\u70e7\u5f55\u6210\u529f\uff01");
      if (opts.verify && result.output && result.output.includes("Verified OK")) {
        console.log("\u6821\u9a8c\u901a\u8fc7\u3002");
      }
    } else {
      console.error("\u70e7\u5f55\u5931\u8d25\uff01");
      if (result.output) {
        const errorLines = result.output
          .split("\n")
          .filter((l) => /error|fail|unable/i.test(l));
        if (errorLines.length > 0) {
          console.error("\u9519\u8bef\u4fe1\u606f:");
          errorLines.forEach((l) => console.error(`  ${l.trim()}`));
        }
      }
    }

    process.exit(result.success ? 0 : 1);
  }
}

main().catch((err) => {
  console.error("执行出错:", err.message);
  process.exit(1);
});
