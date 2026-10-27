
const { prisma } = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const ACCOUNT_CREATION_ROLES = {
  SUPER_ADMIN: [
    "SUPER_ADMIN",
    "ADMIN",
    "PROGRAMME_MANAGER",
    "REVIEWER",
    "DATA_ENTRY_OFFICER",
    "REPORT_VIEWER",
  ],
  ADMIN: [
    "PROGRAMME_MANAGER",
    "REVIEWER",
    "DATA_ENTRY_OFFICER",
    "REPORT_VIEWER",
  ],
};

function invalidAccountInput(res, message) {
  return res.status(400).json({
    success: false,
    error: { code: "INVALID_ACCOUNT", message },
  });
}

function registrationDisabled(_req, res) {
  return res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "The requested endpoint was not found.",
    },
  });
}

async function createAccount(req, res) {
  const permittedRoles = ACCOUNT_CREATION_ROLES[req.user?.role];
  if (!permittedRoles) {
    return res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "You are not authorized to create accounts.",
      },
    });
  }

  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body)
  ) {
    return invalidAccountInput(res, "A JSON object is required.");
  }
  const body = req.body || {};
  const allowedFields = new Set(["fullName", "email", "password", "phone", "role"]);
  const unexpectedFields = Object.keys(body).filter(
    (field) => !allowedFields.has(field)
  );
  if (unexpectedFields.length) {
    return invalidAccountInput(res, "The request contains unsupported fields.");
  }

  const fullName =
    typeof body.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password;
  const phone =
    body.phone === undefined || body.phone === null
      ? null
      : typeof body.phone === "string"
        ? body.phone.trim()
        : undefined;
  const role = body.role;

  if (!fullName || fullName.length > 120) {
    return invalidAccountInput(res, "fullName is required and must be at most 120 characters.");
  }
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return invalidAccountInput(res, "A valid email address is required.");
  }
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  ) {
    return invalidAccountInput(res, "password must be between 12 and 128 characters.");
  }
  if (
    phone === undefined ||
    (phone !== null &&
      (phone.length > 32 || !/^[+()\d.\-\s]*$/.test(phone)))
  ) {
    return invalidAccountInput(res, "phone must be a valid phone number of at most 32 characters.");
  }

  if (typeof role !== "string" || !permittedRoles.includes(role)) {
    return res.status(403).json({
      success: false,
      error: {
        code: "ROLE_NOT_PERMITTED",
        message: "You are not authorized to grant the requested role.",
      },
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const outcome = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName,
          email,
          passwordHash,
          phone,
          role,
          status: "ACTIVE",
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "USER_ACCOUNT_CREATED",
          entityType: "User",
          entityId: user.id,
          description: "Administrative user account created.",
          ipAddress: req.ip || null,
          userAgent: req.get?.("user-agent") || null,
          metadata: { email: user.email, role: user.role },
        },
      });

      return user;
    });

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: outcome,
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        error: {
          code: "EMAIL_ALREADY_EXISTS",
          message: "An account with this email address already exists.",
        },
      });
    }

    console.error("Create account failed:", { code: error.code || "UNKNOWN" });
    return res.status(500).json({
      success: false,
      error: {
        code: "ACCOUNT_CREATE_FAILED",
        message: "Unable to create account.",
      },
    });
  }
}

async function login(req, res) {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body)
    ) {
      return res.status(400).json({
        success: false,
        message: "A JSON object containing email and password is required.",
      });
    }

    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password ||
      email.length > 254 ||
      password.length > 1024
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Authentication is not configured.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to complete login.",
    });
  }
}

function getAll(req, res) {
  res.json({ message: "Authentication API is working." });
}
function getProfile(req, res) {
  return res.json({
    success: true,
    message: "Authentication verified successfully.",
    user: req.user,
  });
}

module.exports = {
  login,
  getAll,
  getProfile,
  createAccount,
  registrationDisabled,
};
