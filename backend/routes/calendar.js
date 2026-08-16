import express from 'express';

const router = express.Router();

// === MICROSOFT CALENDAR PROXY ===
// Frontend chiama questo endpoint, che fa da proxy per Microsoft Graph API
router.get('/microsoft-events', async (req, res) => {
  try {
    const { token, startDateTime, endDateTime } = req.query;

    // Validazione
    if (!token) {
      return res.status(400).json({ error: 'Microsoft access token required' });
    }
    if (!startDateTime || !endDateTime) {
      return res.status(400).json({ error: 'startDateTime and endDateTime required' });
    }

    console.log('[CALENDAR] Fetching Microsoft Calendar events...');
    console.log(`[CALENDAR] Token: ${token.slice(0, 20)}...`);
    console.log(`[CALENDAR] Range: ${startDateTime} to ${endDateTime}`);

    // === Chiama Microsoft Graph API ===
    const graphUrl = new URL('https://graph.microsoft.com/v1.0/me/calendarview');
    graphUrl.searchParams.set('startDateTime', startDateTime);
    graphUrl.searchParams.set('endDateTime', endDateTime);
    graphUrl.searchParams.set('$orderby', 'start/dateTime');

    const response = await fetch(graphUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CALENDAR] Microsoft API Error: ${response.status}`, errorText);

      // Se 401, il token è scaduto o invalido
      if (response.status === 401) {
        return res.status(401).json({ 
          error: 'Token scaduto o non valido',
          status: response.status 
        });
      }

      throw new Error(`Microsoft API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const events = data.value || [];

    console.log(`[CALENDAR] ✓ Fetched ${events.length} events from Microsoft Calendar`);

    // Ritorna gli eventi al frontend
    res.json({
      success: true,
      events: events,
      count: events.length
    });

  } catch (error) {
    console.error('❌ CALENDAR_ERROR:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch calendar events',
      message: error.message 
    });
  }
});

// === GOOGLE CALENDAR PROXY (opzionale, per coerenza) ===
router.get('/google-events', async (req, res) => {
  try {
    const { token, timeMin, timeMax } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Google access token required' });
    }
    if (!timeMin || !timeMax) {
      return res.status(400).json({ error: 'timeMin and timeMax required' });
    }

    console.log('[CALENDAR] Fetching Google Calendar events...');

    // === Chiama Google Calendar API ===
    const googleUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    googleUrl.searchParams.set('timeMin', timeMin);
    googleUrl.searchParams.set('timeMax', timeMax);
    googleUrl.searchParams.set('singleEvents', 'true');
    googleUrl.searchParams.set('orderBy', 'startTime');

    const response = await fetch(googleUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CALENDAR] Google API Error: ${response.status}`, errorText);

      if (response.status === 401) {
        return res.status(401).json({ 
          error: 'Token scaduto o non valido',
          status: response.status 
        });
      }

      throw new Error(`Google API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const events = data.items || [];

    console.log(`[CALENDAR] ✓ Fetched ${events.length} events from Google Calendar`);

    res.json({
      success: true,
      events: events,
      count: events.length
    });

  } catch (error) {
    console.error('❌ CALENDAR_ERROR:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch calendar events',
      message: error.message 
    });
  }
});

export default router;