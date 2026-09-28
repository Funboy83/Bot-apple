// Sends alerts by Telegram, email and text message.
import nodemailer from 'nodemailer';

async function telegram(a, text) {
  if (!a.telegramToken || !a.telegramChatId) throw new Error('Telegram bot token and chat ID are required');
  const res = await fetch(`https://api.telegram.org/bot${a.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: a.telegramChatId, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(`Telegram: ${body.description || res.status}`);
}

function mailer(a) {
  if (!a.smtpHost || !a.smtpUser || !a.smtpPass) throw new Error('Email needs SMTP server, username and password');
  const port = Number(a.smtpPort) || 465;
  return nodemailer.createTransport({
    host: a.smtpHost,
    port,
    secure: port === 465,
    auth: { user: a.smtpUser, pass: a.smtpPass },
  });
}

async function email(a, subject, text) {
  const to = a.emailTo || a.smtpUser;
  await mailer(a).sendMail({ from: a.emailFrom || a.smtpUser, to, subject, text });
}

async function sms(a, method, text) {
  const short = text.length > 300 ? `${text.slice(0, 297)}...` : text;
  if (method === 'gateway') {
    if (!a.smsGatewayEmail) throw new Error('Text by email needs your carrier address, e.g. 5551234567@tmomail.net');
    await mailer(a).sendMail({ from: a.emailFrom || a.smtpUser, to: a.smsGatewayEmail, subject: '', text: short });
    return;
  }
  if (!a.twilioSid || !a.twilioToken || !a.twilioFrom || !a.smsTo) {
    throw new Error('Twilio needs Account SID, Auth Token, From number and your phone number');
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${a.twilioSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${a.twilioSid}:${a.twilioToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: a.twilioFrom, To: a.smsTo, Body: short }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Twilio: ${body.message || res.status}`);
  }
}

// Sends on every enabled channel. Returns {channel: 'ok' | error message}.
export async function notifyAll(settingsAlerts, secretAlerts = {}, subject, text, only = null) {
  const channels = {
    telegram: () => telegram(secretAlerts, `${subject}\n\n${text}`),
    email: () => email(secretAlerts, subject, text),
    sms: () => sms(secretAlerts, settingsAlerts.smsMethod, `${subject}: ${text}`),
  };
  const results = {};
  await Promise.all(
    Object.entries(channels)
      .filter(([name]) => (only ? only === name : settingsAlerts[name]))
      .map(async ([name, send]) => {
        try {
          await send();
          results[name] = 'ok';
        } catch (err) {
          results[name] = err.message;
        }
      }),
  );
  return results;
}
