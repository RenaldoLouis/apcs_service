const { createHash } = require('node:crypto');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

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
    const paragraphs = kind === 'winner' ? [
        `Dear ${recipient.name},`, 'Congratulations!',
        `You have been awarded as a ${recipient.award.toUpperCase()} WINNER and are invited to perform at the APCS Gala Concert The Sound of Asia 2026.`,
        'Date: 14–15 November 2026', 'Venue: Titan Center',
        'Address: Jln. Boulevard Bintaro, Block B7/B1 No.5, Bintaro Jaya, Sektor 7, Tangerang 15424, Indonesia',
        'Please read the attached PDF carefully, as it contains all important event guidelines and performance information.',
        `Kindly confirm your attendance by ${dates.confirmationDeadline.trim()}. After the deadline, no changes or performer substitutions can be made.`,
        `The final performance rundown will be shared on ${dates.rundownReleaseDate.trim()}.`,
        'If you have any questions, feel free to contact our admin via WhatsApp.',
        'We look forward to seeing you at APCS The Sound of Asia 2026!', 'Best regards,\nAPCS Team',
    ] : [
        `Dear ${recipient.name},`, 'Thank you for your participation in APCS The Sound of Asia 2026.',
        'We regret to inform you that your preliminary performance did not qualify for the APCS The Sound of Asia 2026 Gala Concert. However, we sincerely appreciate your hard work, dedication, and the passion you have shown throughout this competition. Each performance represents valuable progress in your musical journey, and we hope you take pride in your effort and growth.',
        'Please find your e-comment sheet attached.',
        'We encourage you to continue pursuing your musical goals with the same enthusiasm and commitment. You have done an excellent job, and we look forward to seeing you again at our future events.',
        'Best regards,\nAPCS Team',
    ];
    return {
        subject, text: paragraphs.join('\n\n'),
        html: '<div style="font-family:Arial,sans-serif;line-height:1.7;color:#222;max-width:680px">'
            + paragraphs.map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('') + '</div>',
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
