// ==================================================================================
// CHANDRAMAULI OIL ERP - EMAIL & OTP SERVICE
// Sends OTP emails using Gmail App Password via Nodemailer
// ==================================================================================

const nodemailer = require('nodemailer');

function getTransporter() {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[EmailService] GMAIL_USER or GMAIL_APP_PASSWORD not set in environment variables.');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user.trim(),
      pass: pass.trim(),
    },
  });
}

async function sendOtpEmail(toEmail, otpCode, brandName = 'Chandramauli Mustard Oil Mill') {
  const transporter = getTransporter();

  const mailOptions = {
    from: `"${brandName}" <${process.env.GMAIL_USER || 'support.chandramauli@gmail.com'}>`,
    to: toEmail,
    subject: `Your Security Verification Code: ${otpCode} - ${brandName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
        <div style="text-align: center; border-bottom: 2px solid #f59e0b; padding-bottom: 16px; margin-bottom: 20px;">
          <h2 style="color: #b45309; margin: 0;">🌾 ${brandName}</h2>
          <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Kachi Ghani Mustard Oil & Wheat Milling ERP</p>
        </div>

        <p style="color: #334155; font-size: 15px;">Hello,</p>
        <p style="color: #334155; font-size: 15px;">You requested a password reset or security verification for your Chandramauli ERP app.</p>

        <div style="text-align: center; margin: 30px 0; background: #fffbeb; border: 1px dashed #f59e0b; padding: 18px; border-radius: 8px;">
          <span style="font-size: 13px; color: #78350f; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">Your Verification Code (OTP)</span>
          <div style="font-size: 36px; font-weight: bold; color: #b45309; letter-spacing: 6px; margin-top: 8px;">${otpCode}</div>
          <span style="font-size: 12px; color: #92400e;">This code will expire in 10 minutes.</span>
        </div>

        <p style="color: #64748b; font-size: 13px;">If you did not request this code, you can safely ignore this email.</p>

        <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #94a3b8; text-align: center;">
          Chandramauli Mustard Oil Mill &bull; Raghunathpur Bahaur, Mirzapur 231302<br>
          Phone: +91 8429774452 &bull; support.chandramauli@gmail.com
        </div>
      </div>
    `,
  };

  if (!transporter) {
    console.log(`[EmailService] Simulated OTP delivery to ${toEmail}: OTP is ${otpCode}`);
    return {
      success: true,
      simulated: true,
      message: 'SMTP credentials not configured on server; OTP logged for development.',
      otp: otpCode,
    };
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] OTP email sent successfully to ${toEmail}: ${info.messageId}`);
    return { success: true, simulated: false, messageId: info.messageId };
  } catch (err) {
    console.error('[EmailService Error]', err);
    throw new Error(`Failed to send email: ${err.message}`);
  }
}

module.exports = {
  sendOtpEmail,
};
