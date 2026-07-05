import { google } from 'googleapis';

export class GoogleCalendarService {
  constructor() {
    this.calendar = null;
    this.calendarId = null;
    this.init();
  }

  init() {
    try {
      const credentialsBase64 = process.env.GOOGLE_CREDENTIALS_BASE64;
      if (!credentialsBase64) {
        console.error('❌ GOOGLE_CREDENTIALS_BASE64 no encontrada');
        return;
      }

      const credentials = JSON.parse(
        Buffer.from(credentialsBase64, 'base64').toString('utf8')
      );

      this.calendarId = credentials.calendar_id;

      const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      this.calendar = google.calendar({ version: 'v3', auth });
    } catch (error) {
      console.error('Error inicializando Google Calendar Service:', error);
    }
  }

  async listEvents(timeMin, timeMax, maxResults = 10) {
    if (!this.calendar) {
      throw new Error('Calendar service not initialized');
    }

    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax ? timeMax.toISOString() : undefined,
        maxResults: maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return response.data.items;
    } catch (error) {
      console.error('Error listing events:', error);
      throw error;
    }
  }

  async getUpcomingEvents(hours = 24) {
    const now = new Date();
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return this.listEvents(now, end);
  }

  async deleteEvent(eventId) {
    if (!this.calendar) {
      throw new Error('Calendar service not initialized');
    }
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId: eventId,
      });
      console.log(`✅ Evento eliminado: ${eventId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error eliminando evento ${eventId}:`, error);
      throw error;
    }
  }
}

export const googleCalendarService = new GoogleCalendarService();
