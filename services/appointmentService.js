const db = require('../data/db');

// Appointment times are stored as clinic wall-clock time (Dubai)
const CLINIC_TIME_ZONE = 'Asia/Dubai';

// Statuses reception can set from the dashboard
const VISIT_STATUSES = ['Arrived', 'Done', 'No-show'];

class AppointmentService {
  /**
   * Today's date at the clinic (YYYY-MM-DD, Asia/Dubai), whatever the server's time zone
   * @param {Date} [now] - Current time
   * @returns {string} Date
   */
  static clinicToday(now = new Date()) {
    // en-CA formats as YYYY-MM-DD
    return now.toLocaleDateString('en-CA', { timeZone: CLINIC_TIME_ZONE });
  }

  /**
   * Add days to a YYYY-MM-DD date
   * @param {string} date - Date
   * @param {number} days - Days to add
   * @returns {string} Date
   */
  static addDays(date, days) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  /**
   * Get a day's confirmed appointments (unpaid Pending ones excluded),
   * sorted by doctor then time
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {Promise<Array>} Array of appointments
   */
  static getAppointmentsForDate(date) {
    return db.all(`
      SELECT * FROM appointments
      WHERE appointmentDateTime >= ? AND appointmentDateTime < ?
        AND status != 'Pending'
      ORDER BY doctor ASC, appointmentDateTime ASC
    `, date, AppointmentService.addDays(date, 1));
  }

  /**
   * Set an appointment's visit status from reception (Arrived, Done, No-show).
   * Unpaid (Pending) appointments can't be changed.
   * @param {number} bookingId - Booking ID
   * @param {string} status - One of VISIT_STATUSES
   * @returns {Promise<boolean>} True if updated
   */
  static async setVisitStatus(bookingId, status) {
    if (!VISIT_STATUSES.includes(status) || !Number.isInteger(bookingId)) {
      return false;
    }
    const result = await db.run(`
      UPDATE appointments
      SET status = ?
      WHERE id = ? AND status != 'Pending'
    `, status, bookingId);

    return result.changes > 0;
  }

  /**
   * Create a new booking
   * @param {Object} bookingData - Booking information
   * @param {string} bookingData.specialty - Specialty ID
   * @param {string} bookingData.doctor - Doctor name
   * @param {string} bookingData.date - Appointment date (YYYY-MM-DD)
   * @param {string} bookingData.time - Appointment time (HH:MM)
   * @param {string} bookingData.patientName - Patient full name
   * @param {string} bookingData.patientPhone - Patient phone number
   * @param {string} bookingData.patientEmail - Patient email address
   * @param {string} [bookingData.status] - Initial status (defaults to 'Booked')
   * @returns {Promise<Object>} Created appointment with id
   */
  static async createBooking(bookingData) {
    const {
      specialty,
      doctor,
      date,
      time,
      patientName,
      patientPhone,
      patientEmail,
      status = 'Booked'
    } = bookingData;

    // Combine date and time into DateTime format
    const appointmentDateTime = `${date} ${time}`;

    const result = await db.run(`
      INSERT INTO appointments (
        specialty,
        doctor,
        appointmentDateTime,
        patientName,
        patientPhone,
        patientEmail,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, specialty, doctor, appointmentDateTime, patientName, patientPhone, patientEmail, status);

    return {
      id: result.lastInsertRowid,
      specialty,
      doctor,
      appointmentDateTime,
      patientName,
      patientPhone,
      patientEmail,
      status
    };
  }

  /**
   * Save the Stripe Checkout Session id on a booking
   * @param {number} bookingId - Booking ID
   * @param {string} stripeSessionId - Stripe Checkout Session id
   * @returns {Promise<boolean>} Success
   */
  static async setStripeSessionId(bookingId, stripeSessionId) {
    const result = await db.run(`
      UPDATE appointments
      SET stripeSessionId = ?
      WHERE id = ?
    `, stripeSessionId, bookingId);

    return result.changes > 0;
  }

  /**
   * Claim the right to send a booking's confirmation email. Atomic, so only
   * one request wins even if the success page is refreshed at the same time.
   * @param {number} bookingId - Booking ID
   * @returns {Promise<boolean>} True if this caller should send the email
   */
  static async claimConfirmationEmail(bookingId) {
    const result = await db.run(`
      UPDATE appointments
      SET confirmationEmailSentAt = CURRENT_TIMESTAMP
      WHERE id = ? AND confirmationEmailSentAt IS NULL
    `, bookingId);

    return result.changes === 1;
  }

  /**
   * Release a claim after sending failed, so the email can be retried
   * @param {number} bookingId - Booking ID
   * @returns {Promise<boolean>} Success
   */
  static async releaseConfirmationEmail(bookingId) {
    const result = await db.run(`
      UPDATE appointments
      SET confirmationEmailSentAt = NULL
      WHERE id = ?
    `, bookingId);

    return result.changes > 0;
  }

  /**
   * Get a booking by its Stripe Checkout Session id
   * @param {string} stripeSessionId - Stripe Checkout Session id
   * @returns {Promise<Object|null>} Appointment or null
   */
  static getBookingByStripeSessionId(stripeSessionId) {
    return db.get(`
      SELECT * FROM appointments
      WHERE stripeSessionId = ?
    `, stripeSessionId);
  }

  /**
   * Get all bookings for a specific email
   * @param {string} email - Patient email
   * @returns {Promise<Array>} Array of appointments
   */
  static getBookingsByEmail(email) {
    return db.all(`
      SELECT * FROM appointments
      WHERE patientEmail = ?
      ORDER BY appointmentDateTime DESC
    `, email);
  }

  /**
   * Get all bookings for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise<Array>} Array of appointments
   */
  static getBookingsByDate(date) {
    return db.all(`
      SELECT * FROM appointments
      WHERE DATE(appointmentDateTime) = ?
      ORDER BY appointmentDateTime
    `, date);
  }

  /**
   * Update booking status
   * @param {number} bookingId - Booking ID
   * @param {string} status - New status
   * @returns {Promise<boolean>} Success
   */
  static async updateStatus(bookingId, status) {
    const result = await db.run(`
      UPDATE appointments
      SET status = ?
      WHERE id = ?
    `, status, bookingId);

    return result.changes > 0;
  }

  /**
   * Get a specific booking by ID
   * @param {number} bookingId - Booking ID
   * @returns {Promise<Object|null>} Appointment or null
   */
  static async getBookingById(bookingId) {
    if (!Number.isInteger(bookingId)) {
      return null;
    }
    return db.get(`
      SELECT * FROM appointments
      WHERE id = ?
    `, bookingId);
  }

  /**
   * Get confirmed (Booked) appointments from a date onwards, soonest first
   * @param {string} fromDate - First date to include (YYYY-MM-DD)
   * @returns {Promise<Array>} Array of appointments
   */
  static getUpcomingBookedAppointments(fromDate) {
    return db.all(`
      SELECT * FROM appointments
      WHERE status = 'Booked' AND appointmentDateTime >= ?
      ORDER BY appointmentDateTime ASC
    `, fromDate);
  }

  /**
   * Get all bookings
   * @returns {Promise<Array>} Array of all appointments
   */
  static getAllBookings() {
    return db.all(`
      SELECT * FROM appointments
      ORDER BY appointmentDateTime DESC
    `);
  }
}

AppointmentService.CLINIC_TIME_ZONE = CLINIC_TIME_ZONE;
AppointmentService.VISIT_STATUSES = VISIT_STATUSES;

module.exports = AppointmentService;
