const { User } = require("../models/user");
const express = require("express");
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

//Configure nodemailer transporter
const transporterConfig = process.env.EMAIL_SERVICE
  ? {
      service: process.env.EMAIL_SERVICE, // 'gmail', 'sendgrid', 'outlook', etc.
      auth: {
        user: process.env.EMAIL_User,
        pass: process.env.EMAIL_Pass,
      },
    }
  : {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === 'true' || false,
      auth: {
        user: process.env.EMAIL_User,
        pass: process.env.EMAIL_Pass,
      },
    };

const transporter = nodemailer.createTransport(transporterConfig);

router.get(`/`, async (req, res) => {
  const userList = await User.find().select("-passwordHash");

  if (!userList) {
    res.status(500).json({ success: false });
  }

  res.send(userList);
});

router.post(`/`, async (req, res) => {
  const user = new User({
    name: req.body.name,
    email: req.body.email,
    passwordHash: bcrypt.hashSync(req.body.password, 10),
    phone: req.body.phone,
    isAdmin: req.body.isAdmin,
    street: req.body.street,
    apartment: req.body.apartment,
    zip: req.body.zip,
    city: req.body.city,
    country: req.body.country,
  });

  const use = await user.save();

  if (!use) {
    return res.status(404).send("the user cannot be created!");
  }

  res.send(use);
});

// Modified login to check email verification
router.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  const secret = process.env.secret;

  if (!user) {
    return res.status(400).send("The user not found");
  }

  if (!user.isEmailVerified) {
    return res.status(400).send("Please verify your email before logging in");
  }

  if (user && bcrypt.compareSync(req.body.password, user.passwordHash)) {
    const token = jwt.sign(
      {
        userId: user.id,
        isAdmin: user.isAdmin,
      },
      secret,
      { expiresIn: "1d" }
    );
    return res.send({
      user: user.email,
      _id: user._id,
      name: user.name,
      phone: user.phone,
      isAdmin: user.isAdmin,
      isEmailVerified: user.isEmailVerified,
      token: token,
    });
  } else {
    return res.status(400).send("password is wrong");
  }
});

// router.post(`/register`, async(req, res) => {
//     const user = new User({
//         name: req.body.name,
//         email: req.body.email,
//         passwordHash: bcrypt.hashSync(req.body.password, 10),
//         phone: req.body.phone,
//         isAdmin: req.body.isAdmin,
//         street: req.body.street,
//         apartment: req.body.apartment,
//         zip: req.body.zip,
//         city: req.body.city,
//         country: req.body.country
//     })

//     const use = await user.save();

//     if(!use){
//         return res.status(404).send('the user cannot be created!');
//     }

//    //console.log(use);
//     return res.send(use);

// })

router.post(`/register`, async (req, res) => {
  try {
    console.log("Registration request body:", req.body); // Debug log

    const { name, email, password, phone } = req.body;

    // Validate required fields
    if (!name || !email || !password || !phone) {
      return res.status(400).json({
        success: false,
        message: "name, email, password, and phone are required",
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");

    const user = new User({
      name,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      phone,
      isAdmin: req.body.isAdmin || false,
      street: req.body.street,
      apartment: req.body.apartment,
      zip: req.body.zip,
      city: req.body.city,
      country: req.body.country,
      emailVerificationToken: verificationToken,
      isEmailVerified: false,
    });

    const savedUser = await user.save();

    // Add frontend URL to your .env file if not exists
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}&email=${email}`;

    const mailOptions = {
      from: process.env.EMAIL_User,
      to: email,
      subject: "Email Verification",
      html: `
        <h1>Email Verification</h1>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verificationUrl}">Verify Email</a>
        <p>If you didn't create an account, please ignore this email.</p>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("Verification email sent successfully");
    } catch (emailError) {
      console.error("Error sending email:", emailError);
      // Don't fail registration if email fails
    }

    // Remove sensitive data before sending response
    const userResponse = {
      _id: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      phone: savedUser.phone,
      isAdmin: savedUser.isAdmin,
      isEmailVerified: savedUser.isEmailVerified,
    };

    res.status(201).json({
      success: true,
      message:
        "User registered successfully. Please check your email to verify your account.",
      user: userResponse,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

//Count the number of Users
router.get(`/get/count`, async (req, res) => {
  const userCount = await User.countDocuments({});

  if (userCount === 0) {
    return res.status(500).json({ success: false });
  }

  return res.send({
    userCount: userCount,
  });
});

// POST /users/resend-verification - Resend verification email
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified",
      });
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    user.emailVerificationToken = verificationToken;
    await user.save();

    // Send verification email
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}&email=${email}`;

    const mailOptions = {
      from: process.env.EMAIL_User,
      to: email,
      subject: "Email Verification - Resend",
      html: `
        <h1>Email Verification</h1>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verificationUrl}">Verify Email</a>
        <p>If you didn't request this, please ignore this email.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: "Verification email sent successfully",
    });
  } catch (err) {
    console.error("Resend verification error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// GET /users/verify-email - Verify email with token
// router.get("/verify-email", async (req, res) => {
//   const { token, email } = req.query;

//   if (!token) {
//     return res.status(400).json({
//       success: false,
//       message: "Verification token is required"
//     });
//   }

//   try {
//     const user = await User.findOne({ emailVerificationToken: token });

//      if (!user) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid or expired verification token"
//       });
//     }

//     if (user.isEmailVerified) {
//       return res.status(400).json({
//         success: false,
//         message: "Email is already verified"
//       });
//     }

//     // Verify the email
//     user.isEmailVerified = true;
//     user.emailVerificationToken = undefined; // Remove the token
//     await user.save();

//     res.json({
//       message: "Email verified successfully",
//       user: {
//         _id: user._id,
//         name: user.name,
//         email: user.email,
//         isEmailVerified: user.isEmailVerified,
//       },
//     });
//   } catch (err) {
//     console.error('Email verification error:', err);
//     return res.status(500).json({
//       success: false,
//       message: err.message
//     });
//   }
// });

// GET /users/verify-email - Verify email with token
router.get("/verify-email", async (req, res) => {
  const { token, email } = req.query;

  if (!token) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verification Error</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
          .button { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Verification Failed</h1>
          <p>Verification token is required.</p>
          <a href="${
            process.env.FRONTEND_URL || "http://localhost:3000"
          }" class="button">Go to Homepage</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const user = await User.findOne({ emailVerificationToken: token });

    if (!user) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verification Error</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
            .button { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Verification Failed</h1>
            <p>Invalid or expired verification token.</p>
          </div>
        </body>
        </html>
      `);
    }

    if (user.isEmailVerified) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Already Verified</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            .info { color: #f39c12; background-color: #fef9e7; padding: 20px; border-radius: 5px; border: 1px solid #f39c12; }
            .button { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="info">
            <h1>⚠️ Already Verified</h1>
            <p>Your email address is already verified.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Verify the email
    user.isEmailVerified = true;
    user.emailVerificationToken = undefined; // Remove the token
    await user.save();

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Verified</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px; 
            text-align: center; 
            background-color: #f8f9fa;
          }
          .success { 
            color: #27ae60; 
            background-color: #d5f4e6; 
            padding: 30px; 
            border-radius: 10px; 
            border: 1px solid #27ae60; 
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background-color: #27ae60; 
            color: white; 
            text-decoration: none; 
            border-radius: 5px; 
            margin-top: 20px; 
            transition: background-color 0.3s;
          }
          .button:hover { 
            background-color: #219a52; 
          }
          .user-info {
            background-color: #ecf0f1;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            color: #2c3e50;
          }
          h1 { margin-bottom: 10px; }
          p { margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="success">
          <h1>✅ Email Verified Successfully!</h1>
          <p>Congratulations! Your email address has been verified.</p>
          
          <div class="user-info">
            <h3>Account Details:</h3>
            <p><strong>Name:</strong> ${user.name}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>Status:</strong> Verified ✓</p>
          </div>
          
          <p>You can now log in to your account and enjoy all our features.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Email verification error:", err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Server Error</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
          .button { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Server Error</h1>
          <p>An error occurred while verifying your email. Please try again later.</p>
        </div>
      </body>
      </html>
    `);
  }
});

// Add these routes to your users.js file

// POST /users/forgot-password - Request password reset
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.json({
        success: true,
        message:
          "If an account with that email exists, a password reset link has been sent.",
      });
    }

    // Generate password reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Save reset token to user
    user.passwordResetToken = resetToken;
    user.passwordResetTokenExpiry = resetTokenExpiry;
    await user.save();

    // Get the actual host from the request or use environment variable
    const protocol = req.protocol;
    const host = req.get('host');
    
    // For mobile devices, use the server's actual IP address
    const baseUrl = process.env.BACKEND_URL || `${protocol}://${host}`;
    
    const resetUrl = `${baseUrl}${process.env.API_URL}/users/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

    console.log('Generated reset URL:', resetUrl);
    console.log('Request host:', host);
    console.log('Protocol:', protocol);

    const mailOptions = {
      from: process.env.EMAIL_User,
      to: email,
      subject: "Password Reset Request",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 5px; }
            .content { padding: 20px; background-color: #fff; border: 1px solid #dee2e6; border-radius: 5px; margin-top: 10px; }
            .button { 
              display: inline-block; 
              padding: 12px 24px; 
              background-color: #007bff; 
              color: white !important; 
              text-decoration: none; 
              border-radius: 5px; 
              margin: 20px 0;
              font-weight: bold;
            }
            .warning { color: #856404; background-color: #fff3cd; padding: 15px; border-radius: 5px; border: 1px solid #ffeaa7; margin: 15px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 14px; }
            .link-text { 
              word-break: break-all; 
              color: #007bff; 
              font-size: 12px;
              display: block;
              margin: 10px 0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hello ${user.name},</p>
              <p>We received a request to reset your password for your account.</p>
              <p>Click the button below to reset your password:</p>
              <p style="text-align: center;">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </p>
              <div class="warning">
                <strong>⚠️ Important:</strong>
                <ul>
                  <li>This link will expire in 1 hour</li>
                  <li>If you didn't request this reset, please ignore this email</li>
                  <li>For security reasons, don't share this link with anyone</li>
                </ul>
              </div>
              <p><strong>Or copy and paste this link:</strong></p>
              <div class="link-text">${resetUrl}</div>
            </div>
            <div class="footer">
              <p>This email was sent automatically. Please do not reply.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("Password reset email sent successfully to:", email);
    } catch (emailError) {
      console.error("Error sending password reset email:", emailError);
    }

    res.json({
      success: true,
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing your request",
    });
  }
});

// GET /users/verify-reset-token - Verify reset token (optional, for frontend validation)
router.get("/verify-reset-token", async (req, res) => {
  const { token, email } = req.query;

  if (!token || !email) {
    return res.status(400).json({
      success: false,
      message: "Token and email are required",
    });
  }

  try {
    const user = await User.findOne({
      email: email,
      passwordResetToken: token,
      passwordResetTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token",
      });
    }

    res.json({
      success: true,
      message: "Token is valid",
      user: {
        email: user.email,
        name: user.name,
      },
    });
  } catch (err) {
    console.error("Verify reset token error:", err);
    return res.status(500).json({
      success: false,
      message: "An error occurred while verifying the token",
    });
  }
});

// POST /users/reset-password - Reset password with token
router.post("/reset-password", async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Token, email, and new password are required",
      });
    }

    // Validate password strength
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const user = await User.findOne({
      email: email,
      passwordResetToken: token,
      passwordResetTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token",
      });
    }

    // Update password and remove reset token
    user.passwordHash = bcrypt.hashSync(newPassword, 10);
    user.passwordResetToken = undefined;
    user.passwordResetTokenExpiry = undefined;
    await user.save();

    // Send confirmation email
    const mailOptions = {
      from: process.env.EMAIL_User,
      to: email,
      subject: "Password Reset Successful",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #d4edda; padding: 20px; text-align: center; border-radius: 5px; }
            .content { padding: 20px; background-color: #fff; border: 1px solid #c3e6cb; border-radius: 5px; margin-top: 10px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ Password Reset Successful</h1>
            </div>
            <div class="content">
              <p>Hello ${user.name},</p>
              <p>Your password has been successfully reset.</p>
              <p>You can now log in to your account with your new password.</p>
              <a href="${
                process.env.FRONTEND_URL || "http://localhost:3000"
              }/login" class="button">Go to Login</a>
              <p><strong>If you didn't reset your password, please contact our support team immediately.</strong></p>
            </div>
            <div class="footer">
              <p>This email was sent automatically. Please do not reply.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("Password reset confirmation email sent to:", email);
    } catch (emailError) {
      console.error("Error sending confirmation email:", emailError);
    }

    res.json({
      success: true,
      message:
        "Password has been reset successfully. You can now log in with your new password.",
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({
      success: false,
      message: "An error occurred while resetting your password",
    });
  }
});

// GET /users/reset-password - HTML page for password reset
router.get("/reset-password", async (req, res) => {
  const { token, email } = req.query;

  console.log("Reset password GET request:", { token, email });

  if (!token || !email) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invalid Reset Link</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Invalid Reset Link</h1>
          <p>This password reset link is invalid or incomplete.</p>
        </div>
      </body>
      </html>
    `);
  }

  try {
    console.log("Looking for user with token and checking expiry...");
    console.log("Current time:", new Date());

    const user = await User.findOne({
      email: email,
      passwordResetToken: token,
    });

    console.log("User found:", user ? "Yes" : "No");
    if (user) {
      console.log("Token expiry time:", user.passwordResetTokenExpiry);
      console.log("Token expired?", user.passwordResetTokenExpiry < new Date());
    }

    // Check if user exists and token is valid
    if (
      !user ||
      !user.passwordResetTokenExpiry ||
      user.passwordResetTokenExpiry < new Date()
    ) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Expired Reset Link</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
            .button { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>⏰ Reset Link Expired</h1>
            <p>This password reset link has expired or is invalid.</p>
            <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/forgot-password" class="button">Request New Reset Link</a>
          </div>
        </body>
        </html>
      `);
    }

    console.log("Token is valid, showing reset form");

    // Get the current host to build the API URL
    const protocol = req.protocol;
    const host = req.get('host');
    const apiUrl = `${protocol}://${host}${process.env.API_URL}/users/reset-password`;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Password</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px; 
            background-color: #f8f9fa;
          }
          .container { 
            background-color: white; 
            padding: 30px; 
            border-radius: 10px; 
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .form-group { margin-bottom: 20px; }
          label { display: block; margin-bottom: 5px; font-weight: bold; }
          input[type="password"] { 
            width: 100%; 
            padding: 10px; 
            border: 1px solid #ddd; 
            border-radius: 5px; 
            font-size: 16px;
            box-sizing: border-box;
          }
          .button { 
            background-color: #007bff; 
            color: white; 
            padding: 12px 24px; 
            border: none; 
            border-radius: 5px; 
            cursor: pointer; 
            font-size: 16px;
            width: 100%;
          }
          .button:hover { background-color: #0056b3; }
          .button:disabled { background-color: #6c757d; cursor: not-allowed; }
          .user-info { 
            background-color: #e9f7ff; 
            padding: 15px; 
            border-radius: 5px; 
            margin-bottom: 20px;
          }
          .requirements {
            font-size: 14px;
            color: #666;
            margin-top: 5px;
          }
          .message {
            padding: 12px;
            border-radius: 5px;
            margin: 10px 0;
            display: none;
            font-size: 14px;
          }
          .message.success {
            background-color: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
          }
          .message.error {
            background-color: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
          }
          .message.show {
            display: block;
          }
          .debug-info {
            background-color: #f8f9fa;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            margin: 10px 0;
            color: #6c757d;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔐 Reset Your Password</h1>
          
          <div class="user-info">
            <p><strong>Account:</strong> ${user.name}</p>
            <p><strong>Email:</strong> ${email}</p>
          </div>

          <div id="message" class="message"></div>
          
          <form id="resetForm">
            <div class="form-group">
              <label for="newPassword">New Password:</label>
              <input type="password" id="newPassword" name="newPassword" required minlength="6">
              <div class="requirements">Password must be at least 6 characters long</div>
            </div>
            
            <div class="form-group">
              <label for="confirmPassword">Confirm Password:</label>
              <input type="password" id="confirmPassword" name="confirmPassword" required minlength="6">
            </div>
            
            <button type="submit" class="button" id="submitBtn">Reset Password</button>
          </form>

          <div class="debug-info" id="debugInfo" style="display: none;">
            <strong>Debug Information:</strong><br>
            <span id="debugText"></span>
          </div>
        </div>
        
        <script>
          const form = document.getElementById('resetForm');
          const messageDiv = document.getElementById('message');
          const submitBtn = document.getElementById('submitBtn');
          const debugInfo = document.getElementById('debugInfo');
          const debugText = document.getElementById('debugText');

          // API endpoint (using relative path for mobile compatibility)
          const apiEndpoint = '${apiUrl}';

          function showMessage(text, type) {
            messageDiv.textContent = text;
            messageDiv.className = 'message ' + type + ' show';
            messageDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

          function showDebug(text) {
            debugText.textContent = text;
            debugInfo.style.display = 'block';
          }

          form.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            
            // Clear previous messages
            messageDiv.className = 'message';
            
            // Validation
            if (newPassword !== confirmPassword) {
              showMessage('❌ Passwords do not match!', 'error');
              return false;
            }
            
            if (newPassword.length < 6) {
              showMessage('❌ Password must be at least 6 characters long!', 'error');
              return false;
            }

            // Disable submit button
            submitBtn.disabled = true;
            submitBtn.textContent = 'Resetting...';

            const requestData = {
              token: '${token}',
              email: '${email}',
              newPassword: newPassword
            };

            console.log('Sending reset request to:', apiEndpoint);
            console.log('Request data:', { ...requestData, newPassword: '[HIDDEN]' });

            try {
              const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify(requestData)
              });

              console.log('Response status:', response.status);
              
              let data;
              const contentType = response.headers.get('content-type');
              
              if (contentType && contentType.includes('application/json')) {
                data = await response.json();
              } else {
                const text = await response.text();
                console.error('Non-JSON response:', text);
                throw new Error('Server returned non-JSON response');
              }

              console.log('Response data:', data);

              if (response.ok && data.success) {
                showMessage('✅ ' + (data.message || 'Password reset successful! Redirecting to login...'), 'success');
                
                // Redirect to login after 2 seconds
                setTimeout(() => {
                  window.location.href = '${process.env.FRONTEND_URL || "http://localhost:3000"}/login';
                }, 2000);
              } else {
                showMessage('❌ ' + (data.message || 'Failed to reset password. Please try again.'), 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Reset Password';
              }
            } catch (error) {
              console.error('Error details:', error);
              showMessage('❌ An error occurred. Please check your internet connection and try again.', 'error');
              showDebug('Error: ' + error.message + ' | API: ' + apiEndpoint);
              submitBtn.disabled = false;
              submitBtn.textContent = 'Reset Password';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Reset password page error:", err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Server Error</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .error { color: #e74c3c; background-color: #fdf2f2; padding: 20px; border-radius: 5px; border: 1px solid #e74c3c; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Server Error</h1>
          <p>An error occurred while loading the password reset page.</p>
          <p style="font-size: 12px; color: #666;">${err.message}</p>
        </div>
      </body>
      </html>
    `);
  }
});

router.get("/:id", async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash");

  if (!user) {
    res
      .status(500)
      .json({ message: "The user with the given ID was not found." });
  }
  res.send(user);
});

module.exports = router;
