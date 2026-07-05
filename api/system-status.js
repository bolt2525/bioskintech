
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  const { type } = req.query;
  const logs = [];

  const addLog = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  try {
    if (type === 'calendar') {
      addLog('Iniciando prueba de conexión con Google Calendar...');
      
      const credentialsBase64 = process.env.GOOGLE_CREDENTIALS_BASE64;
      if (!credentialsBase64) {
        throw new Error('GOOGLE_CREDENTIALS_BASE64 no está definida en variables de entorno');
      }

      addLog('Decodificando credenciales...');
      const credentials = JSON.parse(
        Buffer.from(credentialsBase64, 'base64').toString('utf8')
      );

      const { client_email, private_key } = credentials;
      addLog(`Credenciales cargadas para: ${client_email}`);

      const jwtClient = new google.auth.JWT(
        client_email,
        null,
        private_key,
        ['https://www.googleapis.com/auth/calendar']
      );

      addLog('Autenticando con Google...');
      await jwtClient.authorize();
      addLog('Autenticación exitosa.');

      const calendar = google.calendar({ version: 'v3', auth: jwtClient });
      
      addLog('Listando calendarios...');
      const response = await calendar.calendarList.list({ maxResults: 1 });
      
      if (response.data.items) {
          addLog(`Acceso correcto. Calendarios encontrados: ${response.data.items.length}`);
      } else {
          addLog('Acceso correcto, pero no se encontraron calendarios.');
      }

      return res.status(200).json({ success: true, logs });

    } else if (type === 'email') {
      addLog('Iniciando prueba de conexión SMTP (Email)...');
      
      const host = process.env.EMAIL_HOST;
      const port = process.env.EMAIL_PORT;
      const user = process.env.EMAIL_USER;
      // No loguear password

      if (!host || !port || !user) {
        throw new Error('Faltan variables de entorno de Email (HOST, PORT, USER)');
      }

      addLog(`Configurando transporte SMTP: ${host}:${port} (${user})`);

      const transporter = nodemailer.createTransport({
        host: host,
        port: parseInt(port),
        secure: parseInt(port) === 465, // true for 465, false for other ports
        auth: {
          user: user,
          pass: process.env.EMAIL_PASS,
        },
      });

      addLog('Verificando conexión SMTP...');
      await transporter.verify();
      addLog('Conexión SMTP verificada correctamente.');

      return res.status(200).json({ success: true, logs });

    } else {
      return res.status(400).json({ success: false, message: 'Tipo de prueba no válido (calendar/email)' });
    }

  } catch (error) {
    addLog(`ERROR: ${error.message}`);
    // Si es error de credenciales google
    if (error.response && error.response.data) {
        addLog(`Detalle API Google: ${JSON.stringify(error.response.data)}`);
    }
    
    return res.status(500).json({ 
      success: false, 
      message: error.message, 
      logs,
      code: error.code, // Para detectar EAUTH
      response: error.response // Para detectar respuestas de servidor SMTP
    });
  }
}
