const express = require('express');
const router = express.Router();
const AppointmentService = require('../services/appointmentService');
const EmailService = require('../services/emailService');

// Today's date (YYYY-MM-DD) in the server's local time zone
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// GET - Staff list of upcoming confirmed appointments (today included)
router.get('/', (req, res) => {
  const bookings = AppointmentService.getUpcomingBookedAppointments(today());

  // Result of the last "Send reminder" click (Post/Redirect/Get)
  let notice = null;
  const remindedId = Number(req.query.reminded || req.query.reminderFailed);
  const reminded = bookings.find(booking => booking.id === remindedId);
  if (reminded) {
    notice = req.query.reminded
      ? { type: 'success', text: `Reminder sent to ${reminded.patientName} (${reminded.patientEmail}).` }
      : { type: 'danger', text: `Could not send the reminder to ${reminded.patientName}. Please try again.` };
  }

  res.render('reception', { bookings, notice });
});

// POST - Send a reminder email for one Booked appointment
router.post('/:id/remind', async (req, res) => {
  const booking = AppointmentService.getBookingById(Number(req.params.id));

  if (!booking || booking.status !== 'Booked') {
    return res.status(404).send('Booked appointment not found');
  }

  const sent = await EmailService.sendReminder(booking);
  res.redirect(303, `/reception?${sent ? 'reminded' : 'reminderFailed'}=${booking.id}`);
});

module.exports = router;
