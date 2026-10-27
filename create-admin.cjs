
require("dotenv").config();

const readline = require("readline");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");

    let answer = "";

    function onData(char) {
      if (char === "\u0003") {
        stdout.write("\nCancelled.\n");
        cleanup();
        process.exit(1);
      }

      if (char === "\r" || char === "\n") {
        stdout.write("\n");
        cleanup();
        resolve(answer);
        return;
      }

      if (char === "\u007f" || char === "\b") {
        answer = answer.slice(0, -1);
        return;
      }

      if (char >= " ") {
        answer += char;
      }
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    }

    stdin.on("data", onData);
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing from .env");
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing from .env");
  }

  const fullName = (await ask("Super Admin full name: ")).trim();
  const email = (await ask("Super Admin email: "))
    .trim()
    .toLowerCase();
  const password = await askHidden("Create password (12+ characters): ");

  if (!fullName || !email.includes("@")) {
    throw new Error("Enter a valid name and email address.");
  }

  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
  });

  try {
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new Error(
        "This email already exists. No account was changed."
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const admin = await prisma.user.create({
      data: {
        fullName,
        email,
        passwordHash,
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
      },
    });

    console.log("\nSuper Admin created successfully!");
    console.log(JSON.stringify(admin, null, 2));
    console.log("You can now use this account to log in.");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .catch((error) => {
    console.error("\nAdmin setup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
