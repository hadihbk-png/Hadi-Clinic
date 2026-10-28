# Hadi Medical Clinic - Quick Reference Guide

## 🚀 Getting Started

### Configure Stripe (test mode)
Copy `.env.example` to `.env` and set:
- `STRIPE_SECRET_KEY` - your Stripe **test** secret key (`sk_test_...`). Live keys are refused.
- `BASE_URL` - the site's address, e.g. `http://localhost:3005`

`.env` is git-ignored - never commit it. Pay with Stripe's test card `4242 4242 4242 4242`, any future expiry and any CVC.

### Configure confirmation emails (SMTP)
When a paid booking becomes `Booked`, a confirmation email is sent once to the patient (`services/emailService.js`). Set in `.env`:
`SMTP_HOST`, `SMTP_PORT` (465 = TLS, 587 = STARTTLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (sender address).
For Gmail use `smtp.gmail.com`, port 465 and a Google App Password. If sending fails the error is logged, the booking stays confirmed, and sending is retried the next time the success page is opened.

### Chat assistant ("Ask Hadi")
A floating chat button on every page (`views/partials/footer.ejs`) talks to `POST /api/chat`. All AI code is in `services/assistantService.js`: it answers only from the clinic facts in its system prompt, refuses medical advice (offers to book the right specialist and points to emergency care for serious symptoms), and ends every reply with the clinic sign-off. Set in `.env`:
- `ANTHROPIC_API_KEY` - Claude API key (server-side only, never sent to the browser)
- `CLINIC_INSURANCE` - insurers accepted, e.g. `Daman, AXA, or cash`; if empty the assistant says it doesn't know and suggests calling

Each visitor is limited to 20 messages per 10 minutes.

### Reception login and sign-off name
- `RECEPTION_EMAIL` / `RECEPTION_PASSWORD` - on startup a user with role `reception` is created (or its password updated) in the `users` table, password hashed with bcryptjs. Log in at `/login`; only the `reception` role can open `/reception` and `/admin/bookings`. With no password set, nobody can log in. Use HTTPS when the site is online.
- The reception dashboard shows today's appointments (Asia/Dubai date) grouped by doctor with Arrived / Done / No-show buttons, plus upcoming appointments with "Send reminder".
- `BUILT_BY` - your name, shown in the site footer and email sign-offs.

### Test without a Stripe account or mail server
A local fake Stripe (`test/fake-stripe-server.js`) and fake SMTP server (`test/fake-smtp-server.js`) stand in for the real services:
- `npm run test:deposit` - automated end-to-end tests on a throwaway database
- `npm run demo:payments` - click through it at http://localhost:3006/booking (separate `data/demo.db`); sent emails are printed in the terminal

### Start Development Server
```bash
npm run dev
```
The server will run at **http://localhost:3005** with automatic file reloading.

### Start Production Server
```bash
npm start
```
The server will run at **http://localhost:3005**

---

## 📍 Application Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Homepage |
| `/booking` | GET | Booking form (all steps) |
| `/booking/submit` | POST | Form navigation between steps |
| `/booking/confirm` | POST | Save booking as Pending and redirect to Stripe Checkout for the AED 100 deposit |
| `/booking-success` | GET | Verify the deposit with Stripe; mark booking Booked only if paid |
| `/login`, `/logout` | GET/POST | Staff login (email + password) and logout |
| `/admin/bookings` | GET | Admin dashboard - view all bookings (reception role) |
| `/reception` | GET | Reception dashboard: today's appointments by doctor + upcoming (reception role) |
| `/reception/:id/status` | POST | Mark Arrived / Done / No-show (reception role) |
| `/reception/:id/remind` | POST | Email a reminder to the patient (reception role) |
| `/api/chat` | POST | "Ask Hadi" chat assistant - sends the conversation to Claude (claude-haiku-5-5) server-side |

---

## 📊 Booking Flow

1. **Step 1**: Select Specialty
   - General Physician
   - ENT
   - Dentist
   - Cardiologist

2. **Step 2**: Select Doctor
   - Automatically assigned based on specialty

3. **Step 3**: Choose Date & Time
   - Date picker (no past dates)
   - Closed on Sundays
   - Time slots: 9am-9pm (30-minute intervals)

4. **Step 4**: Patient Information
   - Full Name (minimum 2 characters)
   - Email (valid format)
   - Phone (valid format)

5. **Step 5**: Review Summary
   - All booking details displayed
   - Option to edit (go back)

6. **Step 6**: Deposit & Confirmation
   - Booking saved to database with status `Pending`
   - Patient pays a refundable AED 100 deposit on Stripe Checkout
   - On return, the server checks the payment with Stripe: `paid` → status `Booked` and confirmation page; otherwise it stays `Pending` and a "payment not completed" message is shown
   - Cancelling on Stripe returns the patient to `/booking`

---

## 💾 Database

### Location
- **File**: `data/lakeside.db`
- **Mode**: SQLite with WAL (Write-Ahead Logging)

### Appointments Table
```sql
CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specialty TEXT NOT NULL,
  doctor TEXT NOT NULL,
  appointmentDateTime DATETIME NOT NULL,
  patientName TEXT NOT NULL,
  patientPhone TEXT NOT NULL,
  patientEmail TEXT NOT NULL,
  status TEXT DEFAULT 'Booked',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

---

## 🔧 Service Layer

### AppointmentService Methods

```javascript
// Create a new booking
AppointmentService.createBooking({
  specialty: 'General Physician',
  doctor: 'Dr. Sara Ahmed',
  date: '2026-10-25',
  time: '14:00',
  patientName: 'John Doe',
  patientPhone: '+971 50 123 4567',
  patientEmail: 'john@example.com'
})

// Get booking by ID
AppointmentService.getBookingById(1)

// Get bookings by patient email
AppointmentService.getBookingsByEmail('john@example.com')

// Get bookings on specific date
AppointmentService.getBookingsByDate('2026-10-25')

// Update booking status
AppointmentService.updateStatus(1, 'Completed')

// Get all bookings
AppointmentService.getAllBookings()
```

---

## 👨‍⚕️ Doctors

| Specialty | Doctor |
|-----------|--------|
| General Physician | Dr. Sara Ahmed |
| ENT | Dr. Omar Khan |
| Dentist | Dr. Lina Haddad |
| Cardiologist | Dr. Raj Mehta |

---

## 🎨 Design & Theme

- **Primary Color**: #0066cc (Medical Blue)
- **Secondary Color**: White
- **Success Color**: #28a745 (Green)
- **Framework**: Bootstrap 5
- **Icons**: Bootstrap Icons
- **Responsive**: Mobile-first design

---

## 📦 Dependencies

- `express@5.3.0` - Web framework
- `ejs@7.0.2` - Template engine
- `node:sqlite` - Built-in SQLite (no installation needed)

---

## 🔐 Security Features

✅ **Prepared Statements** - SQL injection protection
✅ **Input Validation** - Server-side validation on all inputs
✅ **Email Validation** - RFC standard email format check
✅ **Phone Validation** - Minimum 7 digits with formatting
✅ **Date Validation** - No past dates, Sundays blocked

---

## 📋 File Structure

```
Hadi Clinic/
├── server.js                    # Main Express server
├── package.json                 # Dependencies
├── .gitignore                   # Git ignore rules
├── data/
│   ├── db.js                   # Database initialization
│   └── lakeside.db              # SQLite database file
├── services/
│   └── appointmentService.js    # Business logic layer
├── routes/
│   └── booking.js               # Booking routes
├── views/
│   ├── index.ejs                # Homepage
│   ├── booking.ejs              # Booking form (all steps)
│   ├── admin-bookings.ejs       # Admin dashboard
│   └── partials/
│       ├── header.ejs           # Navigation header
│       └── footer.ejs           # Footer
└── public/
    └── css/
        └── site.css             # Custom styles
```

---

## 🧪 Testing

### Create Test Booking (CLI)
```javascript
node -e "
const AppointmentService = require('./services/appointmentService');
const booking = AppointmentService.createBooking({
  specialty: 'General Physician',
  doctor: 'Dr. Sara Ahmed',
  date: '2026-10-25',
  time: '14:00',
  patientName: 'Test Patient',
  patientPhone: '+971 50 123 4567',
  patientEmail: 'test@example.com'
});
console.log('Booking created:', booking);
"
```

### View All Bookings (CLI)
```javascript
node -e "
const AppointmentService = require('./services/appointmentService');
console.log(AppointmentService.getAllBookings());
"
```

---

## 📝 Clinic Information

- **Name**: Hadi Medical Clinic
- **Location**: Cluster X, JLT, Dubai
- **Tagline**: Expert care, close to home
- **Phone**: +971 4 123 4567
- **Hours**: Mon-Sat 9am-9pm (Closed Sunday)

---

## 🚀 Deployment Notes

- **Environment Variables**:
  - `PORT` - Server port (default: 3000)
  - `DB_PATH` - Database file path (default: data/lakeside.db)

- **No Native Dependencies** - Uses Node.js built-in SQLite module
- **Production Ready** - Error handling and validation included
- **Scalable Architecture** - Service layer enables easy database swapping

---

## 📧 Support

For questions or issues, refer to the inline code comments or check:
- `routes/booking.js` - Booking logic
- `services/appointmentService.js` - Database operations
- `data/db.js` - Database initialization

---

**Last Updated**: October 21, 2026  
**Status**: ✅ Complete & Verified
