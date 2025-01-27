
const db = require('../repositories/PaymentRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');
const nodemailer = require("nodemailer");
const Queue = require('bull');
const { logger } = require('../utils/Logger');

const defaultJobOptions = {
    removeOnComplete: true,
    removeOnFail: false
};

const redisConfig = {
    redis: {
        path: '/home/apcc8119/tmp/redis.sock'
    }
};

/* DONT FORGET TO REVERT THE CONFIG */
// for local dev only 
// const redisConfig = {
//     redis: {
//         host: "127.0.0.1",
//         port: 6379
//     }
// };

const emailQueue = new Queue('emailQueue', redisConfig, { defaultJobOptions });

const transporter = nodemailer.createTransport({
    service: "Gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: "renaldolouis555@gmail.com",
        pass: "obim loxb nwll dukt",
    },
});

const sendNewEmail = async (email) => {
    logger.info(`sending email To...${email}`);
    emailQueue.add({ ...email });
};

const processEmailQueue = async (job) => {
    try {
        const { data } = job; // Extract the data object from the job
        const to = Object.values(data).join(''); // Reconstruct the email address
        const mailOptions = {
            from: "renaldolouis555@gmail.com",
            to: to,
            subject: "Hello from APCS",
            html: `<!DOCTYPE html>
            <html xmlns:v="
            urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">

            <head>
                <title></title>
                <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0"><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><!--[if !mso]><!-->
                <link href="https://fonts.googleapis.com/css?family=Open+Sans" rel="stylesheet" type="text/css"><!--<![endif]-->
                <style>
                    * {
                        box-sizing: border-box;
                    }

                    body {
                        margin: 0;
                        padding: 0;
                    }

                    a[x-apple-data-detectors] {
                        color: inherit !important;
                        text-decoration: inherit !important;
                    }

                    #MessageViewBody a {
                        color: inherit;
                        text-decoration: none;
                    }

                    p {
                        line-height: inherit
                    }

                    .desktop_hide,
                    .desktop_hide table {
                        mso-hide: all;
                        display: none;
                        max-height: 0px;
                        overflow: hidden;
                    }

                    .image_block img+div {
                        display: none;
                    }

                    sup,
                    sub {
                        font-size: 75%;
                        line-height: 0;
                    }

                    .menu_block.desktop_hide .menu-links span {
                        mso-hide: all;
                    }

                    @media (max-width:700px) {

                        .desktop_hide table.icons-inner,
                        .social_block.desktop_hide .social-table {
                            display: inline-block !important;
                        }

                        .icons-inner {
                            text-align: center;
                        }

                        .icons-inner td {
                            margin: 0 auto;
                        }

                        .mobile_hide {
                            display: none;
                        }

                        .row-content {
                            width: 100% !important;
                        }

                        .stack .column {
                            width: 100%;
                            display: block;
                        }

                        .mobile_hide {
                            min-height: 0;
                            max-height: 0;
                            max-width: 0;
                            overflow: hidden;
                            font-size: 0px;
                        }

                        .desktop_hide,
                        .desktop_hide table {
                            display: table !important;
                            max-height: none !important;
                        }

                        .reverse {
                            display: table;
                            width: 100%;
                        }

                        .reverse .column.first {
                            display: table-footer-group !important;
                        }

                        .reverse .column.last {
                            display: table-header-group !important;
                        }

                        .row-5 td.column.first .border {
                            padding: 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }

                        .row-5 td.column.last .border {
                            padding: 25px 0 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }
                    }
                </style><!--[if mso ]><style>sup, sub { font-size: 100% !important; } sup { mso-text-raise:10% } sub { mso-text-raise:-10% }</style> <![endif]-->
            </head>

            <body class="body" style="background-color: #fbfcfc; margin: 0; padding: 0; -webkit-text-size-adjust: none; text-size-adjust: none;">
                <table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fbfcfc;">
                    <tbody>
                        <tr>
                            <td>
                                <table class="row row-1" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 20px; padding-left: 10px; padding-right: 10px; padding-top: 20px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="width:100%;">
                                                                            <div class="alignment" align="center" style="line-height:10px">
                                                                                <div style="max-width: 206.667px;"><img src="https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Your-Logo-01.png" style="display: block; height: auto; border: 0; width: 100%;" width="206.667" alt="Alternate text" title="Alternate text" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-2" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-left: 15px; padding-right: 15px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="empty_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div></div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-3" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 20px; padding-left: 5px; padding-right: 5px; padding-top: 20px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="menu_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="color:#000000;font-family:inherit;font-size:13px;text-align:center;">
                                                                            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                                <tr>
                                                                                    <td class="alignment" style="text-align:center;font-size:0px;">
                                                                                        <div class="menu-links"><!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style=""><tr style="text-align:center;"><![endif]--><!--[if mso]><td style="padding-top:5px;padding-right:5px;padding-bottom:5px;padding-left:20px"><![endif]--><a href="http://www.example.com" target="_self" style="mso-hide:false;padding-top:5px;padding-bottom:5px;padding-left:20px;padding-right:5px;display:inline-block;color:#2c434a;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:13px;text-decoration:none;letter-spacing:normal;">About</a><!--[if mso]></td><![endif]--><!--[if mso]><td style="padding-top:5px;padding-right:5px;padding-bottom:5px;padding-left:20px"><![endif]--><a href="http://www.example.com" target="_self" style="mso-hide:false;padding-top:5px;padding-bottom:5px;padding-left:20px;padding-right:5px;display:inline-block;color:#2c434a;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:13px;text-decoration:none;letter-spacing:normal;">Blog</a><!--[if mso]></td><![endif]--><!--[if mso]><td style="padding-top:5px;padding-right:5px;padding-bottom:5px;padding-left:20px"><![endif]--><a href="http://www.example.com" target="_self" style="mso-hide:false;padding-top:5px;padding-bottom:5px;padding-left:20px;padding-right:5px;display:inline-block;color:#2c434a;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:13px;text-decoration:none;letter-spacing:normal;">Contact</a><!--[if mso]></td><![endif]--><!--[if mso]></tr></table><![endif]--></div>
                                                                                    </td>
                                                                                </tr>
                                                                            </table>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-2" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; color: #000000; background-image: url('https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Hero-Background.png'); background-position: center top; background-repeat: no-repeat; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 35px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="text_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:10px;padding-right:10px;">
                                                                            <div style="font-family: Georgia, 'Times New Roman', serif">
                                                                                <div class style="font-size: 12px; font-family: Georgia, Times, 'Times New Roman', serif; mso-line-height-alt: 14.399999999999999px; color: #ffffff; line-height: 1.2;">
                                                                                    <p style="margin: 0; font-size: 14px; text-align: center; mso-line-height-alt: 16.8px;"><span style="word-break: break-word; font-size: 150px;"><strong><span style="word-break: break-word;"><span style="word-break: break-word; font-size: 50px;">THE</span><span style="word-break: break-word; font-size: 140px;">BEA</span></span></strong></span><span style="word-break: break-word; font-size: 150px;"><span style="word-break: break-word;">&nbsp;</span></span></p>
                                                                                </div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="text_block block-2" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:10px;padding-right:10px;">
                                                                            <div style="font-family: Georgia, 'Times New Roman', serif">
                                                                                <div class style="font-size: 12px; font-family: Georgia, Times, 'Times New Roman', serif; mso-line-height-alt: 14.399999999999999px; color: #ffffff; line-height: 1.2;">
                                                                                    <p style="margin: 0; font-size: 14px; text-align: center; mso-line-height-alt: 16.8px;"><span style="word-break: break-word; font-size: 150px;"><strong><span style="word-break: break-word;"><span style="word-break: break-word; font-size: 140px;">U</span></span></strong></span><span style="word-break: break-word; font-size: 150px;"><strong><span style="word-break: break-word;"><span style="word-break: break-word; font-size: 140px;">TY</span><span style="word-break: break-word; font-size: 50px;">IS INSIDE</span></span></strong></span></p>
                                                                                </div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-3" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 30px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="button_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="center"><a href="http://www.example.com" target="_blank" style="color:#ffffff;"><!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"  href="http://www.example.com"  style="height:38px;width:136px;v-text-anchor:middle;" arcsize="0%" fillcolor="#2c434a">
            <v:stroke dashstyle="Solid" weight="0px" color="#8a3b8f"/>
            <w:anchorlock/>
            <v:textbox inset="0px,0px,0px,0px">
            <center dir="false" style="color:#ffffff;font-family:sans-serif;font-size:14px">
            <![endif]-->
                                                                                    <div style="background-color:#2c434a;border-bottom:0px solid #8a3b8f;border-left:0px solid #8a3b8f;border-radius:0px;border-right:0px solid #8a3b8f;border-top:0px solid #8a3b8f;color:#ffffff;display:inline-block;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;font-weight:undefined;mso-border-alt:none;padding-bottom:5px;padding-top:5px;text-align:center;text-decoration:none;width:auto;word-break:keep-all;"><span style="word-break: break-word; padding-left: 40px; padding-right: 40px; font-size: 14px; display: inline-block; letter-spacing: normal;"><span style="word-break: break-word;"><span style="word-break: break-word; line-height: 25.2px;" data-mce-style>Discover</span></span></span></div><!--[if mso]></center></v:textbox></v:roundrect><![endif]-->
                                                                                </a></div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-4" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; background-color: #f2f1eb; padding-left: 20px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Find Your Space</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="divider_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="left">
                                                                                <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="30%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                                    <tr>
                                                                                        <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 3px solid #BBBBBB;"><span style="word-break: break-word;">&#8202;</span></td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:left;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><em>John Doe - Architect</em></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-2" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; background-color: #f2f1eb; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="width:100%;">
                                                                            <div class="alignment" align="right" style="line-height:10px">
                                                                                <div style="max-width: 295px;"><img src="https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Pic-Bedroom.png" style="display: block; height: auto; border: 0; width: 100%;" width="295" alt="Bedroom" title="Bedroom" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-5" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; background-repeat: no-repeat; color: #000000; background-image: url('https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Mid-Background.png'); width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr class="reverse">
                                                            <td class="column column-1 first" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <div class="border">
                                                                    <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                        <tr>
                                                                            <td class="pad" style="width:100%;">
                                                                                <div class="alignment" align="left" style="line-height:10px">
                                                                                    <div style="max-width: 286px;"><img src="https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Pic-livingroom.png" style="display: block; height: auto; border: 0; width: 100%;" width="286" alt="Livingroom" title="Livingroom" height="auto"></div>
                                                                                </div>
                                                                            </td>
                                                                        </tr>
                                                                    </table>
                                                                </div>
                                                            </td>
                                                            <td class="column column-2 last" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-top: 25px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <div class="border">
                                                                    <table class="paragraph_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                        <tr>
                                                                            <td class="pad" style="padding-bottom:10px;padding-left:45px;padding-right:10px;padding-top:10px;">
                                                                                <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:16px;line-height:150%;text-align:left;mso-line-height-alt:24px;">
                                                                                    <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque felis leo, accumsan vel quam fringilla, fringilla finibus purus. </span></p>
                                                                                    <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Orci varius natoque penatibus et magnis dis parturient montes.</span></p>
                                                                                </div>
                                                                            </td>
                                                                        </tr>
                                                                    </table>
                                                                    <table class="button_block block-2" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                        <tr>
                                                                            <td class="pad" style="padding-bottom:30px;padding-left:10px;padding-right:10px;padding-top:30px;text-align:center;">
                                                                                <div class="alignment" align="center"><a href="http://www.example.com" target="_blank" style="color:#ffffff;"><!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"  href="http://www.example.com"  style="height:38px;width:151px;v-text-anchor:middle;" arcsize="0%" fillcolor="#2c434a">
            <v:stroke dashstyle="Solid" weight="0px" color="#8a3b8f"/>
            <w:anchorlock/>
            <v:textbox inset="0px,0px,0px,0px">
            <center dir="false" style="color:#ffffff;font-family:sans-serif;font-size:14px">
            <![endif]-->
                                                                                        <div style="background-color:#2c434a;border-bottom:0px solid #8a3b8f;border-left:0px solid #8a3b8f;border-radius:0px;border-right:0px solid #8a3b8f;border-top:0px solid #8a3b8f;color:#ffffff;display:inline-block;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;font-weight:undefined;mso-border-alt:none;padding-bottom:5px;padding-top:5px;text-align:center;text-decoration:none;width:auto;word-break:keep-all;"><span style="word-break: break-word; padding-left: 40px; padding-right: 40px; font-size: 14px; display: inline-block; letter-spacing: normal;"><span style="word-break: break-word;"><span style="word-break: break-word; line-height: 25.2px;" data-mce-style>Read more</span></span></span></div><!--[if mso]></center></v:textbox></v:roundrect><![endif]-->
                                                                                    </a></div>
                                                                            </td>
                                                                        </tr>
                                                                    </table>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-6" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; background-repeat: no-repeat; color: #000000; background-image: url('https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Section-2-Background.png'); background-position: center top; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 50px; padding-top: 25px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:10px;padding-right:10px;">
                                                                            <div style="color:#ffffff;font-family:Georgia,Times,'Times New Roman',serif;font-size:140px;line-height:120%;text-align:left;mso-line-height-alt:168px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><strong><span style="word-break: break-word;">IN</span></strong></span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><strong><span style="word-break: break-word;">SIDE</span></strong></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-7" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-left: 20px; padding-right: 10px; padding-top: 15px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Inside The Light</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="divider_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="left">
                                                                                <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="30%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                                    <tr>
                                                                                        <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 3px solid #BBBBBB;"><span style="word-break: break-word;">&#8202;</span></td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:left;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><em>John Doe - Architect</em></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-4" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:16px;line-height:150%;text-align:left;mso-line-height-alt:24px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Lorem ipsum dolor sit amet, consectetur adipiscing elit pellentesque felis leo, accumsan vel quam fringilla, fringilla finibus purus.</span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Orci varius natoque penatibus et magnis dis parturient varius natoque.</span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Varius natoque elit pellente penatibus.</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-8" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #e7e2cf; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 30px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="button_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="center"><a href="http://www.example.com" target="_blank" style="color:#ffffff;"><!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"  href="http://www.example.com"  style="height:38px;width:151px;v-text-anchor:middle;" arcsize="0%" fillcolor="#2c434a">
            <v:stroke dashstyle="Solid" weight="0px" color="#8a3b8f"/>
            <w:anchorlock/>
            <v:textbox inset="0px,0px,0px,0px">
            <center dir="false" style="color:#ffffff;font-family:sans-serif;font-size:14px">
            <![endif]-->
                                                                                    <div style="background-color:#2c434a;border-bottom:0px solid #8a3b8f;border-left:0px solid #8a3b8f;border-radius:0px;border-right:0px solid #8a3b8f;border-top:0px solid #8a3b8f;color:#ffffff;display:inline-block;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;font-weight:undefined;mso-border-alt:none;padding-bottom:5px;padding-top:5px;text-align:center;text-decoration:none;width:auto;word-break:keep-all;"><span style="word-break: break-word; padding-left: 40px; padding-right: 40px; font-size: 14px; display: inline-block; letter-spacing: normal;"><span style="word-break: break-word;"><span style="word-break: break-word; line-height: 25.2px;" data-mce-style>Read more</span></span></span></div><!--[if mso]></center></v:textbox></v:roundrect><![endif]-->
                                                                                </a></div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-9" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #2c434a; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 10px; padding-left: 20px; padding-right: 20px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:30px;padding-right:30px;padding-top:10px;width:100%;">
                                                                            <div class="alignment" align="center" style="line-height:10px">
                                                                                <div style="max-width: 126.667px;"><img src="https://d1oco4z2z1fhwp.cloudfront.net/templates/default/2286/Your-Logo-White.png" style="display: block; height: auto; border: 0; width: 100%;" width="126.667" alt="Giving Tuesday Logo" title="Giving Tuesday Logo" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="social_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="center">
                                                                                <table class="social-table" width="108px" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block;">
                                                                                    <tr>
                                                                                        <td style="padding:0 2px 0 2px;"><a href="https://www.facebook.com" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/facebook@2x.png" width="32" height="auto" alt="Facebook" title="facebook" style="display: block; height: auto; border: 0;"></a></td>
                                                                                        <td style="padding:0 2px 0 2px;"><a href="https://www.twitter.com" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/twitter@2x.png" width="32" height="auto" alt="Twitter" title="twitter" style="display: block; height: auto; border: 0;"></a></td>
                                                                                        <td style="padding:0 2px 0 2px;"><a href="https://www.instagram.com" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/instagram@2x.png" width="32" height="auto" alt="Instagram" title="instagram" style="display: block; height: auto; border: 0;"></a></td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-2" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 10px; padding-left: 10px; padding-right: 10px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#ffffff;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:120%;text-align:center;mso-line-height-alt:16.8px;">
                                                                                <p style="margin: 0; word-break: break-word;"><strong><span style="word-break: break-word;">About Us</span></strong></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:center;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">Lorem ipsum dolor sit amet, consectetur adipiscing. </span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">Aenean eget scelerisque magna. Cras interdum do mattis ligula&nbsp; eten eugravid.&nbsp;</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-3" width="33.333333333333336%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 30px; padding-left: 10px; padding-right: 10px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#ffffff;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:120%;text-align:center;mso-line-height-alt:16.8px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><strong><span style="word-break: break-word;">Contact Us</span></strong></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:center;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">Your Street 12, 34567 AB CIity</span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">info@example.com </span></p>
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">(+1) 123 456 789</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-10" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #2c434a; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#436570;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:center;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">2020 © All Rights Reserved</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#436570;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;text-align:center;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><a href="http://www.example.com" target="_blank" rel="noopener" style="color: #436570;">Unsubscribe</a> | <a href="http://www.example.com" target="_blank" rel="noopener" style="color: #436570;">Manage Preferences</a></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-11" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #ffffff;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #ffffff; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="icons_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: center; line-height: 0;">
                                                                    <tr>
                                                                        <td class="pad" style="vertical-align: middle; color: #1e0e4b; font-family: 'Inter', sans-serif; font-size: 15px; padding-bottom: 5px; padding-top: 5px; text-align: center;"><!--[if vml]><table align="center" cellpadding="0" cellspacing="0" role="presentation" style="display:inline-block;padding-left:0px;padding-right:0px;mso-table-lspace: 0pt;mso-table-rspace: 0pt;"><![endif]-->
                                                                            <!--[if !vml]><!-->
                                                                            <table class="icons-inner" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block; padding-left: 0px; padding-right: 0px;" cellpadding="0" cellspacing="0" role="presentation"><!--<![endif]-->
                                                                                <tr>
                                                                                    <td style="vertical-align: middle; text-align: center; padding-top: 5px; padding-bottom: 5px; padding-left: 5px; padding-right: 6px;"><a href="http://designedwithbeefree.com/" target="_blank" style="text-decoration: none;"><img class="icon" alt="Beefree Logo" src="https://d1oco4z2z1fhwp.cloudfront.net/assets/Beefree-logo.png" height="auto" width="34" align="center" style="display: block; height: auto; margin: 0 auto; border: 0;"></a></td>
                                                                                    <td style="font-family: 'Inter', sans-serif; font-size: 15px; font-weight: undefined; color: #1e0e4b; vertical-align: middle; letter-spacing: undefined; text-align: center; line-height: normal;"><a href="http://designedwithbeefree.com/" target="_blank" style="color: #1e0e4b; text-decoration: none;">Designed with Beefree</a></td>
                                                                                </tr>
                                                                            </table>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                    </tbody>
                </table><!-- End -->
            </body>

            </html>`,
        };
        const result = await new Promise((resolve, reject) => {
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(info);
                }
            });
        });

        logger.info(`Successfully sent email to ${to}`);
        console.log(`Message sent to ${to}`);
        console.log("Message sent: %s", result.messageId);
        console.log("Preview URL: %s", nodemailer.getTestMessageUrl(result));
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

emailQueue.process(3, processEmailQueue);

async function sendEmail(req) {
    const body = req.body;

    for (const data of body) {
        await sendNewEmail(data.email); // Wait for each email to be added to the queue
    }

    try {
        const result = { message: "Emails sent successfully" };
        return result;
    } catch (error) {
        logger.error(`Failed to send email: ${error.message}`);
        throw error;
    }
}

module.exports = {
    sendEmail
};