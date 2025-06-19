# 🥦 Nepali Market Daily Vegetables Price Monitor

This Node.js project automates the daily monitoring, scraping, storing, and sending email notification of vegetable prices from the official [Kalimatimarket.gov.np](https://kalimatimarket.gov.np/) website. It tracks price fluctuations and alerts users via email when their selected vegetables experience significant price changes.

## 📌 Features

- ✅ Daily automated scraping of vegetable prices
- 📊 Tracks average, minimum, and maximum prices
- 🔁 Compares prices with the previous day
- 🚨 Detects significant fluctuations (±15% change)
- ☁️ Stores structured data in MongoDB Atlas with upsert logic
- 📬 Sends email alerts to subscribed users based on selected vegetables


## ⚙️📦 Technologies & Packages Used

| Package                            | Purpose                                                       |
|------------------------------------|---------------------------------------------------------------|
| [`puppeteer`](https://www.npmjs.com/package/puppeteer)       | Headless browser to scrape dynamic web content                |
| [`dotenv`](https://www.npmjs.com/package/dotenv)             | Load environment variables from `.env` file                   |
| [`mongodb`](https://www.npmjs.com/package/mongodb)           | MongoDB driver for storing and querying data                  |
| [`@sendgrid/mail`](https://www.npmjs.com/package/@sendgrid/mail) | Used in `sendEmail.js` to send HTML email alerts via SendGrid |


## 🛠️ How It Works

1. **Scraping**  
   Visits the Kalimati Market website and extracts vegetable price data for each selected date.

2. **Date Range Handling**  
   Starts from `2025-01-01` or the day after the most recently stored date in the database.

3. **Token Handling**  
   Retrieves the CSRF token dynamically to submit the form and load pricing data.

4. **Price Comparison**  
   Compares the current day's average prices with the previous day's for each vegetable.

5. **Detecting Fluctuations**  
   Marks a vegetable as **significantly fluctuated** if its average price changes by ±15% or more.

6. **Data Storage**  
   Stores the structured data in MongoDB using an *upsert* operation to avoid duplicates.

7. **User Notification**  
   Sends email alerts to users if their selected vegetables show significant price changes.


## 📨 Email Notifications

Email alerts are triggered only when:

- A vegetable's **average price changes by ±15% or more**
- AND the vegetable is on the user's **notification list** at the time of registration

## 🤝 Contributing
Contributions are welcome! If you'd like to improve scraping logic, add features, or refactor, feel free to fork and submit a pull request.

## 📬 Contact
For issues or feature requests, please use the GitHub Issues section.