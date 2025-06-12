require('dotenv').config();
const { MongoClient } = require('mongodb');
const puppeteer = require('puppeteer');

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
    const collection = db.collection('daily_prices');
    await collection.createIndex({ date: 1 }, { unique: true });

    // get the data of latest saved date 
    const latestDoc = await collection
        .find({})
        .sort({ date: -1 })
        .limit(1)
        .toArray();

    let startDate = new Date('2025-01-01');

    // this will be used to store the previousDate data and referenced later to compare prices with current date data
    let previousDateVegetables = [];

    // modify startDate and previousDateVegetables accordingly if database is not empty
    if (latestDoc.length > 0) {
        const lastDate = new Date(latestDoc[0].date);
        lastDate.setDate(lastDate.getDate() + 1); // lastDate.setDate returns number
        startDate = lastDate; //lastDate is modified object from above line
        previousDateVegetables = [...latestDoc[0].vegetablesData];
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

        // when there is no data available in the site for that particular date, the site still shows table but with a single row that says 'No data available in the table'
        if (rowCount <= 1) {
            console.warn('⚠️  Table has no data!\n');
            continue;
        }

        console.log('Scraping data from the data table...');

        // extract data of that particular date
        const dataOfOneDay = await page.evaluate((tableRow_Selector, dateStr, previousDateVegetables) => {
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

                // don't compare for the first day data since there are no previous date data available
                if (dateStr === '2025-01-01') {
                    return {
                        ...currentDateVegetable,
                        fluctuationValue: 0,
                        fluctuationPercentage: 0,
                        hasSignificantFluctuation: false
                    }
                }
                else {
                    const previousVegetableData = previousDateVegetables.find(previousVegetableData => (
                        previousVegetableData.commodity === currentDateVegetable.commodity
                    ))
                    if (previousVegetableData) {
                        const previousPrice = previousVegetableData.average;
                        const currentPrice = currentDateVegetable.average;
                        const fluctuationValue = (currentPrice - previousPrice).toFixed(2);
                        const fluctuationPercentage = ((fluctuationValue / previousPrice) * 100).toFixed(2);
                        const hasSignificantFluctuation = Math.abs(fluctuationPercentage) >= 15;

                        return {
                            ...currentDateVegetable,
                            fluctuationValue,
                            fluctuationPercentage,
                            hasSignificantFluctuation
                        }
                    }

                }
            });
        }, tableRow_Selector, dateStr, previousDateVegetables);

        console.log('Scraping completed!')

        // push the row data onto results array
        if (dataOfOneDay && dataOfOneDay.length > 0) {
            // remove unintented data type
            const dataOfOneDay_filtered = dataOfOneDay.filter(d => d !== null && d !== undefined);

            // make current vegetable data as previous vegetable data for next iteration's comparison
            previousDateVegetables = [...dataOfOneDay_filtered];

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
                const postedDocument = await collection.updateOne(
                    { date: dateStr },
                    { $set: singleDate_Data },
                    { upsert: true }
                ) // find the doc with date and update it, if it doesn't exist create one

                if (postedDocument.acknowledged) {
                    console.log(`✅ Saved scraped data of selected date with id: ${postedDocument.upsertedId}\n`);
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
