/**
 * Auth Controller
 * Handles user registration, login, and authentication
 */

const User = require("../models/User");
const { generateToken, generateRefreshToken } = require("../middleware/auth");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");

/**
 * POST /api/auth/register
 * Register a new user
 */
const register = asyncHandler(async (req, res) => {
  const { email, password, username } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return response.error(res, "Email already registered", 409);
  }

  // Check username uniqueness if provided
  if (username) {
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return response.error(res, "Username already taken", 409);
    }
  }

  // Create new user
  const user = new User({
    email,
    password,
    username,
  });

  await user.save();

  // Generate tokens
  const token = generateToken(user);
  const refreshToken = generateRefreshToken(user);

  logger.info(`New user registered: ${email}`);

  return response.created(
    res,
    {
      user: user.toSafeObject(),
      token,
      refreshToken,
    },
    "Registration successful",
  );
});

/**
 * POST /api/auth/login
 * Login user and return JWT token
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Find user with password
  const user = await User.findOne({ email }).select("+password");

  if (!user) {
    return response.error(res, "Invalid credentials", 401);
  }

  // Check if account is locked
  if (user.isLocked()) {
    return response.error(
      res,
      "Account temporarily locked. Please try again later.",
      423,
    );
  }

  // Verify password
  const isMatch = await user.comparePassword(password);

  if (!isMatch) {
    await user.incrementLoginAttempts();
    return response.error(res, "Invalid credentials", 401);
  }

  // Check if account is active
  if (!user.isActive) {
    return response.error(res, "Account is deactivated", 403);
  }

  if (user.isBanned) {
    return response.error(
      res,
      `Account banned: ${user.banReason || "Contact support"}`,
      403,
    );
  }

  // Reset login attempts and update last login
  user.loginAttempts = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();

  // Generate tokens
  const token = generateToken(user);
  const refreshToken = generateRefreshToken(user);

  logger.info(`User logged in: ${email}`);

  return response.success(
    res,
    {
      user: user.toSafeObject(),
      token,
      refreshToken,
    },
    "Login successful",
  );
});

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return response.error(res, "Refresh token required", 400);
  }

  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (decoded.type !== "refresh") {
      return response.error(res, "Invalid refresh token", 401);
    }

    const user = await User.findById(decoded.userId);

    if (!user || !user.isActive) {
      return response.error(res, "User not found or inactive", 401);
    }

    const newToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);

    return response.success(
      res,
      {
        token: newToken,
        refreshToken: newRefreshToken,
      },
      "Token refreshed",
    );
  } catch (error) {
    return response.error(res, "Invalid refresh token", 401);
  }
});

/**
 * POST /api/auth/logout
 * Logout user (client should delete tokens)
 */
const logout = asyncHandler(async (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // This endpoint can be used for logging/analytics
  logger.info(`User logged out: ${req.userId}`);
  return response.success(res, null, "Logged out successfully");
});

/**
 * POST /api/auth/verify-email
 * Verify email address with token
 */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return response.error(res, "Verification token required", 400);
  }

  // For now, return success (implement email verification later)
  return response.success(res, null, "Email verified successfully");
});

/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return response.error(res, "Email required", 400);
  }

  const user = await User.findOne({ email });

  if (!user) {
    // Don't reveal if user exists
    return response.success(
      res,
      null,
      "If that email exists, a reset link has been sent",
    );
  }

  // TODO: Implement email sending with reset token
  logger.info(`Password reset requested for: ${email}`);

  return response.success(
    res,
    null,
    "If that email exists, a reset link has been sent",
  );
});

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return response.error(res, "Token and new password required", 400);
  }

  // TODO: Implement token verification and password reset
  return response.success(res, null, "Password reset successfully");
});

/**
 * GET /api/auth/me
 * Get current user profile
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(res, {
    user: user.toSafeObject(),
  });
});

/**
 * PUT /api/auth/me
 * Update current user profile
 */
const updateMe = asyncHandler(async (req, res) => {
  const allowedUpdates = ["username", "walletAddress"];
  const updates = {};

  for (const field of allowedUpdates) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  // Check username uniqueness if being updated
  if (updates.username) {
    const existing = await User.findOne({
      username: updates.username,
      _id: { $ne: req.userId },
    });
    if (existing) {
      return response.error(res, "Username already taken", 409);
    }
  }

  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: updates },
    { new: true, runValidators: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`User updated profile: ${user.email}`);

  return response.success(
    res,
    {
      user: user.toSafeObject(),
    },
    "Profile updated",
  );
});

/**
 * PUT /api/auth/password
 * Change password
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.userId).select("+password");

  if (!user) {
    return response.notFound(res, "User");
  }

  // Verify current password
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return response.error(res, "Current password is incorrect", 400);
  }

  // Update password
  user.password = newPassword;
  await user.save();

  // Generate new token
  const token = generateToken(user);

  logger.info(`User changed password: ${user.email}`);

  return response.success(res, { token }, "Password changed successfully");
});

/**
 * DELETE /api/auth/me
 * Deactivate account
 */
const deactivateAccount = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { isActive: false },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`User deactivated account: ${user.email}`);

  return response.success(res, null, "Account deactivated");
});

module.exports = {
  register,
  login,
  logout,
  refreshToken,
  getMe,
  updateMe,
  changePassword,
  verifyEmail,
  forgotPassword,
  resetPassword,
  deactivateAccount,
};
