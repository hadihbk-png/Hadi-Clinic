const nodemailer = require('nodemailer');
const AppointmentService = require('./appointmentService');

const CLINIC_NAME = 'Hadi Medical Clinic';
const CLINIC_ADDRESS = 'Cluster X, JLT, Dubai, UAE';
const CLINIC_NAME_AND_AREA = `${CLINIC_NAME}, JLT`;
const BUILT_BY = process.env.BUILT_BY || 'Developer';
const SIGN_OFF = `${CLINIC_NAME} · built at London International · lisrc.ae · by ${BUILT_BY}`;
const SUBJECT = 'Your appointment is confirmed';
const REMINDER_SIGN_OFF = `Powered by London International · lisrc.ae · built by ${BUILT_BY}`;
const REMINDER_SUBJECT = 'Reminder: your appointment';

let transporter = null;

/**
 * Get the SMTP transporter, created on first use from SMTP_* settings in .env
 * @returns {Object} Nodemailer transporter
 */
function getTransporter() {
  if (transporter) {
    return transporter;
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !process.env.SMTP_FROM) {
    throw new Error('SMTP_HOST, SMTP_PORT and SMTP_FROM must be set in .env');
  }

  const port = Number(SMTP_PORT);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // implicit TLS on 465; STARTTLS on 587/25
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return transporter;
}

/**
 * Format "YYYY-MM-DD HH:MM" into a readable date and time
 * @param {string} appointmentDateTime - Stored appointment date and time
 * @returns {{date: string, time: string}} Formatted parts
 */
function formatDateTime(appointmentDateTime) {
  const [datePart, time] = appointmentDateTime.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
  return { date, time };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class EmailService {
  /**
   * Build the confirmation email for a booking
   * @param {Object} booking - Appointment from the database
   * @returns {Object} Nodemailer message
   */
  static buildConfirmationEmail(booking) {
    const { date, time } = formatDateTime(booking.appointmentDateTime);
    const details = [
      ['Specialty', booking.specialty],
      ['Doctor', booking.doctor],
      ['Date', date],
      ['Time', time],
      ['Address', CLINIC_ADDRESS]
    ];

    const text = [
      `Dear ${booking.patientName},`,
      '',
      'Your appointment is confirmed and your AED 100 refundable deposit has been received.',
      '',
      ...details.map(([label, value]) => `${label}: ${value}`),
      '',
      `Booking ID: ${booking.id}`,
      '',
      '--',
      SIGN_OFF
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 560px;">
        <h2 style="color: #0066cc;">Your appointment is confirmed</h2>
        <p>Dear ${escapeHtml(booking.patientName)},</p>
        <p>Your appointment is confirmed and your AED 100 refundable deposit has been received.</p>
        <table style="border-collapse: collapse;">
          ${details.map(([label, value]) => `
          <tr>
            <td style="padding: 4px 16px 4px 0; font-weight: bold;">${label}</td>
            <td style="padding: 4px 0;">${escapeHtml(value)}</td>
          </tr>`).join('')}
        </table>
        <p>Booking ID: ${escapeHtml(booking.id)}</p>
        <hr style="border: none; border-top: 1px solid #ddd; margin-top: 24px;">
        <p style="font-size: 12px; color: #888;">${escapeHtml(SIGN_OFF)}</p>
      </div>`;

    return {
      from: { name: CLINIC_NAME, address: process.env.SMTP_FROM },
      to: { name: booking.patientName, address: booking.patientEmail },
      subject: SUBJECT,
      text,
      html
    };
  }

  /**
   * Build the reminder email for a booking
   * @param {Object} booking - Appointment from the database
   * @returns {Object} Nodemailer message
   */
  static buildReminderEmail(booking) {
    const { date, time } = formatDateTime(booking.appointmentDateTime);
    const message = `Hi ${booking.patientName}, a reminder that your ${booking.specialty} appointment ` +
      `with ${booking.doctor} is on ${date} at ${time} at ${CLINIC_NAME_AND_AREA}. Reply to reschedule.`;

    const text = [message, '', '--', REMINDER_SIGN_OFF].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 560px;">
        <p>${escapeHtml(message)}</p>
        <hr style="border: none; border-top: 1px solid #ddd; margin-top: 24px;">
        <p style="font-size: 12px; color: #888;">${escapeHtml(REMINDER_SIGN_OFF)}</p>
      </div>`;

    return {
      from: { name: CLINIC_NAME, address: process.env.SMTP_FROM },
      to: { name: booking.patientName, address: booking.patientEmail },
      subject: REMINDER_SUBJECT,
      text,
      html
    };
  }

  /**
   * Send a reminder email for a booking. Can be sent any number of times.
   * Never throws: failures are logged.
   * @param {Object} booking - Appointment from the database
   * @returns {Promise<boolean>} True if the email was sent
   */
  static async sendReminder(booking) {
    try {
      const info = await getTransporter().sendMail(EmailService.buildReminderEmail(booking));
      console.log(`Reminder email sent for booking ${booking.id}`);
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`Preview test email: ${previewUrl}`);
      }
      return true;
    } catch (error) {
      console.error(`Error sending reminder email for booking ${booking.id}:`, error.message);
      return false;
    }
  }

  /**
   * Send the confirmation email for a booking, at most once per appointment.
   * Never throws: failures are logged and the claim is released for a retry.
   * @param {Object} booking - Appointment from the database
   * @returns {Promise<boolean>} True if this call sent the email
   */
  static async sendConfirmationOnce(booking) {
    if (!AppointmentService.claimConfirmationEmail(booking.id)) {
      return false;
    }

    try {
      const info = await getTransporter().sendMail(EmailService.buildConfirmationEmail(booking));
      console.log(`Confirmation email sent for booking ${booking.id}`);
      // Only Ethereal test accounts have a web preview; false otherwise
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`Preview test email: ${previewUrl}`);
      }
      return true;
    } catch (error) {
      console.error(`Error sending confirmation email for booking ${booking.id}:`, error.message);
      AppointmentService.releaseConfirmationEmail(booking.id);
      return false;
    }
  }
}

module.exports = EmailService;
