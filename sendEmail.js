const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendFluctuationEmail(to, vegetablesWithSignificantFluctuation, date) {
  const html = `
    <h2>📈 Your selected vegetables had significant price fluctuation - ${date}</h2>
    <ul>
      ${vegetablesWithSignificantFluctuation.map(veg =>
    `<li><strong>${veg.commodity}</strong>: Rs. ${veg.average} 
        (${veg.fluctuationPercentage > 0 ? '+' : ''}${veg.fluctuationPercentage}%)</li>`
  ).join('')}
    </ul>
  `;

  const msg = {
    to,
    from: 'sagar.mainali@pegasusinctech.com.np', // sender email verified in SendGrid
    subject: `🔔 Kalimati Vegetables Price Fluctuation Alert - ${date}`,
    html,
  };

  return sgMail.send(msg);
}

module.exports = { sendFluctuationEmail };
