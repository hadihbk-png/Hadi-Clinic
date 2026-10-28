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
   * @returns {Array} Array of appointments
   */
  static getAppointmentsForDate(date) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE appointmentDateTime >= ? AND appointmentDateTime < ?
        AND status != 'Pending'
      ORDER BY doctor ASC, appointmentDateTime ASC
    `);

    return stmt.all(date, AppointmentService.addDays(date, 1));
  }

  /**
   * Set an appointment's visit status from reception (Arrived, Done, No-show).
   * Unpaid (Pending) appointments can't be changed.
   * @param {number} bookingId - Booking ID
   * @param {string} status - One of VISIT_STATUSES
   * @returns {boolean} True if updated
   */
  static setVisitStatus(bookingId, status) {
    if (!VISIT_STATUSES.includes(status)) {
      return false;
    }
    const stmt = db.prepare(`
      UPDATE appointments
      SET status = ?
      WHERE id = ? AND status != 'Pending'
    `);

    return stmt.run(status, bookingId).changes > 0;
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
   * @returns {Object} Created appointment with id
   */
  static createBooking(bookingData) {
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

    const stmt = db.prepare(`
      INSERT INTO appointments (
        specialty,
        doctor,
        appointmentDateTime,
        patientName,
        patientPhone,
        patientEmail,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      specialty,
      doctor,
      appointmentDateTime,
      patientName,
      patientPhone,
      patientEmail,
      status
    );

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
   * @returns {boolean} Success
   */
  static setStripeSessionId(bookingId, stripeSessionId) {
    const stmt = db.prepare(`
      UPDATE appointments
      SET stripeSessionId = ?
      WHERE id = ?
    `);

    const result = stmt.run(stripeSessionId, bookingId);
    return result.changes > 0;
  }

  /**
   * Claim the right to send a booking's confirmation email. Atomic, so only
   * one request wins even if the success page is refreshed at the same time.
   * @param {number} bookingId - Booking ID
   * @returns {boolean} True if this caller should send the email
   */
  static claimConfirmationEmail(bookingId) {
    const stmt = db.prepare(`
      UPDATE appointments
      SET confirmationEmailSentAt = CURRENT_TIMESTAMP
      WHERE id = ? AND confirmationEmailSentAt IS NULL
    `);

    return stmt.run(bookingId).changes === 1;
  }

  /**
   * Release a claim after sending failed, so the email can be retried
   * @param {number} bookingId - Booking ID
   * @returns {boolean} Success
   */
  static releaseConfirmationEmail(bookingId) {
    const stmt = db.prepare(`
      UPDATE appointments
      SET confirmationEmailSentAt = NULL
      WHERE id = ?
    `);

    return stmt.run(bookingId).changes > 0;
  }

  /**
   * Get a booking by its Stripe Checkout Session id
   * @param {string} stripeSessionId - Stripe Checkout Session id
   * @returns {Object|null} Appointment or null
   */
  static getBookingByStripeSessionId(stripeSessionId) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE stripeSessionId = ?
    `);

    return stmt.get(stripeSessionId);
  }

  /**
   * Get all bookings for a specific email
   * @param {string} email - Patient email
   * @returns {Array} Array of appointments
   */
  static getBookingsByEmail(email) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE patientEmail = ?
      ORDER BY appointmentDateTime DESC
    `);

    return stmt.all(email);
  }

  /**
   * Get all bookings for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Array} Array of appointments
   */
  static getBookingsByDate(date) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE DATE(appointmentDateTime) = ?
      ORDER BY appointmentDateTime
    `);

    return stmt.all(date);
  }

  /**
   * Update booking status
   * @param {number} bookingId - Booking ID
   * @param {string} status - New status
   * @returns {boolean} Success
   */
  static updateStatus(bookingId, status) {
    const stmt = db.prepare(`
      UPDATE appointments
      SET status = ?
      WHERE id = ?
    `);

    const result = stmt.run(status, bookingId);
    return result.changes > 0;
  }

  /**
   * Get a specific booking by ID
   * @param {number} bookingId - Booking ID
   * @returns {Object|null} Appointment or null
   */
  static getBookingById(bookingId) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE id = ?
    `);

    return stmt.get(bookingId);
  }

  /**
   * Get confirmed (Booked) appointments from today onwards, soonest first
   * @param {string} fromDate - First date to include (YYYY-MM-DD)
   * @returns {Array} Array of appointments
   */
  static getUpcomingBookedAppointments(fromDate) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE status = 'Booked' AND appointmentDateTime >= ?
      ORDER BY appointmentDateTime ASC
    `);

    return stmt.all(fromDate);
  }

  /**
   * Get all bookings
   * @returns {Array} Array of all appointments
   */
  static getAllBookings() {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      ORDER BY appointmentDateTime DESC
    `);

    return stmt.all();
  }
}

AppointmentService.CLINIC_TIME_ZONE = CLINIC_TIME_ZONE;
AppointmentService.VISIT_STATUSES = VISIT_STATUSES;

module.exports = AppointmentService;
