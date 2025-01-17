const express = require('express');
const admin = require('firebase-admin');
const Mux = require('@mux/mux-node');
const nodemailer = require("nodemailer");
const { body, validationResult } = require('express-validator');
const cors = require('cors');
const config = require('./config.js');
const dotenv = require('dotenv');
const { FieldValue } = require('firebase-admin/firestore');

dotenv.config();


if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: config.projectId,
      clientEmail: config.clientEmail,
      privateKey: config.privateKey.replace(/\\n/g, "\n"),
    }),
    databaseURL: `https://${config.projectId}.firebaseio.com`,
  });
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;
// const { Video } = new Mux(config.muxApiKey, config.muxApiSecret);
// const {Video} = new Mux(
//     process.env.MUX_TOKEN_ID,
//     process.env.MUX_TOKEN_SECRET,
// );


// Middleware
app.use(express.json());
app.use(cors());

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Validators
const validateEvent = [
  body('title').isString().notEmpty(),
  body('date').isISO8601(),
  body('time').isString().notEmpty(),
  body('location').isString().notEmpty(),
  body('price').isObject(),
  body('description').isString().notEmpty(),
  body('agenda').isArray(),
  body('images').isArray(),
  body('ticketsLeft').isInt(),
  body('category').isString().notEmpty(),
  body('totalCapacityNeeded').isInt(),
];


// create users
app.post("/api/users", async (req, res) => {
  try {
    const user = req.body;
    await db.collection("users").doc(user.userId).set(user);
    res.status(201).send("User created successfully");
  } catch (error) {
    handleError(res, error);
  }
});


// create batch users
app.post("/api/users/batch", async (req, res) => {
  try {
    const users = req.body;
    const batch = db.batch();
    users.forEach((user) => {
      const userRef = db
        .collection("users")
        .doc(user.userId);
      batch.set(userRef, user);
    });

    await batch.commit();
    res.status(201).send("Batch users created successfully");
  } catch (error) {
    handleError(res, error);
  }
});


// event Routes
app.post('/api/events', validateEvent, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const eventRef = db.collection('events').doc();
    const eventId = eventRef.id;
    const eventData = {
      ...req.body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),  
      eventId: eventId  
    };
    await eventRef.set(eventData);
    res.status(201).json({ id: eventId });
  } catch (error) {
    res.status(500).json({ error: 'Error creating event' });
  }
});

app.post('/api/events/batch', async (req, res) => {
  try {
    const batch = db.batch();
    req.body.events.forEach((event) => {
      const eventRef = db.collection('events').doc();
      const eventId = eventRef.id;
      const eventData = {
        ...event,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),  
        eventId: eventId 
      };
      batch.set(eventRef, eventData);
    });
    await batch.commit();
    res.status(201).json({ message: 'Batch events created' });
  } catch (error) {
    res.status(500).json({ error: 'Error creating batch events' });
  }
});



// Get all events, optionally marking favorites for a logged-in user
app.get('/api/events', async (req, res) => {
  const { userId } = req.query;

  try {
    const eventsSnapshot = await db.collection('events').get();
    let events = eventsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (userId) {
      const favoriteRef = db.collection('favorites').doc(userId);
      const favoriteDoc = await favoriteRef.get();

      if (favoriteDoc.exists) {
        const favoriteEvents = favoriteDoc.data().events || [];
        events = events.map(event => ({
          ...event,
          isLiked: favoriteEvents.includes(event.id),
        }));
      } else {
        // No favorites found, so all events are not liked
        events = events.map(event => ({
          ...event,
          isLiked: false,
        }));
      }
    }

    res.status(200).json(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Error fetching events' });
  }
});


app.get('/api/events/:id', async (req, res) => {
  try {
    const eventRef = db.collection('events').doc(req.params.id);
    const doc = await eventRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching event' });
  }
});

app.get('/api/events/organizer/:organizerId', async (req, res) => {
  try {
    const snapshot = await db.collection('events').where('organizer.organizerId', '==', req.params.organizerId).get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching events by organizer' });
  }
});

app.put('/api/events/:id', validateEvent, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const eventRef = db.collection('events').doc(req.params.id);
    await eventRef.update(req.body);
    res.status(200).json({ message: 'Event updated' });
  } catch (error) {
    res.status(500).json({ error: 'Error updating event' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const eventRef = db.collection('events').doc(req.params.id);
    await eventRef.delete();
    res.status(200).json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting event' });
  }
});

app.delete('/api/events', async (req, res) => {
  try {
    // Retrieve all events
    const snapshot = await db.collection('events').get();
    if (snapshot.empty) {
      return res.status(404).json({ message: 'No events found' });
    }

    // Create a batch to delete all documents
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Commit the batch
    await batch.commit();
    res.status(200).json({ message: 'All events deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting all events' });
  }
});



// Get favorited events for a user, marking all as liked
app.get('/api/users/:userId/favorites', async (req, res) => {
  const { userId } = req.params;

  try {
    // Get the user's favorite events from the favorites collection
    const favoriteRef = db.collection('favorites').doc(userId);
    const favoriteDoc = await favoriteRef.get();
    
    if (!favoriteDoc.exists) {
      return res.status(404).json({ error: 'No favorites found for this user' });
    }

    const favoriteEvents = favoriteDoc.data().events;

    if (!favoriteEvents || favoriteEvents.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch the details of the favorited events from the events collection
    const eventsSnapshot = await db.collection('events')
      .where(admin.firestore.FieldPath.documentId(), 'in', favoriteEvents)
      .get();

    // Add isLiked field to each event
    const events = eventsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      isLiked: true,
    }));

    res.status(200).json(events);
  } catch (error) {
    console.error('Error fetching favorited events:', error);
    res.status(500).json({ error: 'Error fetching favorited events' });
  }
});



// Toggle favorite/unfavorite event for a user
app.post('/api/events/:id/toggleFavorite', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const favoriteRef = db.collection('favorites').doc(userId);
    const doc = await favoriteRef.get();

    if (doc.exists) {
      const favorites = doc.data().events || [];
      if (favorites.includes(req.params.id)) {
        await favoriteRef.update({
          events: admin.firestore.FieldValue.arrayRemove(req.params.id)
        });
        res.status(200).json({ message: 'Event unfavorited' });
      } else {
        await favoriteRef.update({
          events: admin.firestore.FieldValue.arrayUnion(req.params.id)
        });
        res.status(200).json({ message: 'Event favorited' });
      }
    } else {
      await favoriteRef.set({
        events: [req.params.id]
      });
      res.status(200).json({ message: 'Event favorited' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error toggling favorite' });
  }
});




// Get suggestions for a user, optionally marking favorites for a logged-in user
app.get('/api/users/:userId/suggestions', async (req, res) => {
  const { userId } = req.params;

  try {
    // Get the user's favorite events from the favorites collection
    const favoriteRef = db.collection('favorites').doc(userId);
    const favoriteDoc = await favoriteRef.get();

    if (!favoriteDoc.exists) {
      return res.status(404).json({ error: 'No favorites found for this user' });
    }

    const favoriteEvents = favoriteDoc.data().events;

    // If there are no favorite events, return an empty list
    if (!favoriteEvents || favoriteEvents.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch the categories and locations of the favorite events
    const favoriteCategories = new Set();
    const favoriteLocations = new Set();

    const favoriteEventsSnapshot = await db.collection('events')
      .where(admin.firestore.FieldPath.documentId(), 'in', favoriteEvents)
      .get();

    favoriteEventsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.category) {
        favoriteCategories.add(data.category);
      }
      if (data.location) {
        favoriteLocations.add(data.location);
      }
    });

    // If there are no categories or locations, return an empty list
    if (favoriteCategories.size === 0 && favoriteLocations.size === 0) {
      return res.status(200).json([]);
    }

    // Build the query
    let eventQuery = db.collection('events');
    
    if (favoriteCategories.size > 0) {
      eventQuery = eventQuery.where('category', 'in', Array.from(favoriteCategories));
    }
    
    if (favoriteLocations.size > 0) {
      eventQuery = eventQuery.where('location', 'in', Array.from(favoriteLocations));
    }

    // Fetch the events based on categories and locations
    const snapshot = await eventQuery.limit(10).get();
    let suggestedEvents = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Add isLiked field if the user is logged in
    if (userId) {
      suggestedEvents = suggestedEvents.map(event => ({
        ...event,
        isLiked: favoriteEvents.includes(event.id),
      }));
    }

    res.status(200).json(suggestedEvents);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Error fetching suggestions' });
  }
});



// TICKETS ROUTES

// ** Helper function to handle errors and responses ** //
const handleError = (res, status, message) => {
  res.status(status).json({
    success: false,
    message,
  });
};

// ** Helper function to handle successful responses ** //
const handleSuccess = (res, data) => {
  res.json({
    success: true,
    data,
  });
};

// ** 1. Get Event Revenue ** //
app.get('/api/events/:eventId/revenue', async (req, res) => {
  const { eventId } = req.params;

  try {
    const ticketsSnapshot = await db.collection('tickets').where('eventId', '==', eventId).get();

    if (ticketsSnapshot.empty) {
      return handleError(res, 404, 'No tickets found for this event.');
    }

    const totalRevenue = ticketsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().totalPrice || 0), 0);

    handleSuccess(res, { totalRevenue });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving event revenue.');
  }
});

// ** 2. Get Event Statistics ** //
app.get('/api/events/:eventId/statistics', async (req, res) => {
  const { eventId } = req.params;

  try {
    const ticketsSnapshot = await db.collection('tickets').where('eventId', '==', eventId).get();

    if (ticketsSnapshot.empty) {
      handleSuccess(res, {
      totalTickets: 0,
      totalRevenue:0,
      soldTickets:0,
      canceledTickets:0,
    }); ;
    }

    let totalRevenue = 0;
    const paymentSnapshot = await db.collection('payments').where('eventId', '==', eventId).where('status', '==', 'paid').get();
    if (paymentSnapshot.empty) {
      totalRevenue = 0; 
    }

    paymentSnapshot.forEach(doc => {
      totalRevenue += doc.data().amount;
    });

    const totalTickets = ticketsSnapshot.size;
    const soldTickets = ticketsSnapshot.docs.filter(doc => doc.data().status === 'confirmed').length;
    const canceledTickets = ticketsSnapshot.docs.filter(doc => doc.data().status === 'pending').length;

    handleSuccess(res, {
      totalTickets,
      totalRevenue,
      soldTickets,
      canceledTickets,
    });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving event statistics.');
  }
});

// ** 3. Update Ticket Status ** //
app.put('/api/tickets/:ticketId/status', async (req, res) => {
  const { ticketId } = req.params;
  const { status } = req.body;

  try {
    if (!['confirmed', 'canceled', 'pending'].includes(status)) {
      return handleError(res, 400, 'Invalid status.');
    }

    const ticketRef = db.collection('tickets').doc(ticketId);
    const ticket = await ticketRef.get();

    if (!ticket.exists) {
      return handleError(res, 404, 'Ticket not found.');
    }

    await ticketRef.update({ status });
    handleSuccess(res, { message: 'Ticket status updated successfully.' });
  } catch (e) {
    handleError(res, 500, 'An error occurred while updating ticket status.');
  }
});

// ** 4. Buy a Ticket ** //
app.post('/api/tickets/buy', async (req, res) => {
  const {
    eventId,
    userId,
    seat,
    ticketType,
    quantity,
    totalPrice,
    barcode,
    qrcode,
  } = req.body;

  try {
    if (quantity <= 0 || totalPrice <= 0) {
      return handleError(res, 400, 'Invalid quantity or total price.');
    }

    const eventDoc = db.collection('events').doc(eventId);
    const event = await eventDoc.get();

    if (!event.exists) {
      return handleError(res, 404, 'Event not found.');
    }

    const userDoc = db.collection('users').doc(userId);
    const user = await userDoc.get();

    if (!user.exists) {
      return handleError(res, 404, 'User not found.');
    }

    const ticketRef = db.collection('tickets').doc();
    const ticketId = ticketRef.id;

    await ticketRef.set({
      ticketId,
      eventId,
      userId,
      seat,
      ticketType,
      quantity,
      totalPrice,
      status: 'pending',
      barcode,
      qrcode,
    });

    handleSuccess(res, { message: 'Ticket purchased successfully.', ticketId });
  } catch (e) {
    handleError(res, 500, 'An error occurred while buying the ticket.');
  }
});

// ** 5. Get Ticket Details ** //
app.get('/api/tickets/:ticketId', async (req, res) => {
  const { ticketId } = req.params;

  try {
    const ticketRef = db.collection('tickets').doc(ticketId);
    const ticket = await ticketRef.get();

    if (!ticket.exists) {
      return handleError(res, 404, 'Ticket not found.');
    }

    handleSuccess(res, ticket.data());
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving ticket details.');
  }
});

// ** 6. Cancel Ticket ** //
app.delete('/api/tickets/:ticketId', async (req, res) => {
  const { ticketId } = req.params;

  try {
    const ticketRef = db.collection('tickets').doc(ticketId);
    const ticket = await ticketRef.get();

    if (!ticket.exists) {
      return handleError(res, 404, 'Ticket not found.');
    }

    await ticketRef.update({ status: 'canceled' });
    handleSuccess(res, { message: 'Ticket canceled successfully.' });
  } catch (e) {
    handleError(res, 500, 'An error occurred while canceling the ticket.');
  }
});

// ** 7. List Tickets for User ** //
app.get('/api/users/:userId/tickets', async (req, res) => {
  const { userId } = req.params;

  try {
    const querySnapshot = await db.collection('tickets').where('userId', '==', userId).get();

    if (querySnapshot.empty) {
      return handleError(res, 404, 'No tickets found for this user.');
    }

    const tickets = querySnapshot.docs.map(doc => doc.data());
    handleSuccess(res, tickets);
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving user tickets.');
  }
});

// verify tickets by qrcode
app.post('/api/tickets/verify/qrcode', async (req, res) => {
  const { qrcode } = req.body;

  try {
    const ticketSnapshot = await db.collection('tickets').where('qrcode', '==', qrcode).get();

    if (ticketSnapshot.empty) {
      return handleError(res, 404, 'Ticket not found.');
    }

    const ticket = ticketSnapshot.docs[0].data();
    handleSuccess(res, ticket);
  } catch (e) {
    handleError(res, 500, 'An error occurred while verifying the ticket.');
  }
});

// verify tickets by barcode
app.post('/api/tickets/verify/barcode', async (req, res) => {
  const { barcode } = req.body;

  try {
    const ticketSnapshot = await db.collection('tickets').where('barcode', '==', barcode).get();

    if (ticketSnapshot.empty) {
      return handleError(res, 404, 'Ticket not found.');
    }

    const ticket = ticketSnapshot.docs[0].data();
    handleSuccess(res, ticket);
  } catch (e) {
    handleError(res, 500, 'An error occurred while verifying the ticket.');
  }
});

// update  attendance by userid and eventid
app.put('/api/attendances/:userId/:eventId', async (req, res) => {
  // const { userId, eventId } = req.params;
  const { attendanceStatus, paymentStatus, userId, eventId } = req.body;
  try {
    const attendanceSnapshot = await db.collection('attendances').where('userId', '==', userId).where('eventId', '==', eventId).get();
    if (attendanceSnapshot.empty) {
      return handleError(res, 404, 'Attendance not found.');
    }
    const attendanceId = attendanceSnapshot.docs[0].id;
    await db.collection('attendances').doc(attendanceId).update({ attendanceStatus, paymentStatus });
    handleSuccess(res, { message: 'Attendance updated successfully.' });
  } catch (error) {
    handleError(res, 500, 'An error occurred while updating the attendance.');
  }
});


// REVENUE AND KPIS ROUTES
app.get('/api/organizers/:organizerId/kpis', async (req, res) => {
  const { organizerId } = req.params;

  try {
    const eventsSnapshot = await db.collection('events')
      .where('organizer.organizerId', '==', organizerId)
      .get();

    if (eventsSnapshot.empty) {
      return handleError(res, 404, 'No events found for this organizer.');
    }

    const eventIds = eventsSnapshot.docs.map(doc => doc.id);

    const ticketsSnapshot = await db.collection('tickets')
      .where('eventId', 'in', eventIds)
       .get();

    const totalRevenue = ticketsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().totalPrice || 0), 0);
    const totalSoldTickets = ticketsSnapshot.size;
    const totalEvents = eventsSnapshot.size;

    const ticketTypeCount = ticketsSnapshot.docs.reduce((acc, doc) => {
      const ticketType = doc.data().ticketType;
      if (acc[ticketType]) {
        acc[ticketType] += doc.data().quantity || 0;
      } else {
        acc[ticketType] = doc.data().quantity || 0;
      }
      return acc;
    }, {});

    const bestTicketType = Object.keys(ticketTypeCount).reduce((a, b) => ticketTypeCount[a] > ticketTypeCount[b] ? a : b, '');

    handleSuccess(res, {
      totalRevenue,
      totalSoldTickets,
      totalEvents,
      bestTicketType,
      bestTicketTypeQuantity: ticketTypeCount[bestTicketType] || 0
    });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving KPIs for the organizer.');
  }
});


// ATTENDANCE API ENDPOINTS
// Create a new attendance record
app.post('/api/attendance', async (req, res) => {
  const { attendanceId, eventId, userId, timestamp, attendanceStatus, paymentStatus } = req.body;
  try {
    await db.collection('attendances').doc(attendanceId).set({
      attendanceId,
      eventId,
      userId,
      timestamp: new Date(timestamp),
      attendanceStatus,
      paymentStatus,
    });
    res.status(201).send({ message: 'Attendance record created successfully', attendanceId });
  } catch (error) {
    res.status(500).send({ error: 'Error creating attendance record: ' + error.message });
  }
});

//create batch attendance with their attendndance ids
app.post("/api/attendances/batch", async (req, res) => {
  try {
    const attendances = req.body;
    const batch = db.batch();
    attendances.forEach((attendance) => {
      const attendanceRef = db.collection('attendances').doc();
      batch.set(attendanceRef, {
        ...attendance,
        attendanceId: attendanceRef.id
      });
      
    });
    await batch.commit();
    res.status(201).send({ message: 'Attendances created successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error creating attendances: ' + error.message });
  }
});

// Get a specific attendance record by ID
app.get('/api/attendance/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const attendanceDoc = await db.collection('attendances').doc(id).get();
    if (!attendanceDoc.exists) {
      return res.status(404).send({ message: 'Attendance record not found' });
    }
    res.status(200).send(attendanceDoc.data());
  } catch (error) {
    res.status(500).send({ error: 'Error fetching attendance record' });
  }
});

// Update a specific attendance record by ID
app.put('/api/attendance/:id', async (req, res) => {
  const { id } = req.params;
  const { attendanceStatus, paymentStatus } = req.body;
  try {
    await db.collection('attendances').doc(id).update({
      attendanceStatus,
      paymentStatus,
    });
    res.status(200).send({ message: 'Attendance record updated successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error updating attendance record' });
  }
});

// Delete a specific attendance record by ID
app.delete('/api/attendance/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.collection('attendances').doc(id).delete();
    res.status(200).send({ message: 'Attendance record deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error deleting attendance record' });
  }
});


// Get attendance list for a given event
app.get('/api/attendance/event/:eventId', async (req, res) => {
  const { eventId } = req.params;
  try {
    const attendanceSnapshot = await db.collection('attendances').where('eventId', '==', eventId).get();
    if (attendanceSnapshot.empty) {
      return res.status(404).send({ message: 'No attendance records found for this event' });
    }

    const attendanceList = [];
    for (const doc of attendanceSnapshot.docs) {
      const attendanceData = doc.data();
      const userSnapshot = await db.collection('users').doc(attendanceData.userId).get();
      if (!userSnapshot.exists) {
        continue;
      }
      const userData = userSnapshot.data();
      attendanceList.push({
        userId: userData.userId,
        name: userData.name,
        email: userData.email,
        avatarUrl: userData.avatarUrl,
        attendanceStatus: attendanceData.attendanceStatus,
        paymentStatus: attendanceData.paymentStatus,
      });
    }

    res.status(200).send(attendanceList);
  } catch (error) {
    res.status(500).send({ error: 'Error fetching attendance list: ' + error.message });
  }
});



// PAYMENT API ENDPOINTS
// Create a new ticket payment record
app.post('/api/payments', async (req, res) => {
  const { paymentId, userId, eventId, amount, status, paymentType } = req.body;
  if(!paymentId || !userId || !eventId || !amount || !status || !paymentType) {
    return res.status(400).send({ message: 'Missing required fields' });
  }
  
  try {
    await db.collection('payments').doc(paymentId).set({
      paymentId,
      userId,
      eventId,
      amount,
      status,
      paymentType,
      timestamp: FieldValue.serverTimestamp(),
    });
    res.status(201).send({ message: 'Payment record created successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error creating payment record, : ' + error.message });
  }
});


// create batch payments
app.post("/api/payments/batch", async (req, res) => {
  try {
    const payments = req.body;
    const batch = db.batch();
    payments.forEach((payment) => {
      const paymentRef = db
        .collection("payments")
        .doc(payment.paymentId);
      batch.set(paymentRef, payment);
    });

    await batch.commit();
    res.status(201).send("Batch payments created successfully");
  } catch (error) {
    handleError(res, error);
  }
});

// Get a specific payment record by ID
app.get('/api/payments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const paymentDoc = await db.collection('payments').doc(id).get();
    if (!paymentDoc.exists) {
      return res.status(404).send({ message: 'Payment record not found' });
    }
    res.status(200).send(paymentDoc.data());
  } catch (error) {
    res.status(500).send({ error: 'Error fetching payment record' });
  }
});

// Update a specific payment record by ID
app.put('/api/payments/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.collection('payments').doc(id).update({
      status,
    });
    res.status(200).send({ message: 'Payment record updated successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error updating payment record' });
  }
});

// Delete a specific payment record by ID
app.delete('/api/payments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.collection('payments').doc(id).delete();
    res.status(200).send({ message: 'Payment record deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Error deleting payment record' });
  }
});

// Get all payments for a specific user
app.get('/api/payments/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const paymentSnapshot = await db.collection('payments').where('userId', '==', userId).get();
    if (paymentSnapshot.empty) {
      return res.status(404).send({ message: 'No payment records found for this user' });
    }

    const paymentList = [];
    paymentSnapshot.forEach(doc => {
      paymentList.push(doc.data());
    });

    res.status(200).send(paymentList);
  } catch (error) {
    res.status(500).send({ error: 'Error fetching payment records' });
  }
});


// Get total revenue for a specific event
app.get('/api/revenue/event/:eventId', async (req, res) => {
  const { eventId } = req.params;
  try {
    const paymentSnapshot = await db.collection('payments').where('eventId', '==', eventId).where('status', '==', 'paid').get();
    if (paymentSnapshot.empty) {
      return res.status(404).send({ message: 'No payment records found for this event' });
    }

    let totalRevenue = 0;
    paymentSnapshot.forEach(doc => {
      totalRevenue += doc.data().amount;
    });

    res.status(200).send({ totalRevenue });
  } catch (error) {
    res.status(500).send({ error: 'Error fetching total revenue' });
  }
});



// create notifications
app.post("/api/notifications", async (req, res) => {
  try {
    const notificationData = req.body;
    await db
      .collection("notifications")
      .doc(notificationData.notification_id)
      .set(notificationData);
    res.status(201).send("Notification created successfully");
  } catch (error) {
    handleError(res, error);
  }
});

// Create batch notifications
app.post("/api/notifications/batch", async (req, res) => {
  try {
    const notifications = req.body;
    const batch = db.batch();
    notifications.forEach((notification) => {
      const notificationRef = db
        .collection("notifications")
        .doc(notification.notification_id);
      batch.set(notificationRef, notification);
    });

    await batch.commit();
    res.status(201).send("Batch notifications created successfully");
  } catch (error) {
    handleError(res, error);
  }
});

// send an email to a user for verification
app.post("/api/verify", async (req, res) => {
  try {
    const message = req.body;
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: "junioratta2929@gmail.com",
        pass: "jvbsyhzavpfmbqdj",
      },
    });
    // Email details
    let mailOptions = {
      from: "ticketron<noreply@ticketron.com>",
      to: message?.email,
      subject: "Ticketron Organizer Account Email Verification",
      text: `Please this is your ticketron account email verification code: ${message?.verificationCode} , do not share it with anyone else.`,
    };
    let info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.response);
    return res.status(201).send({
      message: "Email sent successfully", success: true});
  } catch (error) {
    handleError(res, error);
  }
});


const { video } = new Mux(
    process.env.MUX_TOKEN_ID,
    process.env.MUX_TOKEN_SECRET,
);


// Endpoint to start a livestream
app.post('/livestreams/start', async (req, res) => {
  try {
    const {  playback_policy = 'public' } = req.body;
    const newStream = await video.liveStreams.create({
      playback_policy,
      new_asset_settings: { playback_policy },
      reconnect_window: 10,
    });
    res.status(201).json(newStream);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get a list of livestreams
app.get('/livestreams', async (req, res) => {
  try {
    const livestreams = await video.liveStreams.list();
    res.status(200).json(livestreams);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get livestream details
app.get('/livestreams/:id', async (req, res) => {
  try {
    const livestreamId = req.params.id;
    const livestream = await video.liveStreams.retrieve(livestreamId);
    res.status(200).json(livestream);
  } catch (error) {

    res.status(500).json({ error: error.message });
  }
});

// Endpoint to end a livestream
app.post('/livestreams/:id/end', async (req, res) => {
  try {
    const livestreamId = req.params.id;
    await video.liveStreams.disable(livestreamId);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, "0.0.0.0" ,() => {
  console.log(`Server running at http://localhost:${port}`);
});
