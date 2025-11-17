const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "girma.m.halie19@gmail.com",
    pass: "smzj okll fpfl skkh" // Use an app password if 2FA is enabled
  }
});
transporter.sendMail({
  from: "girma.m.halie19@gmail.com",
  to: "girma.m.halie19@gmail.com",
  subject: "Test Email",
  text: "This is a test"
}, (err, info) => {
  if (err) return console.error("Error:", err);
  console.log("Email sent:", info);
});