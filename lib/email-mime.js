import nodemailer from 'nodemailer';

/**
 * Compose Gmail API raw locally; Nodemailer handles UTF-8 headers, quoting,
 * transfer encodings and attachments. This transport never connects to SMTP.
 */
export async function buildGmailRaw({ from, to, subject, text, html, attachments }) {
  // ponytail: existing MIME composer → no hand-written RFC 2047/2822 encoding.
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const { message } = await transport.sendMail({
    from, to, subject, text, html, attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return message.toString('base64url');
}
