const express = require('express');
const router = express.Router();
const AppointmentService = require('../services/appointmentService');
const PaymentService = require('../services/paymentService');
const EmailService = require('../services/emailService');

// Specialty and doctor data
const specialties = {
  'general-physician': {
    name: 'General Physician',
    doctor: 'Dr. Sara Ahmed',
    description: 'Comprehensive primary care and health management'
  },
  'ent': {
    name: 'ENT',
    doctor: 'Dr. Omar Khan',
    description: 'Ear, nose, and throat specialist care'
  },
  'dentist': {
    name: 'Dentist',
    doctor: 'Dr. Lina Haddad',
    description: 'Professional dental care and treatments'
  },
  'cardiologist': {
    name: 'Cardiologist',
    doctor: 'Dr. Raj Mehta',
    description: 'Heart and cardiovascular health services'
  }
};

// Available time slots (9am to 9pm, 30-minute intervals)
const timeSlots = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00', '14:30',
  '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
  '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'
];

// GET - Show booking form
router.get('/', (req, res) => {
  const step = parseInt(req.query.step) || 1;
  const bookingData = req.query;

  res.render('booking', {
    step,
    bookingData,
    showSummary: false,
    showConfirmation: false,
    specialties: Object.entries(specialties).map(([key, value]) => ({
      id: key,
      ...value
    })),
    timeSlots,
    selectedSpecialty: bookingData.specialty ? specialties[bookingData.specialty] : null,
    errors: []
  });
});

// POST - Handle booking form submissions
router.post('/submit', express.urlencoded({ extended: true }), (req, res) => {
  const { step, ...data } = req.body;
  const currentStep = parseInt(step);

  // Validation for current step
  const errors = [];

  if (currentStep === 1) {
    if (!data.specialty || !specialties[data.specialty]) {
      errors.push('Please select a specialty');
    }
  }

  if (currentStep === 2) {
    if (!data.specialty || !specialties[data.specialty]) {
      errors.push('Specialty is required');
    }
  }

  if (currentStep === 3) {
    if (!data.specialty || !specialties[data.specialty]) {
      errors.push('Specialty is required');
    }
    if (!data.date) {
      errors.push('Please select a date');
    } else {
      const selectedDate = new Date(data.date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (selectedDate < today) {
        errors.push('Please select a future date');
      }

      // Check for Sunday (day 0)
      if (selectedDate.getDay() === 0) {
        errors.push('We are closed on Sundays. Please select another date');
      }
    }
    if (!data.time) {
      errors.push('Please select a time slot');
    }
  }

  if (currentStep === 4) {
    if (!data.specialty || !specialties[data.specialty]) {
      errors.push('Specialty is required');
    }
    if (!data.date) {
      errors.push('Please select a date');
    } else {
      const selectedDate = new Date(data.date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (selectedDate < today) {
        errors.push('Please select a future date');
      }

      if (selectedDate.getDay() === 0) {
        errors.push('We are closed on Sundays. Please select another date');
      }
    }
    if (!data.time) {
      errors.push('Please select a time slot');
    }
    if (!data.patientName || data.patientName.trim().length < 2) {
      errors.push('Please enter a valid patient name (at least 2 characters)');
    }
    if (!data.patientEmail || !isValidEmail(data.patientEmail)) {
      errors.push('Please enter a valid email address');
    }
    if (!data.patientPhone || !isValidPhone(data.patientPhone)) {
      errors.push('Please enter a valid phone number');
    }
  }

  if (errors.length > 0) {
    return res.render('booking', {
      step: currentStep,
      bookingData: data,
      showSummary: false,
      showConfirmation: false,
      specialties: Object.entries(specialties).map(([key, value]) => ({
        id: key,
        ...value
      })),
      timeSlots,
      selectedSpecialty: data.specialty ? specialties[data.specialty] : null,
      errors
    });
  }

  // If validation passes, move to next step
  const nextStep = currentStep + 1;

  // Show summary on step 5 (after all steps)
  if (nextStep > 4) {
    return res.render('booking', {
      step: 5,
      bookingData: data,
      showSummary: true,
      showConfirmation: false,
      specialties: Object.entries(specialties).map(([key, value]) => ({
        id: key,
        ...value
      })),
      selectedSpecialty: specialties[data.specialty],
      timeSlots,
      errors: []
    });
  }

  // Build query string with existing data
  const queryParams = new URLSearchParams(data);
  queryParams.set('step', nextStep);

  res.redirect(`/booking?${queryParams.toString()}`);
});

// POST - Confirm booking, save it as Pending and send the patient to Stripe Checkout
router.post('/confirm', express.urlencoded({ extended: true }), async (req, res) => {
  const { specialty, date, time, patientName, patientEmail, patientPhone } = req.body;

  // Validate all required fields
  const errors = [];
  if (!specialty || !specialties[specialty]) {
    errors.push('Invalid specialty');
  }
  if (!date) {
    errors.push('Date is required');
  }
  if (!time) {
    errors.push('Time is required');
  }
  if (!patientName || patientName.trim().length < 2) {
    errors.push('Invalid patient name');
  }
  if (!patientEmail || !isValidEmail(patientEmail)) {
    errors.push('Invalid email address');
  }
  if (!patientPhone || !isValidPhone(patientPhone)) {
    errors.push('Invalid phone number');
  }

  if (errors.length > 0) {
    return res.render('booking', {
      step: 4,
      bookingData: req.body,
      showSummary: false,
      showConfirmation: false,
      specialties: Object.entries(specialties).map(([key, value]) => ({
        id: key,
        ...value
      })),
      selectedSpecialty: specialties[specialty],
      errors
    });
  }

  try {
    // Save booking as Pending until the deposit is paid
    const booking = AppointmentService.createBooking({
      specialty: specialties[specialty].name,
      doctor: specialties[specialty].doctor,
      date,
      time,
      patientName,
      patientPhone,
      patientEmail,
      status: 'Pending'
    });

    // Create the deposit Checkout Session and remember it on the booking
    const session = await PaymentService.createDepositCheckoutSession(booking);
    AppointmentService.setStripeSessionId(booking.id, session.id);

    // Send the patient to the Stripe-hosted checkout page
    res.redirect(303, session.url);
  } catch (error) {
    console.error('Error starting deposit payment:', error.message);
    res.render('booking', {
      step: 5,
      bookingData: req.body,
      showSummary: true,
      showConfirmation: false,
      specialties: Object.entries(specialties).map(([key, value]) => ({
        id: key,
        ...value
      })),
      selectedSpecialty: specialties[specialty],
      timeSlots,
      errors: ['We could not start the deposit payment. Please try again.']
    });
  }
});

// GET /booking-success - Verify the deposit with Stripe before marking the booking as Booked
async function bookingSuccess(req, res) {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  const booking = sessionId ? AppointmentService.getBookingByStripeSessionId(sessionId) : null;

  const renderResult = (viewData) => res.render('booking', {
    step: 6,
    bookingData: {},
    showSummary: false,
    showConfirmation: false,
    showPaymentIncomplete: false,
    specialties: Object.entries(specialties).map(([key, value]) => ({
      id: key,
      ...value
    })),
    errors: [],
    ...viewData
  });

  if (!booking) {
    res.status(404);
    return renderResult({ showPaymentIncomplete: true, booking: null });
  }

  try {
    // Never trust the redirect alone: ask Stripe whether the deposit was paid
    const session = await PaymentService.retrieveCheckoutSession(sessionId);

    if (session.payment_status === 'paid') {
      if (booking.status !== 'Booked') {
        AppointmentService.updateStatus(booking.id, 'Booked');
        booking.status = 'Booked';
      }
      // Sent in the background, at most once; failures are logged inside
      EmailService.sendConfirmationOnce(booking);
      return renderResult({ showConfirmation: true, booking });
    }
  } catch (error) {
    console.error('Error verifying deposit payment:', error.message);
  }

  renderResult({ showPaymentIncomplete: true, booking });
}

// Helper function to validate email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Helper function to validate phone
function isValidPhone(phone) {
  const phoneRegex = /^[0-9\s\-\+\(\)]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 7;
}

module.exports = router;
module.exports.bookingSuccess = bookingSuccess;
