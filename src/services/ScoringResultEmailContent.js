const { createHash } = require('node:crypto');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const { getTemplate } = require('./EmailTemplateService');

const TEST_EMAIL = 'renaldolouis555@gmail.com';
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const normalizeName = value => String(value || '').normalize('NFC').trim().toLowerCase();
const performerName = performer => String(performer?.fullName
    || `${performer?.firstName || ''} ${performer?.lastName || ''}`.trim()).trim();
const validEmail = value => typeof value === 'string' && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function validateKind(kind) {
    if (!['winner', 'nonQualifier'].includes(kind)) throw new AppError('Invalid result email type.', 400);
}

function validateDates(kind, dates) {
    if (kind !== 'winner') return;
    for (const field of ['confirmationDeadline', 'rundownReleaseDate']) {
        const value = dates?.[field];
        if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\[\]\r\n]/.test(value)) {
            throw new AppError('Enter the confirmation deadline and rundown release date without placeholders.', 400);
        }
    }
}

function decodePdf(attachment, expectedName) {
    if (!attachment || typeof attachment.filename !== 'string'
        || !/\.pdf$/i.test(attachment.filename) || /[/\\\x00-\x1f]/.test(attachment.filename)
        || attachment.filename.length > 240 || typeof attachment.base64 !== 'string'
        || attachment.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.base64)) {
        throw new AppError('Choose a PDF attachment of at most 4 MB.', 400);
    }
    if (expectedName && normalizeName(attachment.filename.slice(0, -4)) !== normalizeName(expectedName)) {
        throw new AppError('The PDF filename must exactly match this performer’s name.', 400);
    }
    const content = Buffer.from(attachment.base64, 'base64');
    if (content.length > MAX_PDF_BYTES || content.subarray(0, 5).toString() !== '%PDF-'
        || !content.subarray(-2048).toString().includes('%%EOF')) {
        throw new AppError('The attachment is not a valid PDF file.', 400);
    }
    return { filename: attachment.filename, content, contentType: 'application/pdf' };
}

function template(kind, recipient, dates) {
    validateKind(kind);
    validateDates(kind, dates);
    const subject = kind === 'winner'
        ? 'APCS Gala Concert 2026 – Performance Invitation'
        : 'APCS The Sound of Asia 2026 – Result Announcement';
    const eventDate = '14–15 November 2026';
    const venue = 'Titan Center';
    const address = 'Jln. Boulevard Bintaro, Block B7/B1 No.5, Bintaro Jaya, Sektor 7, Tangerang 15424, Indonesia';
    const galaName = 'APCS Gala Concert The Sound of Asia 2026';
    const whatsappNumber = '+62 822-1300-2686';
    const confirmationDeadline = kind === 'winner' ? dates.confirmationDeadline.trim() : '';
    const rundownReleaseDate = kind === 'winner' ? dates.rundownReleaseDate.trim() : '';
    const paragraphs = kind === 'winner' ? [
        `Dear ${recipient.name},`, 'Congratulations!',
        `You have been awarded as a ${recipient.award.toUpperCase()} WINNER and are officially invited to perform at the ${galaName}.`,
        `Date: ${eventDate}`, `Venue: ${venue}`, `Address: ${address}`,
        'Please carefully read the attached PDF, which contains all important event guidelines and performance information.',
        `Kindly confirm your attendance no later than ${confirmationDeadline}. After this deadline, no changes to the attendance confirmation or performer substitution will be permitted.`,
        `The final performance rundown will be shared on ${rundownReleaseDate}.`,
        `If you have any questions or require further assistance, please contact our admin team via WhatsApp at ${whatsappNumber}.`,
        'We look forward to welcoming you and celebrating your achievement at APCS The Sound of Asia 2026!',
        'Best regards,\nAPCS Team',
    ] : [
        `Dear ${recipient.name},`, 'Thank you for your participation in APCS The Sound of Asia 2026.',
        'We regret to inform you that your preliminary performance did not qualify for the APCS The Sound of Asia 2026 Gala Concert. However, we sincerely appreciate your hard work, dedication, and the passion you have shown throughout this competition. Each performance represents valuable progress in your musical journey, and we hope you take pride in your effort and growth.',
        'Please find your e-comment sheet attached.',
        'We encourage you to continue pursuing your musical goals with the same enthusiasm and commitment. You have done an excellent job, and we look forward to seeing you again at our future events.',
        'Best regards,\nAPCS Team',
    ];
    const paragraphHtml = (value, bold = []) => {
        let html = escapeHtml(value).replace(/\n/g, '<br>');
        for (const phrase of bold) {
            const escaped = escapeHtml(phrase);
            html = html.replace(escaped, `<strong>${escaped}</strong>`);
        }
        return `<p>${html}</p>`;
    };
    const linkedPhoneParagraph = () => {
        const boldPhone = `<strong>${escapeHtml(whatsappNumber)}</strong>`;
        return paragraphHtml(paragraphs[9], [whatsappNumber]).replace(boldPhone,
            `<a href="https://wa.me/6282213002686" style="color:#8a681f;text-decoration:underline">${boldPhone}</a>`);
    };
    const winnerContent = () => `
        ${paragraphHtml(paragraphs[0], [recipient.name])}
        ${paragraphHtml(paragraphs[1])}
        ${paragraphHtml(paragraphs[2], [`${recipient.award.toUpperCase()} WINNER`, galaName])}
        <div style="background-color:#fbf8f0;border:1px solid #e5d6b4;border-left:4px solid #c79b45;border-radius:6px;padding:20px 22px;margin:24px 0">
            <p style="color:#72561d;font-size:12px;font-weight:700;letter-spacing:1px;margin:0 0 12px">EVENT DETAILS</p>
            <p style="margin:0 0 12px"><strong>Date:</strong><br>${escapeHtml(eventDate)}</p>
            <p style="margin:0 0 12px"><strong>Venue:</strong><br>${escapeHtml(venue)}</p>
            <p style="margin:0"><strong>Address:</strong><br>${escapeHtml(address)}</p>
        </div>
        ${paragraphHtml(paragraphs[6], ['attached PDF'])}
        <div style="background-color:#f7f7f7;border:1px solid #dedede;border-radius:6px;padding:18px 22px;margin:22px 0">
            ${paragraphHtml(paragraphs[7], [`no later than ${confirmationDeadline}`, 'no changes to the attendance confirmation or performer substitution will be permitted'])}
            ${paragraphHtml(paragraphs[8], ['final performance rundown', rundownReleaseDate])}
        </div>
        ${linkedPhoneParagraph()}
        ${paragraphHtml(paragraphs[10], ['APCS The Sound of Asia 2026'])}
        ${paragraphHtml(paragraphs[11], ['APCS Team'])}`;
    const nonQualifierContent = () => `
        ${paragraphHtml(paragraphs[0], [recipient.name])}
        ${paragraphs.slice(1, 3).map(paragraph => paragraphHtml(paragraph)).join('')}
        <div style="background-color:#f7f7f7;border:1px solid #dedede;border-left:4px solid #c79b45;border-radius:6px;padding:18px 22px;margin:22px 0">
            <p style="font-weight:700;margin:0 0 6px">Your e-comment sheet</p>
            <p style="margin:0">${escapeHtml(paragraphs[3])}</p>
        </div>
        ${paragraphHtml(paragraphs[4])}
        ${paragraphHtml(paragraphs[5], ['APCS Team'])}`;
    return {
        subject, text: paragraphs.join('\n\n'),
        html: getTemplate('brandedMessage', {
            title: escapeHtml(subject),
            content: kind === 'winner' ? winnerContent() : nonQualifierContent(),
        }),
    };
}

// A real, deliberately fictional one-page PDF. No registrant information is read for tests.
function dummyPdf(kind) {
    const label = kind === 'winner' ? 'DUMMY APCS winner guidelines - TEST ONLY'
        : 'DUMMY jury comment sheet for Alex Example - TEST ONLY';
    const stream = `BT /F1 14 Tf 45 760 Td (${label}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let source = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(source.length);
        source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = source.length;
    source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
        + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return { filename: 'APCS_DUMMY_TEST_ONLY.pdf', content: Buffer.from(source), contentType: 'application/pdf' };
}

module.exports = { TEST_EMAIL, MAX_PDF_BYTES, normalizeName, performerName, validEmail, hash,
    validateKind, validateDates, decodePdf, template, dummyPdf };
