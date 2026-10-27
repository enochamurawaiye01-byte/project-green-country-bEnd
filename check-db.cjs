
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    console.log("SUCCESS: Prisma connected to Supabase!");
    console.log("Your database connection is working.");
  } catch (error) {
    console.error("DATABASE CONNECTION FAILED:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

checkDatabase();
