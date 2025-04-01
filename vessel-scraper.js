// MarineTraffic vessel data scraper module
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

/**
 * Scrapes vessel data from MarineTraffic detailed reports
 * @param {Object} options - Configuration options
 * @param {string} options.username - MarineTraffic username
 * @param {string} options.password - MarineTraffic password
 * @param {boolean} options.headless - Run browser in headless mode (default: true)
 * @param {number} options.timeout - Global timeout in ms (default: 60000)
 * @returns {Promise<Object>} - JSON data of vessels
 */
async function scrapeVesselData(options = {}) {
  const {
    username = process.env.MT_USERNAME,
    password = process.env.MT_PASSWORD,
    headless = true,
    timeout = 60000
  } = options;

  if (!username || !password) {
    throw new Error('MarineTraffic username and password are required');
  }

  let browser = null;
  let vesselData = null;

  try {
    browser = await puppeteer.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();

    // Set realistic viewport and user agent
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Enable request interception to capture API responses
    await page.setRequestInterception(true);

    page.on('request', request => {
      request.continue();
    });

    page.on('response', async response => {
      const url = response.url();
      // Look for API endpoints that might contain vessel data
      if (url.includes('/api/exportAPI') ||
          url.includes('/en/reports') ||
          url.includes('/api/exportData') ||
          url.includes('/exportJSON') ||
          url.includes('/en/vesselDetails') ||
          url.includes('/en/ais/details') ||
          url.includes('/api/vd') ||
          url.includes('/api/exportVessels')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const data = await response.json();
            console.log('Captured vessel data API response from:', url);

            // Check if this response contains what looks like vessel data
            if (data &&
                ((data.data && Array.isArray(data.data) && data.data.length > 0) ||
                 (data.vessels && Array.isArray(data.vessels) && data.vessels.length > 0) ||
                 (Array.isArray(data) && data.length > 0 && (data[0].imo || data[0].IMO || data[0].mmsi || data[0].MMSI)))) {
              console.log('Found what appears to be vessel data!');
              vesselData = data;
            }
          }
        } catch (e) {
          console.log('Error parsing response from', url, e.message);
        }
      }
    });

    console.log('Navigating to MarineTraffic with stealth...');
    await page.goto('https://www.marinetraffic.com/en/users/login', {
      waitUntil: 'networkidle2',
      timeout
    });

    // Handle cookie consent if present (try multiple possible selectors)
    try {
      // Try specific cookie button format first
      const cookieButton = await page.waitForSelector('#qc-cmp2-ui > div.qc-cmp2-footer.qc-cmp2-footer-overlay.qc-cmp2-footer-scrolled > div > button.css-1yp8yiu', { timeout: 3000 }).catch(() => null);
      if (cookieButton) {
        await cookieButton.click();
        console.log('Clicked specific cookie consent button');
      } else {
        // Fallback to other cookie button formats
        const cookieButton1 = await page.waitForXPath('//*[@id="qc-cmp2-ui"]/div[2]/div/button[2]', { timeout: 3000 }).catch(() => null);
        if (cookieButton1) {
          await cookieButton1.click();
          console.log('Clicked XPath cookie consent button');
        } else {
          // Try generic CSS selector as last resort
          const cookieButton2 = await page.waitForSelector('button.css-1yp8yiu', { timeout: 3000 }).catch(() => null);
          if (cookieButton2) {
            await cookieButton2.click();
            console.log('Clicked CSS cookie consent button');
          } else {
            // Try any button that might be related to cookies or acceptance
            const anyAcceptButton = await page.$$eval('button', buttons => {
              const acceptButton = buttons.find(button =>
                button.textContent.toLowerCase().includes('accept') ||
                button.textContent.toLowerCase().includes('agree') ||
                button.textContent.toLowerCase().includes('consent')
              );
              if (acceptButton) {
                acceptButton.click();
                return true;
              }
              return false;
            }).catch(() => false);

            if (anyAcceptButton) {
              console.log('Clicked generic accept/agree button');
            } else {
              console.log('No cookie consent button found, continuing...');
            }
          }
        }
      }
    } catch (error) {
      console.log('No cookie consent button found or error handling cookies:', error.message);
    }

    console.log('Logging in...');
    await page.waitForSelector('#email', { timeout: 10000 });
    await page.type('#email', username);
    await page.type('#password', password);
    await page.click('#login_form_submit');
    console.log('Login submitted');

    // Wait for login to complete
    console.log('Waiting for login to complete...');
    // Wait for navigation or for a selector that indicates successful login
    await Promise.race([
      page.waitForNavigation({ timeout: 30000 }),
      page.waitForSelector('.user-menu-item', { timeout: 30000 })
    ]);
    console.log('Login successful');

    // Navigate to vessels page
    console.log('Navigating to vessels page...');
    await page.goto('https://www.marinetraffic.com/en/data/?asset_type=vessels', {
      waitUntil: 'networkidle2',
      timeout
    });

    // Wait for vessels page to load properly
    console.log('Waiting for vessels to load...');

    // Try a more general selector - the original seems to be failing
    try {
      await page.waitForSelector('#mainSection', { timeout: 30000 });
      console.log('Main section loaded');
    } catch (error) {
      console.log('Could not find main section, continuing anyway:', error.message);
    }

    // Navigate to the specific detailed reports page with all parameters
    console.log('Navigating to detailed vessels reports page with all parameters...');
    const detailedReportsUrl = 'https://www.marinetraffic.com/en/reports/?asset_type=vessels&columns=flag,shipname,imo,mmsi,ship_type,time_of_latest_position:desc,area,area_local,lat_of_latest_position,lon_of_latest_position,status,eni,speed,course,draught_max,draught_min,specific_ship_type,year_of_build,commercial_manager,commercial_manager_email,commercial_manager_city,commercial_manager_country,registered_owner,registered_owner_email,registered_owner_city,registered_owner_country,beneficial_owner,beneficial_owner_email,beneficial_owner_city,beneficial_owner_country,technical_manager,technical_manager_email,technical_manager_city,technical_manager_country,p_i_club,p_i_club_email,p_i_club_city,p_i_club_country,ship_builder,ship_builder_email,ship_builder_city,ship_builder_country,class_society,class_society_email,class_society_city,class_society_country,engine_builder,engine_builder_email,engine_builder_city,engine_builder_country,ism_manager,ism_manager_email,ism_manager_city,ism_manager_country,operator,operator_email,operator_city,operator_country,length,width,gross_tonnage,dwt,teu,liquid_gas_capacity,pax,launch_date,length_between_perpendiculars,length_registered,depth,breadth_moulded,breadth_extreme,liquid_oil_capacity,callsign,market,vessel_class,first_ais_pos_date&ship_type_in=8';

    await page.goto(detailedReportsUrl, {
      waitUntil: 'networkidle2',
      timeout: 90000 // Longer timeout for this complex page
    });

    // After navigation, wait a bit for any XHR requests to complete
    console.log('Waiting for data to load...');
    // Using setTimeout with a promise instead of waitForTimeout
    await new Promise(resolve => setTimeout(resolve, 5000));

    // The critical part - don't wait for a specific table selector that might not exist
    // Instead, check if we've already captured data via network requests
    if (!vesselData) {
      console.log('Attempting to find vessel data on the page...');

      // Try to find any table element that might contain our data
      try {
        // Try different table selectors
        const tableSelectors = [
          'table.MuiTable-root',
          'table',
          '.data-table',
          '.grid-table',
          '[role="grid"]',
          '.ag-root-wrapper'
        ];

        for (const selector of tableSelectors) {
          const element = await page.$(selector).catch(() => null);
          if (element) {
            console.log(`Found table element with selector: ${selector}`);

            // Try to extract data from this table
            const tableData = await page.evaluate((selector) => {
              const table = document.querySelector(selector);
              if (!table) return null;

              // Check if it's a regular HTML table
              const rows = Array.from(table.querySelectorAll('tr, [role="row"]'));
              if (rows.length === 0) return null;

              // Try to get headers
              let headers = [];
              const headerRow = rows[0];
              const headerCells = headerRow.querySelectorAll('th, [role="columnheader"], td');
              if (headerCells.length > 0) {
                headers = Array.from(headerCells).map(cell => cell.textContent.trim());
              } else {
                // If no headers, make generic ones
                const firstRow = rows[0];
                const cellCount = firstRow.querySelectorAll('td, [role="gridcell"]').length;
                headers = Array.from({ length: cellCount }, (_, i) => `Column${i}`);
              }

              // Get data rows (skip header row)
              const dataRows = rows.slice(1);
              const data = dataRows.map(row => {
                const cells = row.querySelectorAll('td, [role="gridcell"]');
                if (cells.length === 0) return null;

                const rowData = {};
                headers.forEach((header, index) => {
                  if (cells[index]) {
                    rowData[header] = cells[index].textContent.trim();
                  }
                });

                return rowData;
              }).filter(Boolean); // Remove any null entries

              return data.length > 0 ? { data } : null;
            }, selector);

            if (tableData && tableData.data && tableData.data.length > 0) {
              console.log(`Extracted ${tableData.data.length} rows from table`);
              vesselData = tableData;
              break;
            }
          }
        }
      } catch (error) {
        console.log('Error extracting from tables:', error.message);
      }
    }

    // If we still don't have data, try to get it from JavaScript variables
    if (!vesselData) {
      try {
        console.log('Trying to extract data from JavaScript variables...');
        const jsData = await page.evaluate(() => {
          // Common patterns for where data might be stored
          if (window.vesselData) return { source: 'window.vesselData', data: window.vesselData };
          if (window.gridData) return { source: 'window.gridData', data: window.gridData };
          if (window.tableData) return { source: 'window.tableData', data: window.tableData };
          if (window.reportData) return { source: 'window.reportData', data: window.reportData };

          // Look for data in React's __INITIAL_DATA__ or similar
          for (const key in window) {
            if (window[key] && typeof window[key] === 'object') {
              // Check for data arrays
              if (Array.isArray(window[key])) {
                const sample = window[key][0];
                if (sample && (sample.imo || sample.IMO || sample.mmsi || sample.MMSI)) {
                  return { source: `window.${key}`, data: { data: window[key] } };
                }
              }

              // Check for nested data properties
              if (window[key].data && Array.isArray(window[key].data)) {
                const sample = window[key].data[0];
                if (sample && (sample.imo || sample.IMO || sample.mmsi || sample.MMSI)) {
                  return { source: `window.${key}.data`, data: window[key] };
                }
              }

              // Check other common property names
              for (const prop of ['vessels', 'ships', 'tankers', 'results']) {
                if (window[key][prop] && Array.isArray(window[key][prop])) {
                  const sample = window[key][prop][0];
                  if (sample && (sample.imo || sample.IMO || sample.mmsi || sample.MMSI)) {
                    return { source: `window.${key}.${prop}`, data: { data: window[key][prop] } };
                  }
                }
              }
            }
          }

          return null;
        });

        if (jsData) {
          console.log(`Found data in JavaScript variable: ${jsData.source}`);
          vesselData = jsData.data;
        }
      } catch (error) {
        console.log('Error extracting from JavaScript variables:', error.message);
      }
    }

    // As a fallback, use the raw HTML of the page to look for JSON data
    if (!vesselData) {
      try {
        console.log('Searching page HTML for JSON data...');
        const htmlData = await page.evaluate(() => {
          const html = document.documentElement.outerHTML;

          // Look for data arrays in JSON format
          const patterns = [
            /"data"\s*:\s*\[\s*\{\s*"([^"]+)"\s*:/,
            /"vessels"\s*:\s*\[\s*\{\s*"([^"]+)"\s*:/,
            /"ships"\s*:\s*\[\s*\{\s*"([^"]+)"\s*:/,
            /"tankers"\s*:\s*\[\s*\{\s*"([^"]+)"\s*:/
          ];

          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
              // Try to extract the full JSON object
              let bracketCount = 0;
              let startPos = html.indexOf(match[0]);
              let endPos = startPos;

              // Find the containing object by matching brackets
              for (let i = startPos; i < html.length; i++) {
                if (html[i] === '{') bracketCount++;
                if (html[i] === '}') bracketCount--;

                if (bracketCount === 0 && i > startPos) {
                  endPos = i + 1;
                  break;
                }
              }

              if (endPos > startPos) {
                try {
                  // Extract the full object
                  const jsonStr = html.substring(startPos - 1, endPos);
                  const data = JSON.parse(jsonStr);
                  if (data && (data.data || data.vessels || data.ships || data.tankers)) {
                    return { source: 'html-json', data };
                  }
                } catch (e) {
                  // Continue with next pattern if parsing fails
                }
              }
            }
          }

          return null;
        });

        if (htmlData) {
          console.log(`Found JSON data in HTML: ${htmlData.source}`);
          vesselData = htmlData.data;
        }
      } catch (error) {
        console.log('Error extracting JSON from HTML:', error.message);
      }
    }

    // If we still don't have data, return whatever response we got
    if (!vesselData) {
      console.log('Could not extract specific vessel data, using most recent API response');
      // This will use the last API response we captured, even if it wasn't what we were looking for
    }

  } catch (error) {
    console.error('Scraper error:', error);

    // Propagate the error
    throw error;
  } finally {
    // Always close the browser when done
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
  }

  return vesselData;
}

module.exports = { scrapeVesselData };