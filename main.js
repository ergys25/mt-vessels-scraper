// Main script that runs the vessel data scraper and stores data in PostgreSQL
require('dotenv').config();
const { scrapeVesselData } = require('./vessel-scraper');
const { Pool } = require('pg');

// Create PostgreSQL connection pool using environment variables from .env file
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Store the latest vessel data
let latestVesselData = null;
let isRunning = false;

/**
 * Run the scraper and update the latest data
 */
async function runScraper() {
  if (isRunning) {
    console.log('Scraper is already running, skipping this execution');
    return;
  }

  isRunning = true;

  try {
    console.log(`Starting vessel data scraper at ${new Date().toISOString()}`);

    const startTime = Date.now();
    const vesselData = await scrapeVesselData({
      // Uncomment to override .env credentials
      // username: 'your_username',
      // password: 'your_password',
      headless: true,  // Set to false for debugging
      timeout: 120000  // 2 minutes timeout
    });

    const duration = (Date.now() - startTime) / 1000;

    if (vesselData) {
      latestVesselData = vesselData;
      console.log(`Scraper completed successfully in ${duration.toFixed(1)} seconds`);

      // Extract and determine the structure of the data
      let vessels = [];
      if (vesselData.data && Array.isArray(vesselData.data)) {
        vessels = vesselData.data;
      } else if (vesselData.vessels && Array.isArray(vesselData.vessels)) {
        vessels = vesselData.vessels;
      } else if (Array.isArray(vesselData)) {
        vessels = vesselData;
      }

      console.log(`Retrieved data for ${vessels.length} vessels`);

      // Save the vessels data to PostgreSQL database
      await saveVesselsToDatabase(vessels);
    } else {
      console.log(`Scraper completed in ${duration.toFixed(1)} seconds but no data was retrieved`);
    }
  } catch (error) {
    console.error('Error running vessel data scraper:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Save vessel data to PostgreSQL database
 * @param {Array} vessels - Array of vessel objects
 */
async function saveVesselsToDatabase(vessels) {
  if (!vessels || vessels.length === 0) {
    console.log('No vessels to save to database');
    return;
  }

  const client = await pool.connect();
  let savedCount = 0;
  let errorCount = 0;

  try {
    // Start a transaction
    await client.query('BEGIN');

    // Process each vessel
    for (const vessel of vessels) {
      try {
        // Check if the vessel already exists in the database
        const checkResult = await client.query(
          'SELECT SHIP_ID FROM vessels_mt WHERE SHIP_ID = $1',
          [vessel.SHIP_ID]
        );

        // Convert special fields that need formatting
        let formattedVessel = formatVesselData(vessel);

        if (checkResult.rowCount > 0) {
          // Vessel exists, perform UPDATE
          await updateVessel(client, formattedVessel);
          console.log(`Updated vessel: ${vessel.SHIPNAME} (ID: ${vessel.SHIP_ID})`);
        } else {
          // Vessel doesn't exist, perform INSERT
          await insertVessel(client, formattedVessel);
          console.log(`Inserted new vessel: ${vessel.SHIPNAME} (ID: ${vessel.SHIP_ID})`);
        }

        savedCount++;
      } catch (error) {
        console.error(`Error saving vessel ${vessel.SHIP_ID}:`, error.message);
        errorCount++;
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    console.log(`Database update completed: ${savedCount} vessels saved, ${errorCount} errors`);
  } catch (error) {
    // Roll back the transaction on error
    await client.query('ROLLBACK');
    console.error('Transaction failed, changes rolled back:', error);
    throw error;
  } finally {
    // Release the client back to the pool
    client.release();
  }
}

/**
 * Format vessel data to match database schema
 * @param {Object} vessel - Vessel data object
 * @returns {Object} - Formatted vessel data
 */
function formatVesselData(vessel) {
  const formattedVessel = { ...vessel };

  // Handle null/undefined values
  Object.keys(formattedVessel).forEach(key => {
    if (formattedVessel[key] === null || formattedVessel[key] === undefined) {
      formattedVessel[key] = null;
    }
  });

  // Format timestamp fields
  if (formattedVessel.ETA_UPDATED && formattedVessel.ETA_UPDATED !== null) {
    try {
      // If it's a number, treat as Unix timestamp
      if (!isNaN(formattedVessel.ETA_UPDATED)) {
        const timestamp = parseInt(formattedVessel.ETA_UPDATED);
        formattedVessel.ETA_UPDATED = new Date(timestamp * 1000).toISOString();
      }
    } catch (e) {
      formattedVessel.ETA_UPDATED = null;
    }
  }

  // Format LAUNCH_DATE (if it exists)
  if (formattedVessel.LAUNCH_DATE && formattedVessel.LAUNCH_DATE !== null) {
    try {
      // Try to parse as date string first
      const date = new Date(formattedVessel.LAUNCH_DATE);
      if (!isNaN(date.getTime())) {
        formattedVessel.LAUNCH_DATE = date.toISOString().split('T')[0]; // YYYY-MM-DD
      } else {
        formattedVessel.LAUNCH_DATE = null;
      }
    } catch (e) {
      formattedVessel.LAUNCH_DATE = null;
    }
  }

  // Format FIRST_POS_TIMESTAMP (if it exists)
  if (formattedVessel.FIRST_POS_TIMESTAMP && formattedVessel.FIRST_POS_TIMESTAMP !== null) {
    try {
      // If it's a number, treat as Unix timestamp
      if (!isNaN(formattedVessel.FIRST_POS_TIMESTAMP)) {
        const timestamp = parseInt(formattedVessel.FIRST_POS_TIMESTAMP);
        formattedVessel.FIRST_POS_TIMESTAMP = new Date(timestamp * 1000).toISOString();
      }
    } catch (e) {
      formattedVessel.FIRST_POS_TIMESTAMP = null;
    }
  }

  // Convert numeric strings to numbers for numeric fields
  const numericFields = ['LAT', 'LON', 'SPEED', 'COURSE', 'DRAUGHT_MAX', 'DRAUGHT_MIN',
                         'LENGTH', 'WIDTH', 'LENGTH_B_W_PERPENDICULARS', 'LENGTH_REGISTERED',
                         'DEPTH', 'BREADTH_MOULDED', 'BREADTH_EXTREME'];

  numericFields.forEach(field => {
    if (formattedVessel[field] !== null && formattedVessel[field] !== undefined) {
      if (typeof formattedVessel[field] === 'string') {
        // Replace any commas with dots for decimal values
        formattedVessel[field] = formattedVessel[field].replace(',', '.');
        const numValue = parseFloat(formattedVessel[field]);
        if (!isNaN(numValue)) {
          formattedVessel[field] = numValue;
        }
      }
    }
  });

  return formattedVessel;
}

/**
 * Insert a new vessel into the database
 * @param {Object} client - PostgreSQL client
 * @param {Object} vessel - Vessel data
 */
async function insertVessel(client, vessel) {
  // Create the dynamic query based on available fields
  const fields = Object.keys(vessel).filter(key => vessel[key] !== undefined);
  const values = fields.map(field => vessel[field]);
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');

  const query = `
    INSERT INTO vessels_mt (${fields.join(', ')})
    VALUES (${placeholders})
  `;

  await client.query(query, values);
}

/**
 * Update an existing vessel in the database
 * @param {Object} client - PostgreSQL client
 * @param {Object} vessel - Vessel data
 */
async function updateVessel(client, vessel) {
  // Create the dynamic query based on available fields
  const fields = Object.keys(vessel)
    .filter(key => vessel[key] !== undefined && key !== 'SHIP_ID');

  if (fields.length === 0) {
    console.log(`No fields to update for vessel ${vessel.SHIP_ID}`);
    return;
  }

  const setClause = fields
    .map((field, i) => `${field} = $${i + 2}`)
    .join(', ');

  const values = [vessel.SHIP_ID, ...fields.map(field => vessel[field])];

  const query = `
    UPDATE vessels_mt
    SET ${setClause}
    WHERE SHIP_ID = $1
  `;

  await client.query(query, values);
}

// Test the database connection before starting
async function testDbConnection() {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to PostgreSQL database');

    // Check if vessels_mt table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'vessels_mt'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.error('Error: vessels_mt table does not exist in the database!');
      console.log('Please create the table using the provided schema before running this script.');
      process.exit(1);
    }

    client.release();
    return true;
  } catch (error) {
    console.error('Database connection error:', error.message);
    console.error('Please check your PostgreSQL connection environment variables:');
    console.error('DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT');
    console.error('Make sure these are properly defined in your .env file');
    process.exit(1);
  }
}

// Main execution
async function main() {
  // Test database connection before starting
  await testDbConnection();

  // Run immediately at startup
  await runScraper();

  // Then run every 3 minutes
  const INTERVAL_MS = 3 * 60 * 1000; // 3 minutes in milliseconds
  setInterval(runScraper, INTERVAL_MS);

  console.log(`Vessel data scraper scheduled to run every 3 minutes`);
}

// Start the main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});