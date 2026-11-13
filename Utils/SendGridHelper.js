import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export async function sendWelcomeEmail(to, toName) {
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: "Your Free Demo & Consultation with FlashFire",
    text: `
      Congratulations ${toName} ! You’ve unlocked a free demo and live consultation on FlashFire.

      Try your Free Trial and get access to our Exclusive Dashboard,
      AI Tools, and Workflow Optimization Suite.

      Hurry up — only 6 spots left!

      Book your free consultation now at: https://flashfirejobs.com
    `,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:600px; margin:0 auto; padding:20px; background:#f9fafb; border-radius:12px; color:#111827;">
        
        <!-- Header -->
        <h1 style="text-align:center; font-size:24px; color:#ff5722; margin-bottom:10px;">
          🔥 FlashFire Exclusive Offer
        </h1>
        <p style="text-align:center; font-size:14px; color:#6b7280; margin-bottom:30px;">
          Unlock your free demo and live consultation today
        </p>

        <!-- Offer Section -->
        <div style="background:#fff; border:1px solid #e5e7eb; padding:20px; border-radius:10px; text-align:left; box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <p style="font-size:16px; color:#111827; margin-bottom:10px;">
            🎉 Congratulations! You’ve unlocked a <b>free demo and live consultation</b> with FlashFire.
          </p>
          <p style="font-size:14px; color:#374151; margin-bottom:0;">
            Get exclusive access to our Dashboard, AI Tools, and Workflow Optimization suite. 
            Hurry — only <b>6 spots left</b>!
          </p>
        </div>

        <!-- CTA Button -->
        <div style="text-align:center; margin-top:30px;">
          <a href="https://flashfirejobs.com" target="_blank"
            style="display:inline-block; padding:14px 28px; background:#ff5722; color:white; font-weight:600; text-decoration:none; border-radius:8px; font-size:16px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            Book Your Free Consultation →
          </a>
        </div>

        <!-- Footer -->
        <p style="margin-top:40px; text-align:center; font-size:12px; color:#9ca3af;">
          Thank you for visiting <b>FlashFire</b>.<br/>
          We respect your privacy. No spam, ever.
        </p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

export async function sendCrmOtpEmail(to, otp, name) {
  const safeName = name ? String(name).trim() : '';
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Your FlashFire CRM login code',
    text: `Your FlashFire CRM OTP is: ${otp}\n\nThis code expires in 5 minutes.`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:600px; margin:0 auto; padding:20px; background:#f8fafc; border-radius:16px; color:#0f172a;">
        <div style="background:#0f172a; color:white; padding:18px 20px; border-radius:14px;">
          <div style="font-size:14px; opacity:0.85; letter-spacing:0.06em; text-transform:uppercase;">FlashFire CRM</div>
          <div style="font-size:22px; font-weight:800; margin-top:6px;">One-time login code</div>
        </div>

        <div style="background:white; border:1px solid #e2e8f0; padding:20px; border-radius:14px; margin-top:14px;">
          <p style="margin:0 0 10px 0; font-size:15px; color:#334155;">
            ${safeName ? `Hi ${safeName},` : 'Hi,'}
          </p>
          <p style="margin:0 0 16px 0; font-size:15px; color:#334155;">
            Use this OTP to log in. It expires in <b>5 minutes</b>.
          </p>

          <div style="display:flex; align-items:center; justify-content:center; padding:14px; border-radius:12px; background:#fff7ed; border:1px solid #fed7aa;">
            <span style="font-size:28px; font-weight:900; letter-spacing:0.22em; color:#ea580c;">${otp}</span>
          </div>

          <p style="margin:16px 0 0 0; font-size:13px; color:#64748b;">
            If you didn’t request this code, ignore this email.
          </p>
        </div>

        <p style="margin:14px 0 0 0; text-align:center; font-size:12px; color:#94a3b8;">
          © ${new Date().getFullYear()} FlashFire
        </p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

export async function sendBdaOtpEmail(to, otp, name) {
  const safeName = name ? String(name).trim() : '';
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Your FlashFire BDA Attendance login code',
    text: `Your BDA Attendance OTP is: ${otp}\n\nThis code expires in 5 minutes.`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:600px; margin:0 auto; padding:20px; background:#f8fafc; border-radius:16px; color:#0f172a;">
        <div style="background:#ff5722; color:white; padding:18px 20px; border-radius:14px;">
          <div style="font-size:14px; opacity:0.85; letter-spacing:0.06em; text-transform:uppercase;">FlashFire BDA Attendance</div>
          <div style="font-size:22px; font-weight:800; margin-top:6px;">One-time login code</div>
        </div>

        <div style="background:white; border:1px solid #e2e8f0; padding:20px; border-radius:14px; margin-top:14px;">
          <p style="margin:0 0 10px 0; font-size:15px; color:#334155;">
            ${safeName ? `Hi ${safeName},` : 'Hi,'}
          </p>
          <p style="margin:0 0 16px 0; font-size:15px; color:#334155;">
            Use this OTP to log in to the BDA Attendance extension. It expires in <b>5 minutes</b>.
          </p>

          <div style="display:flex; align-items:center; justify-content:center; padding:14px; border-radius:12px; background:#fff7ed; border:1px solid #fed7aa;">
            <span style="font-size:28px; font-weight:900; letter-spacing:0.22em; color:#ea580c;">${otp}</span>
          </div>

          <p style="margin:16px 0 0 0; font-size:13px; color:#64748b;">
            If you didn't request this code, ignore this email.
          </p>
        </div>

        <p style="margin:14px 0 0 0; text-align:center; font-size:12px; color:#94a3b8;">
          &copy; ${new Date().getFullYear()} FlashFire
        </p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

export async function sendBdaClaimApprovalEmail(recipients, approval, booking) {
  const fallback = process.env.CRM_ADMIN_NOTIFICATION_EMAIL || process.env.SENDGRID_FROM_EMAIL;
  const list = Array.isArray(recipients) ? recipients.filter((e) => e) : [];
  if (!list.length && !fallback) return;
  const apiBase = process.env.CRM_API_BASE_URL || "https://api.flashfirejobs.com";
  const dashboardBase = process.env.CRM_FRONTEND_URL || "https://flashfire-crm.vercel.app";
  const secret = process.env.CRM_JWT_SECRET || process.env.CRM_ADMIN_PASSWORD || "dev_only_insecure_crm_jwt_secret";
  const payload = `${approval._id}:${approval.bookingId}`;
  const token = crypto.createHash("sha256").update(payload + secret).digest("hex");
  const approveUrl = `${apiBase}/api/bda/approvals/${approval._id}/email-action?action=approve&token=${token}`;
  const denyUrl = `${apiBase}/api/bda/approvals/${approval._id}/email-action?action=deny&token=${token}`;
  const viewUrl = `${dashboardBase}/admin/analysis`;
  const subject = `BDA claimed lead: ${booking.clientName || booking.clientEmail || booking.bookingId}`;
  const text = `A BDA has claimed a lead.\n\nBDA: ${approval.bdaName} (${approval.bdaEmail})\nClient: ${booking.clientName || ""} (${booking.clientEmail || ""})\nAmount: ${booking.paymentPlan?.displayPrice || booking.paymentPlan?.price || ""}\n\nApprove: ${approveUrl}\nDeny: ${denyUrl}\nView: ${viewUrl}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:640px; margin:0 auto; padding:20px; background:#0f172a;">
      <div style="background:#0b1120; color:#e5e7eb; padding:18px 20px; border-radius:14px 14px 0 0; border-bottom:1px solid #1f2937;">
        <div style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; opacity:0.9;">FlashFire CRM</div>
        <div style="font-size:22px; font-weight:800; margin-top:6px;">New BDA claim awaiting approval</div>
      </div>
      <div style="background:#f9fafb; padding:20px; border-radius:0 0 14px 14px;">
        <p style="margin:0 0 10px 0; font-size:15px; color:#111827;">A BDA has claimed a lead and is waiting for your approval.</p>
        <div style="margin:14px 0; padding:14px; border-radius:10px; border:1px solid #e5e7eb; background:white;">
          <div style="font-size:13px; font-weight:600; color:#4b5563; margin-bottom:6px;">BDA</div>
          <div style="font-size:15px; color:#111827;">${approval.bdaName} <span style="color:#6b7280;">(${approval.bdaEmail})</span></div>
          <div style="margin-top:10px; font-size:13px; font-weight:600; color:#4b5563; margin-bottom:4px;">Client</div>
          <div style="font-size:15px; color:#111827;">${booking.clientName || ""}</div>
          <div style="font-size:13px; color:#6b7280;">${booking.clientEmail || ""}${booking.clientPhone ? " · " + booking.clientPhone : ""}</div>
          <div style="margin-top:10px; font-size:13px; font-weight:600; color:#4b5563; margin-bottom:4px;">Plan and amount</div>
          <div style="font-size:15px; color:#111827;">${booking.paymentPlan?.name || ""} ${
            booking.paymentPlan?.displayPrice || (booking.paymentPlan?.price != null ? "$" + booking.paymentPlan.price : "")
          }</div>
        </div>
        <div style="margin-top:18px; display:flex; flex-wrap:wrap; gap:10px;">
          <a href="${approveUrl}" style="flex:1 1 auto; text-align:center; padding:12px 16px; background:#22c55e; color:white; text-decoration:none; border-radius:999px; font-weight:600; font-size:14px;">Approve</a>
          <a href="${denyUrl}" style="flex:1 1 auto; text-align:center; padding:12px 16px; background:#ef4444; color:white; text-decoration:none; border-radius:999px; font-weight:600; font-size:14px;">Deny</a>
          <a href="${viewUrl}" style="flex:1 1 100%; text-align:center; padding:10px 14px; background:#0f172a; color:#e5e7eb; text-decoration:none; border-radius:10px; font-weight:500; font-size:13px; margin-top:4px;">Open in CRM</a>
        </div>
        <p style="margin-top:18px; font-size:11px; color:#6b7280;">If the buttons do not work, you can copy-paste the following links into your browser:</p>
        <p style="margin:4px 0; font-size:11px; color:#9ca3af; word-break:break-all;">Approve: ${approveUrl}</p>
        <p style="margin:4px 0; font-size:11px; color:#9ca3af; word-break:break-all;">Deny: ${denyUrl}</p>
      </div>
    </div>
  `;
  const toList = list.length ? list : [fallback];
  for (const to of toList) {
    const msg = {
      to,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject,
      text,
      html
    };
    await sgMail.send(msg);
  }
}
/** One warning letter to a BDA, with the admins copied. Throws on a SendGrid error so the caller can record it. */
export async function sendWarningLetterEmail({ to, cc = [], subject, text, html }) {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
    throw new Error("Email is not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL)");
  }
  const msg = { to, from: process.env.SENDGRID_FROM_EMAIL, subject, text, html };
  const copies = (cc || []).filter((e) => e && e.toLowerCase() !== String(to).toLowerCase());
  if (copies.length) msg.cc = copies;
  await sgMail.send(msg);
}
