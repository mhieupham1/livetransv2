import {
  countAdminAccounts,
  createAdminAccount,
  getAdminAccountByUsername,
  listAdminAccounts,
  updateAdminPassword,
} from "../server/db.ts";
import { encodePasswordHash, generateAdminPassword } from "../server/adminAuth.ts";

// Seed tài khoản quản trị mặc định. Chạy lại nhiều lần không ghi đè mật khẩu đã đổi.
//
//   npm run seed                      tạo admin nếu chưa có (mật khẩu in ra một lần)
//   npm run seed -- --reset admin     đặt lại mật khẩu cho tài khoản đã có
//   SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD  đổi thông tin mặc định
//
// Mật khẩu không bao giờ được ghi vào .env hay vào DB dạng gốc.

type Options = {
  reset: boolean;
  username: string;
  password: string | null;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    reset: false,
    username: (process.env.SEED_ADMIN_USERNAME || "admin").trim() || "admin",
    password: process.env.SEED_ADMIN_PASSWORD?.trim() || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reset") options.reset = true;
    else if (arg === "--username") options.username = (argv[++index] || "").trim();
    else if (arg === "--password") options.password = argv[++index] || null;
  }
  return options;
}

function report(username: string, password: string, verb: string) {
  console.log(`\n${verb} tài khoản quản trị:\n`);
  console.log(`  Tên đăng nhập: ${username}`);
  console.log(`  Mật khẩu:      ${password}\n`);
  console.log("Lưu mật khẩu này ngay — server chỉ lưu hash, không xem lại được.");
  console.log("Đổi mật khẩu sau này: npm run seed -- --reset <tên-đăng-nhập>");
  console.log("Hoặc chạy lại với SEED_ADMIN_PASSWORD=<mật-khẩu-mới>.\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = getAdminAccountByUsername(options.username);

  if (existing && !options.reset) {
    const accounts = listAdminAccounts();
    console.log(`Tài khoản "${existing.username}" đã tồn tại — không ghi đè mật khẩu.`);
    console.log(`Tổng số tài khoản quản trị: ${accounts.length} (${accounts.map((item) => item.username).join(", ")}).`);
    console.log("Để đặt lại mật khẩu: npm run seed -- --reset " + existing.username);
    return;
  }

  const password = options.password || generateAdminPassword();
  if (password.length < 12) {
    throw new Error("Mật khẩu phải dài tối thiểu 12 ký tự.");
  }

  if (existing) {
    updateAdminPassword(existing.username, encodePasswordHash(password));
    report(existing.username, password, "Đã đặt lại mật khẩu");
    return;
  }

  createAdminAccount({ username: options.username, passwordHash: encodePasswordHash(password) });
  report(options.username, password, "Đã tạo");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
