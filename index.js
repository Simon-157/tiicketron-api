const express = require('express');
const admin = require('firebase-admin');
const Mux = require('@mux/mux-node');
const nodemailer = require("nodemailer");
const { body, validationResult } = require('express-validator');
const cors = require('cors');
const config = require('./config.js');
const dotenv = require('dotenv');

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

// Routes
app.post('/events', validateEvent, async (req, res) => {
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

app.post('/events/batch', async (req, res) => {
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
app.get('/events', async (req, res) => {
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


app.get('/events/:id', async (req, res) => {
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

app.get('/events/organizer/:organizerId', async (req, res) => {
  try {
    const snapshot = await db.collection('events').where('organizer.organizerId', '==', req.params.organizerId).get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching events by organizer' });
  }
});

app.put('/events/:id', validateEvent, async (req, res) => {
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

app.delete('/events/:id', async (req, res) => {
  try {
    const eventRef = db.collection('events').doc(req.params.id);
    await eventRef.delete();
    res.status(200).json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting event' });
  }
});

app.delete('/events', async (req, res) => {
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



// Get favorited events for a user
app.get('/users/:userId/favorites', async (req, res) => {
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
    const eventsSnapshot = await db.collection('events').where(admin.firestore.FieldPath.documentId(), 'in', favoriteEvents).get();

    const events = eventsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.status(200).json(events);
  } catch (error) {
    console.error('Error fetching favorited events:', error);
    res.status(500).json({ error: 'Error fetching favorited events' });
  }
});


// Toggle favorite/unfavorite event for a user
app.post('/events/:id/toggleFavorite', async (req, res) => {
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
app.get('/users/:userId/suggestions', async (req, res) => {
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
      return handleError(res, 404, 'No tickets found for this event.');
    }

    const totalTickets = ticketsSnapshot.size;
    const totalRevenue = ticketsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().totalPrice || 0), 0);
    const soldTickets = ticketsSnapshot.docs.filter(doc => doc.data().status === 'confirmed').length;
    const canceledTickets = ticketsSnapshot.docs.filter(doc => doc.data().status === 'canceled').length;

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



// REVENUE AND KPIS ROUTES

// ** 1. Get Overall Revenue for an Organizer ** //
app.get('/api/organizers/:organizerId/revenue', async (req, res) => {
  const { organizerId } = req.params;

  try {
    const eventsSnapshot = await db.collection('events').where('organizer.organizerId', '==', organizerId).get();

    if (eventsSnapshot.empty) {
      return handleError(res, 404, 'No events found for this organizer.');
    }

    const eventIds = eventsSnapshot.docs.map(doc => doc.id);

    const ticketsSnapshot = await db.collection('tickets').where('eventId', 'in', eventIds).get();

    const totalRevenue = ticketsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().totalPrice || 0), 0);

    handleSuccess(res, { totalRevenue });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving overall revenue for the organizer.');
  }
});

// ** 2. Get Overall Sold Tickets for an Organizer ** //
app.get('/api/organizers/:organizerId/sold-tickets', async (req, res) => {
  const { organizerId } = req.params;

  try {
    const eventsSnapshot = await db.collection('events').where('organizer.organizerId', '==', organizerId).get();

    if (eventsSnapshot.empty) {
      return handleError(res, 404, 'No events found for this organizer.');
    }

    const eventIds = eventsSnapshot.docs.map(doc => doc.id);

    const ticketsSnapshot = await db.collection('tickets').where('eventId', 'in', eventIds).where('status', '==', 'confirmed').get();

    const totalSoldTickets = ticketsSnapshot.size;

    handleSuccess(res, { totalSoldTickets });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving overall sold tickets for the organizer.');
  }
});

// ** 3. Get Overall Events for an Organizer ** //
app.get('/api/organizers/:organizerId/events', async (req, res) => {
  const { organizerId } = req.params;

  try {
    const eventsSnapshot = await db.collection('events').where('organizer.organizerId', '==', organizerId).get();

    const totalEvents = eventsSnapshot.size;

    handleSuccess(res, { totalEvents });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving overall events for the organizer.');
  }
});

// ** 4. Get Most Sold Ticket Type for an Organizer ** //
app.get('/api/organizers/:organizerId/best-ticket-type', async (req, res) => {
  const { organizerId } = req.params;

  try {
    const eventsSnapshot = await db.collection('events').where('organizer.organizerId', '==', organizerId).get();

    if (eventsSnapshot.empty) {
      return handleError(res, 404, 'No events found for this organizer.');
    }

    const eventIds = eventsSnapshot.docs.map(doc => doc.id);

    const ticketsSnapshot = await db.collection('tickets').where('eventId', 'in', eventIds).where('status', '==', 'confirmed').get();

    if (ticketsSnapshot.empty) {
      return handleError(res, 404, 'No sold tickets found for this organizer.');
    }

    const ticketTypeCount = ticketsSnapshot.docs.reduce((acc, doc) => {
      const ticketType = doc.data().ticketType;
      if (acc[ticketType]) {
        acc[ticketType] += doc.data().quantity || 0;
      } else {
        acc[ticketType] = doc.data().quantity || 0;
      }
      return acc;
    }, {});

    const bestTicketType = Object.keys(ticketTypeCount).reduce((a, b) => ticketTypeCount[a] > ticketTypeCount[b] ? a : b);

    handleSuccess(res, { bestTicketType, quantity: ticketTypeCount[bestTicketType] });
  } catch (e) {
    handleError(res, 500, 'An error occurred while retrieving the best ticket type for the organizer.');
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
