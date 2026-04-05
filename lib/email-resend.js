/**
 * Optional Resend (https://resend.com) for password-reset emails.
 * Set RESEND_API_KEY and RESEND_FROM_EMAIL (verified domain).
 */
async function sendPasswordResetEmail(to, resetUrl) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!key || !from) {
    return false;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Reset your Vula24 locksmith password",
      html: `<p>We received a request to reset your Vula24 locksmith password.</p>
<p><a href="${resetUrl}">Reset password</a> — link valid for 1 hour.</p>
<p>If you did not request this, ignore this email.</p>`,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[email] Resend error:", res.status, text.slice(0, 500));
    return false;
  }
  return true;
}

module.exports = { sendPasswordResetEmail };
