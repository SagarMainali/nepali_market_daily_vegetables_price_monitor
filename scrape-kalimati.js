require('dotenv').config();
const { MongoClient } = require('mongodb');
const puppeteer = require('puppeteer');
const { sendFluctuationEmail } = require('./sendEmail');

// MongoDB Atlas connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

const formatDate = (date) => date.toISOString().split('T')[0]; // YYYY-MM-DD

// required selectors
const tokenInputSelector = '#csrf'
const dateInput_Selector = '#datePricing';
const formElementSelector = '#queryFormDues';
const dataTable_Selector = '#commodityPriceParticular';
const tableRow_Selector = `${dataTable_Selector} tbody tr`;


(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    await client.connect();
    const db = client.db();
    const vegetablesCollection = db.collection('daily_prices');
    await vegetablesCollection.createIndex({ date: 1 }, { unique: true });

    const usersCollection = db.collection('user_data');
    const users = await usersCollection.find().toArray();

    // get the data of latest saved date 
    const latestDoc = await vegetablesCollection
        .find({})
        .sort({ date: -1 })
        .limit(1)
        .toArray();

    let startDate = new Date('2025-01-01');

    // this will be used to store the previousDate data and referenced later to compare prices with current date data
    let lastKnownVegetablesMap = new Map();

    // modify startDate and previousDateVegetables accordingly if database is not empty
    if (latestDoc.length > 0) {
        const lastDate = new Date(latestDoc[0].date);
        lastDate.setDate(lastDate.getDate() + 1); // lastDate.setDate returns number
        startDate = lastDate; //lastDate is modified object from above line

        const latestVegetables = latestDoc[0].vegetablesData;
        for (const veg of latestVegetables) {
            lastKnownVegetablesMap.set(veg.commodity, veg);
        }
    }

    // initialize end date as of today
    const endDate = new Date();

    console.log(`Date range: ${formatDate(startDate)} to ${formatDate(endDate)}\n`);

    // increase the date, search the data of that particular date, extract it and save it in a separate document in mongodb
    for (let d = new Date(startDate.getTime()); d <= endDate; d.setDate(d.getDate() + 1)) {
        const currentDate = new Date(d.getTime());
        const dateStr = formatDate(currentDate);

        // hit this url to go to homepage and set the default language for the session to english
        await page.goto('https://kalimatimarket.gov.np/lang/en', {
            waitUntil: 'domcontentloaded',
        });

        // afterwards visit the designated url to load the site in preferred language
        await page.goto('https://kalimatimarket.gov.np/price', {
            // waitUntil: 'networkidle2',
            waitUntil: 'domcontentloaded',
        });

        console.log(`Selected Date: ${dateStr}`)

        // wait for input with token to laod first
        await page.waitForSelector(tokenInputSelector);

        // get the CSRF token value first before submitting the form, this token must be used to submit the form
        const csrfToken = await page.evaluate((tokenInputSelector) => {
            const csrfInput = document.querySelector(tokenInputSelector);
            return csrfInput ? csrfInput.value : null;
        }, tokenInputSelector);

        if (!csrfToken) {
            console.error('Could not find CSRF token!');
            continue;
        }

        console.log(`Found CSRF token: ${csrfToken.substring(0, 10)}...`);

        // clear and set the date value
        await page.evaluate((dateInput_Selector, dateVal) => {
            const input = document.querySelector(dateInput_Selector);
            input.value = '';
            input.value = dateVal;

            // trigger change events to ensure the form recognizes the new value
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, dateInput_Selector, dateStr);

        // submit the form programmatically with the CSRF token
        await page.evaluate((dateInput_Selector, formElementSelector, tokenInputSelector, dateStr, csrfToken) => {
            const form = document.querySelector(formElementSelector);
            const dateInput = document.querySelector(dateInput_Selector);
            const csrfInput = document.querySelector(tokenInputSelector);

            // ensure all values are set correctly
            dateInput.value = dateStr;
            csrfInput.value = csrfToken;

            // submit the form
            form.submit();
        }, dateInput_Selector, formElementSelector, tokenInputSelector, dateStr, csrfToken);

        try {
            await page.waitForSelector(tableRow_Selector, { timeout: 10000 });
        } catch (error) {
            console.warn('⚠️  No data table found!\n');
            continue; // Skip to next date
        }

        // check if there are actually rows with data
        const rowCount = await page.evaluate((tableRow_Selector) => {
            return document.querySelectorAll(tableRow_Selector).length;
        }, tableRow_Selector);

        // when there is no data available in the site for that particular date, the site still shows table
        // but with a single row that says 'No data available in the table'
        if (rowCount <= 1) {
            console.warn('⚠️  Table has no data!\n');
            continue;
        }

        console.log('Scraping data from the data table...');

        // extract data of that particular date
        const dataOfOneDay = await page.evaluate((tableRow_Selector, dateStr, lastKnownVegetables) => {
            const formatPrice = (price) => parseFloat(price.split(' ')[1]); // RS 30.29 to 30.29
            const rows = Array.from(document.querySelectorAll(tableRow_Selector));

            return rows.map((row) => {
                const cells = row.querySelectorAll('td');

                const currentDateVegetable = {
                    commodity: cells[0]?.innerText.trim(),
                    unit: cells[1]?.innerText.trim(),
                    minimum: formatPrice(cells[2]?.innerText.trim()),
                    maximum: formatPrice(cells[3]?.innerText.trim()),
                    average: formatPrice(cells[4]?.innerText.trim()),
                }

                const newVegetableData = {
                    ...currentDateVegetable,
                    fluctuationValue: 0,
                    fluctuationPercentage: 0,
                    hasSignificantFluctuation: false
                }

                // don't compare for the first day data since there are no previous date data available
                if (dateStr === '2025-01-01') {
                    return newVegetableData; // every vegetable is new for the first date
                }
                else {
                    const previousVegetableData = lastKnownVegetables[currentDateVegetable.commodity];

                    if (previousVegetableData) {
                        const previousPrice = previousVegetableData.average;
                        const currentPrice = currentDateVegetable.average;
                        const fluctuationValue = Math.round((currentPrice - previousPrice) * 100) / 100; // alternative to toFixed(2) because it returns string
                        const fluctuationPercentage = Math.round(((fluctuationValue / previousPrice) * 100) * 100) / 100;
                        const hasSignificantFluctuation = Math.abs(fluctuationPercentage) >= 15;

                        return {
                            ...currentDateVegetable,
                            fluctuationValue,
                            fluctuationPercentage,
                            hasSignificantFluctuation
                        }
                    } else {
                        return newVegetableData
                        // if the current commodity is not found in previousDateVegetables, it still needs to be added as a new vegetable
                        // so that it can be compared when it is encountered in next iterations
                    }
                }
            });
        }, tableRow_Selector, dateStr, Object.fromEntries(lastKnownVegetablesMap));

        console.log('Scraping completed!')

        // push the row data onto results array
        if (dataOfOneDay && dataOfOneDay.length > 0) {
            // remove unintented data type
            const dataOfOneDay_filtered = dataOfOneDay.filter(d => d !== null && d !== undefined);

            // make current vegetable data as previous vegetable data for next iteration's comparison
            for (const veg of dataOfOneDay_filtered) {
                lastKnownVegetablesMap.set(veg.commodity, veg);
            }

            const singleDate_Data = {
                date: dateStr,
                vegetablesData: dataOfOneDay_filtered
            }

            try {
                // const postedDocument = await collection.insertOne(singleDate_Data);
                // if (postedDocument) {
                //     console.log(`✅ Added document for ${dateStr}:`, postedDocument.insertedId);
                // }

                // safer way to add data as it avoids duplication 
                const postedDocument = await vegetablesCollection.updateOne(
                    { date: dateStr },
                    { $set: singleDate_Data },
                    { upsert: true }
                ) // find the doc with date and update it, if it doesn't exist create one

                if (postedDocument.acknowledged) {
                    console.log(`✅ Saved scraped data of selected date with id: ${postedDocument.upsertedId}\n`);

                    // get all vegetables of this particular date that has significant fluctuation
                    const vegetablesWithSignificantFluctuation = dataOfOneDay_filtered.filter(v => v.hasSignificantFluctuation);

                    if (vegetablesWithSignificantFluctuation.length > 0) {
                        // iterate through each user from the database
                        for (const user of users) {
                            const userSelectedVegetablesMatch = [];

                            // iterate through each fluctuated vegetable
                            for (const fluctuatedVegetable of vegetablesWithSignificantFluctuation) {
                                // check if the list of userSelectedVegetables at the time of registration includes the fluctuatedVegetable
                                const isUserSelectedVegetableFluctuated = user.selectedVegetablesForNotification.includes(fluctuatedVegetable.commodity);

                                if (isUserSelectedVegetableFluctuated) {
                                    userSelectedVegetablesMatch.push(fluctuatedVegetable);
                                }
                            }

                            // send email if only there has been fluctuation on vegetables that user has selected
                            if (userSelectedVegetablesMatch.length > 0) {
                                try {
                                    await sendFluctuationEmail(user.email, userSelectedVegetablesMatch, dateStr);
                                    console.log(`📧 Email sent to ${user.email}`);
                                } catch (error) {
                                    console.error(`❌ Failed to send email to ${user.email}: ${error.message}`);
                                }
                            }
                        }
                    }

                }
            } catch (error) {
                console.log(`❌ Couldn't add the scraped data of selected date!: ${error.message}\n`);
            }
        }

        // throttle to avoid overloading the server
        await new Promise((r) => setTimeout(r, 1000));
    }

    await browser.close();
    await client.close();

})();
