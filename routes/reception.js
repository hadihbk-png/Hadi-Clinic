const express = require('express');
const router = express.Router();
const AppointmentService = require('../services/appointmentService');
const EmailService = require('../services/emailService');

/**
 * Message for the last button click (Post/Redirect/Get)
 * @param {Object} query - Request query
 * @returns {Object|null} Notice
 */
function getNotice(query) {
  const booking = AppointmentService.getBookingById(Number(query.reminded || query.reminderFailed || query.updated));
  if (!booking) {
    return null;
  }
  if (query.reminded) {
    return { type: 'success', text: `Reminder sent to ${booking.patientName} (${booking.patientEmail}).` };
  }
  if (query.reminderFailed) {
    return { type: 'danger', text: `Could not send the reminder to ${booking.patientName}. Please try again.` };
  }
  return { type: 'success', text: `${booking.patientName} marked as ${booking.status}.` };
}

// GET - Reception dashboard: today's appointments by doctor, plus upcoming reminders
router.get('/', (req, res) => {
  const today = AppointmentService.clinicToday();
  const todays = AppointmentService.getAppointmentsForDate(today);

  // Group today's appointments by doctor (already sorted by doctor, then time)
  const doctors = [];
  for (const appointment of todays) {
    let group = doctors.find(d => d.doctor === appointment.doctor);
    if (!group) {
      group = { doctor: appointment.doctor, appointments: [] };
      doctors.push(group);
    }
    group.appointments.push(appointment);
  }

  const upcoming = AppointmentService.getUpcomingBookedAppointments(AppointmentService.addDays(today, 1));

  res.render('reception', {
    today,
    todayCount: todays.length,
    doctors,
    upcoming,
    visitStatuses: AppointmentService.VISIT_STATUSES,
    notice: getNotice(req.query)
  });
});

// POST - Mark an appointment Arrived, Done or No-show
router.post('/:id/status', express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id);
  if (!AppointmentService.setVisitStatus(id, req.body.status)) {
    return res.status(400).send('Unknown appointment or status');
  }
  res.redirect(303, `/reception?updated=${id}`);
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
